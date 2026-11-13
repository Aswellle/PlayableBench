// PlayableBench Run 持久化仓库（spec 05 §3、spec 06 §2/§3）。
// 状态转换由本层做合法性校验后落库（Host 端权威），事件以 (run_id, event_id)
// 去重吸收 V4 快照/增量重放；重复投递不产生重复副作用（spec 16 Phase 3 门禁）。
// 工具执行与审批拆分至 toolExecutionRepo.ts / approvalRepo.ts，三者共享连接。
import { randomUUID } from "node:crypto";
import type { CreateRunInput, PbRun, PbRunEvent, PbRunStatus } from "@zcode/shared";
import { isRunTransitionLegal, PB_RUN_TERMINAL_STATUSES } from "@zcode/shared";
import { rowToEvent, rowToRun } from "#src/session/runStoreRows.js";
import type {
  RunEventRow,
  RunTransitionDisposition,
  RunTransitionInput,
  RunTransitionResult,
  RunRow,
} from "#src/session/runStoreRows.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

export {
  rowToEvent,
  rowToRun,
} from "#src/session/runStoreRows.js";
export type {
  RunEventRow,
  RunRow,
  RunTransitionDisposition,
  RunTransitionInput,
  RunTransitionResult,
} from "#src/session/runStoreRows.js";

export class RunRepo {
  constructor(private readonly connection: RunStoreConnection) {}

  private getDatabase() {
    return this.connection.getDatabase();
  }

  private nextRunEventSequence(runId: string): number {
    const row = this.getDatabase()
      .prepare(`SELECT COALESCE(MAX(sequence), 0) AS next FROM pb_run_events WHERE run_id = ?`)
      .get(runId) as { next: number };
    return row.next + 1;
  }

