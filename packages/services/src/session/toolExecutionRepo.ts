// PlayableBench 工具执行持久化（spec 05 §6：先持久化 intent/幂等键，再调用外部
// 副作用；崩溃恢复时扫描未完成调用，结果不可查则进 needs_reconciliation）。
// 与 RunRepo/ApprovalRepo 共享同一 tasks-index 连接。
import { randomUUID } from "node:crypto";
import type { PbSideEffectState, PbToolExecution, PbToolExecutionStatus } from "@zcode/shared";
import { rowToToolExecution } from "#src/session/runStoreRows.js";
import type { ToolExecutionRow } from "#src/session/runStoreRows.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

/** 未完成工具执行（崩溃恢复扫描用）。 */
export interface UnfinishedToolExecution {
  execution: PbToolExecution;
}

export class ToolExecutionRepo {
  constructor(private readonly connection: RunStoreConnection) {}

  private getDatabase() {
    return this.connection.getDatabase();
  }

  private findByIdempotencyKeySync(key: string): PbToolExecution | null {
    const row = this.getDatabase()
      .prepare(`SELECT * FROM pb_tool_executions WHERE idempotency_key = ? LIMIT 1`)
      .get(key) as ToolExecutionRow | undefined;
    return row ? rowToToolExecution(row) : null;
  }

  async create(input: {
    runId: string;
    toolId: string;
    toolVersion?: string;
    riskLevel?: string;
    inputDigest?: string;
    idempotencyKey?: string;
  }): Promise<PbToolExecution> {
    await this.connection.ensureReady();
    const db = this.getDatabase();
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKeySync(input.idempotencyKey);
      if (existing) return existing;
    }
    const now = Date.now();
    const id = `tx-${randomUUID()}`;
    db.prepare(
      `INSERT INTO pb_tool_executions (
        id, run_id, tool_id, tool_version, risk_level, input_digest, idempotency_key,
        status, attempt, side_effect_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, 'not_started', ?, ?)`,
    ).run(
      id,
      input.runId,
      input.toolId,
      input.toolVersion ?? null,
      input.riskLevel ?? null,
      input.inputDigest ?? null,
      input.idempotencyKey ?? null,
      now,
      now,
    );
    const created = db
      .prepare(`SELECT * FROM pb_tool_executions WHERE id = ?`)
      .get(id) as unknown as ToolExecutionRow;
    return rowToToolExecution(created);
  }

  async findByIdempotencyKey(key: string): Promise<PbToolExecution | null> {
    await this.connection.ensureReady();
    return this.findByIdempotencyKeySync(key);
  }

  async update(
    id: string,
    patch: {
      status?: PbToolExecutionStatus;
      sideEffectState?: PbSideEffectState;
      resultSummary?: string;
      errorSummary?: string;
      attempt?: number;
    },
  ): Promise<PbToolExecution | null> {
    await this.connection.ensureReady();
    const db = this.getDatabase();
    const updates: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.status !== undefined) {
      updates.push("status = ?");
      values.push(patch.status);
    }
    if (patch.sideEffectState !== undefined) {
      updates.push("side_effect_state = ?");
      values.push(patch.sideEffectState);
    }
    if (patch.resultSummary !== undefined) {
      updates.push("result_summary = ?");
      values.push(patch.resultSummary);
    }
    if (patch.errorSummary !== undefined) {
      updates.push("error_summary = ?");
      values.push(patch.errorSummary);
    }
    if (patch.attempt !== undefined) {
      updates.push("attempt = ?");
      values.push(patch.attempt);
    }
    if (updates.length === 0) return this.get(id);
    updates.push("updated_at = ?");
    values.push(Date.now(), id);
    db.prepare(`UPDATE pb_tool_executions SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  async get(id: string): Promise<PbToolExecution | null> {
    await this.connection.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM pb_tool_executions WHERE id = ?`)
      .get(id) as ToolExecutionRow | undefined;
    return row ? rowToToolExecution(row) : null;
  }

  async list(runId: string, params?: { limit?: number }): Promise<PbToolExecution[]> {
    await this.connection.ensureReady();
    const limit = Math.max(1, Math.min(params?.limit ?? 200, 1000));
    const rows = this.getDatabase()
      .prepare(`SELECT * FROM pb_tool_executions WHERE run_id = ? ORDER BY created_at ASC LIMIT ?`)
      .all(runId, limit) as unknown as ToolExecutionRow[];
    return rows.map(rowToToolExecution);
  }

  /** 崩溃恢复扫描（spec 05 §6）：未完成且副作用状态未确定的工具调用。 */
  async listUnfinished(runId: string): Promise<UnfinishedToolExecution[]> {
    await this.connection.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM pb_tool_executions
         WHERE run_id = ? AND status IN ('pending','running') AND side_effect_state != 'confirmed'
         ORDER BY created_at ASC`,
      )
      .all(runId) as unknown as ToolExecutionRow[];
    return rows.map((row) => ({ execution: rowToToolExecution(row) }));
  }
}
