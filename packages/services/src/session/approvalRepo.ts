// PlayableBench 审批持久化（spec 05 §3/§4、spec 06 §2）：操作摘要 digest 绑定、
// 截止时间、单向决策收敛与到期扫描。与 RunRepo/ToolExecutionRepo 共享同一连接。
import { randomUUID } from "node:crypto";
import type { PbApproval, PbApprovalDecision } from "@zcode/shared";
import { rowToApproval } from "#src/session/runStoreRows.js";
import type { ApprovalRow } from "#src/session/runStoreRows.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

export class ApprovalRepo {
  constructor(private readonly connection: RunStoreConnection) {}

  private getDatabase() {
    return this.connection.getDatabase();
  }

  async create(input: {
    runId: string;
    toolExecutionId?: string;
    interactionId?: string;
    operationDigest: string;
    requestJson: string;
    riskLevel?: string;
    riskSummary?: string;
    expiresAt?: number;
  }): Promise<PbApproval> {
    await this.connection.ensureReady();
    const now = Date.now();
    const id = `ap-${randomUUID()}`;
    this.getDatabase()
      .prepare(
        `INSERT INTO pb_approvals (
          id, run_id, tool_execution_id, interaction_id, operation_digest, request_json,
          risk_level, risk_summary, expires_at, decision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.toolExecutionId ?? null,
        input.interactionId ?? null,
        input.operationDigest,
        input.requestJson,
        input.riskLevel ?? null,
        input.riskSummary ?? null,
        input.expiresAt ?? null,
        now,
        now,
      );
    const created = this.getDatabase()
      .prepare(`SELECT * FROM pb_approvals WHERE id = ?`)
      .get(id) as unknown as ApprovalRow;
    return rowToApproval(created);
  }

  async get(id: string): Promise<PbApproval | null> {
    await this.connection.ensureReady();
    const row = this.getDatabase().prepare(`SELECT * FROM pb_approvals WHERE id = ?`).get(id) as
      | ApprovalRow
      | undefined;
    return row ? rowToApproval(row) : null;
  }

  async findByInteractionId(interactionId: string): Promise<PbApproval | null> {
    await this.connection.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM pb_approvals WHERE interaction_id = ? LIMIT 1`)
      .get(interactionId) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  async list(
    runId: string,
    params?: { decision?: PbApprovalDecision; limit?: number },
  ): Promise<PbApproval[]> {
    await this.connection.ensureReady();
    const limit = Math.max(1, Math.min(params?.limit ?? 200, 1000));
    const rows = params?.decision
      ? (this.getDatabase()
          .prepare(`SELECT * FROM pb_approvals WHERE run_id = ? AND decision = ? ORDER BY created_at DESC LIMIT ?`)
          .all(runId, params.decision, limit) as unknown as ApprovalRow[])
      : (this.getDatabase()
          .prepare(`SELECT * FROM pb_approvals WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`)
          .all(runId, limit) as unknown as ApprovalRow[]);
    return rows.map(rowToApproval);
  }

  /** 决策单向收敛：仅 pending 可被决定，已决策记录不可改写。 */
  async decide(
    id: string,
    decision: Exclude<PbApprovalDecision, "pending">,
    options?: { decidedBy?: string; decidedAt?: number; revokeReason?: string },
  ): Promise<PbApproval | null> {
    await this.connection.ensureReady();
    const now = options?.decidedAt ?? Date.now();
    this.getDatabase()
      .prepare(
        `UPDATE pb_approvals
         SET decision = ?, decided_by = ?, decided_at = ?, revoke_reason = ?, updated_at = ?
         WHERE id = ? AND decision = 'pending'`,
      )
      .run(decision, options?.decidedBy ?? null, now, options?.revokeReason ?? null, Date.now(), id);
    return this.get(id);
  }

  /** 过期扫描：pending 且已过截止时间的审批标记 expired（spec 05 §9 审批过期）。 */
  async expireDue(nowMs: number = Date.now()): Promise<PbApproval[]> {
    await this.connection.ensureReady();
    const db = this.getDatabase();
    // 先选后改：避免用 updated_at 反查在同一毫秒误捞非本次过期的行。
    const dueRows = db
      .prepare(
        `SELECT id FROM pb_approvals
         WHERE decision = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`,
      )
      .all(nowMs) as Array<{ id: string }>;
    const expired: PbApproval[] = [];
    const update = db.prepare(
      `UPDATE pb_approvals SET decision = 'expired', revoke_reason = 'expired', updated_at = ?
       WHERE id = ? AND decision = 'pending'`,
    );
    for (const { id } of dueRows) {
      update.run(Date.now(), id);
      const row = db.prepare(`SELECT * FROM pb_approvals WHERE id = ?`).get(id) as
        | ApprovalRow
        | undefined;
      if (row) expired.push(rowToApproval(row));
    }
    return expired;
  }
}