  /** 建档：初始状态 queued；SR-02 约束 permissionMode 由调用方显式给出。 */
  async createRun(input: CreateRunInput): Promise<PbRun> {
    await this.connection.ensureReady();
    const now = Date.now();
    const id = `run-${randomUUID()}`;
    this.getDatabase()
      .prepare(
        `INSERT INTO pb_runs (
          id, template_id, template_version, status, goal, input_ref,
          runtime_session_id, workspace_key, workspace_path, permission_mode,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.templateId ?? null,
        input.templateVersion ?? null,
        input.goal,
        input.inputRef ?? null,
        input.runtimeSessionId ?? null,
        input.workspaceKey ?? null,
        input.workspacePath ?? null,
        input.permissionMode ?? null,
        now,
        now,
      );
    const run = await this.getRun(id);
    if (!run) {
      throw new Error(`run create 写入后缺少记录: ${id}`);
    }
    return run;
  }

  async getRun(id: string): Promise<PbRun | null> {
    await this.connection.ensureReady();
    const row = this.getDatabase().prepare(`SELECT * FROM pb_runs WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
    return row ? rowToRun(row) : null;
  }

  async getRunBySessionId(runtimeSessionId: string): Promise<PbRun | null> {
    await this.connection.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM pb_runs WHERE runtime_session_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(runtimeSessionId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async listRuns(params?: {
    workspaceKey?: string;
    status?: PbRunStatus;
    limit?: number;
  }): Promise<PbRun[]> {
    await this.connection.ensureReady();
    const limit = Math.max(1, Math.min(params?.limit ?? 100, 500));
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (params?.workspaceKey) {
      conditions.push("workspace_key = ?");
      values.push(params.workspaceKey);
    }
    if (params?.status) {
      conditions.push("status = ?");
      values.push(params.status);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.getDatabase()
      .prepare(`SELECT * FROM pb_runs${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...values, limit) as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  async setRuntimeSession(id: string, runtimeSessionId: string): Promise<PbRun | null> {
    await this.connection.ensureReady();
    this.getDatabase()
      .prepare(`UPDATE pb_runs SET runtime_session_id = ?, updated_at = ? WHERE id = ?`)
      .run(runtimeSessionId, Date.now(), id);
    return this.getRun(id);
  }

  async heartbeat(id: string, atMs: number = Date.now()): Promise<PbRun | null> {
    await this.connection.ensureReady();
    this.getDatabase()
      .prepare(`UPDATE pb_runs SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?`)
      .run(atMs, Date.now(), id);
    return this.getRun(id);
  }

  /**
   * 状态转换（spec 05 §3）：合法性由 isRunTransitionLegal 校验；重复 eventId 直接
   * 去重不重复应用；from 与当前状态不一致按 stale 处理（乱序观测不落库）。
   * 违反迁移表视为契约错误抛出，不静默。
   */
  async transitionRun(runId: string, transition: RunTransitionInput): Promise<RunTransitionResult> {
    await this.connection.ensureReady();
    const db = this.getDatabase();
    const now = transition.occurredAt ?? Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare(`SELECT * FROM pb_runs WHERE id = ?`).get(runId) as RunRow | undefined;
      if (!row) {
        throw new Error(`run 不存在: ${runId}`);
      }
      const existingEvent = db
        .prepare(`SELECT 1 FROM pb_run_events WHERE run_id = ? AND event_id = ?`)
        .get(runId, transition.eventId);
      if (existingEvent) {
        db.exec("COMMIT");
        return { run: rowToRun(row), disposition: "deduplicated" };
      }
      const current = row.status as PbRunStatus;
      if (current !== transition.from) {
        db.exec("COMMIT");
        return { run: rowToRun(row), disposition: "stale" };
      }
      if (!isRunTransitionLegal(current, transition.to)) {
        throw Object.assign(
          new Error(`非法 run 状态迁移: ${runId} ${current} → ${transition.to}`),
          { kind: "illegal_run_transition", runId, from: current, to: transition.to },
        );
      }
      const sequence = this.nextRunEventSequence(runId);
      const eventType = transition.eventType ?? `run.status.${transition.to}`;
      db.prepare(
        `INSERT INTO pb_run_events
          (run_id, sequence, event_id, event_type, occurred_at, payload_json, schema_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(
        runId,
        sequence,
        transition.eventId,
        eventType,
        now,
        transition.payloadJson ?? null,
        Date.now(),
      );
      const terminal = (PB_RUN_TERMINAL_STATUSES as readonly string[]).includes(transition.to);
      db.prepare(
        `UPDATE pb_runs SET
           status = ?,
           started_at = CASE WHEN started_at IS NULL AND ? IN ('planning','running') THEN ? ELSE started_at END,
           finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
           error_code = CASE WHEN ? = 'failed' THEN COALESCE(?, 'run_failed') ELSE error_code END,
           updated_at = ?
         WHERE id = ?`,
      ).run(
        transition.to,
        transition.to,
        now,
        terminal ? 1 : 0,
        terminal ? now : null,
        transition.to,
        transition.to === "failed" ? (transition.reason ?? null) : null,
        Date.now(),
        runId,
      );
      const event: PbRunEvent = {
        runId,
        sequence,
        eventId: transition.eventId,
        eventType,
        occurredAt: now,
        payloadJson: transition.payloadJson,
        schemaVersion: 1,
      };
      const updated = db.prepare(`SELECT * FROM pb_runs WHERE id = ?`).get(runId) as unknown as RunRow;
      db.exec("COMMIT");
      return { run: rowToRun(updated), disposition: "applied", event };
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* 回滚失败不覆盖原始异常。 */
      }
      throw error;
    }
  }

  /** 非状态类事件（如工具进度、快照对账标记）追加；同样按 event_id 去重。 */
  async appendRunEvent(
    runId: string,
    event: { eventId: string; eventType: string; occurredAt?: number; payloadJson?: string },
  ): Promise<{ event: PbRunEvent; deduplicated: boolean }> {
    await this.connection.ensureReady();
    const db = this.getDatabase();
    const now = event.occurredAt ?? Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare(`SELECT * FROM pb_run_events WHERE run_id = ? AND event_id = ?`)
        .get(runId, event.eventId) as RunEventRow | undefined;
      if (existing) {
        db.exec("COMMIT");
        return { event: rowToEvent(existing), deduplicated: true };
      }
      const sequence = this.nextRunEventSequence(runId);
      db.prepare(
        `INSERT INTO pb_run_events
          (run_id, sequence, event_id, event_type, occurred_at, payload_json, schema_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(runId, sequence, event.eventId, event.eventType, now, event.payloadJson ?? null, Date.now());
      const inserted = db
        .prepare(`SELECT * FROM pb_run_events WHERE run_id = ? AND event_id = ?`)
        .get(runId, event.eventId) as unknown as RunEventRow;
      db.exec("COMMIT");
      return { event: rowToEvent(inserted), deduplicated: false };
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* 回滚失败不覆盖原始异常。 */
      }
      throw error;
    }
  }

  async listRunEvents(runId: string, params?: { fromSequence?: number; limit?: number }): Promise<PbRunEvent[]> {
    await this.connection.ensureReady();
    const limit = Math.max(1, Math.min(params?.limit ?? 200, 1000));
    const from = params?.fromSequence ?? 0;
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM pb_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
      )
      .all(runId, from, limit) as unknown as RunEventRow[];
    return rows.map(rowToEvent);
  }
}
