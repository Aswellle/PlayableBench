// 远程命令幂等账本（spec 09 §6）：request_id 全局唯一主键；重复提交按已存
// 行返回先前结果（reused=true）不再次执行；过期请求拒绝。副作用安全的基础。
import type { RemoteCommandLedgerEntry } from "@zcode/shared";
import type { RunStoreConnection } from "#src/session/runStoreConnection.js";

interface LedgerRow {
  request_id: string;
  device_id: string;
  session_id: string | null;
  command_type: string;
  payload_digest: string;
  status: string;
  result_ref: string | null;
  result_json: string | null;
  expires_at: number | null;
  received_at: number;
  settled_at: number | null;
}

function rowToEntry(row: LedgerRow): RemoteCommandLedgerEntry {
  return {
    requestId: row.request_id,
    deviceId: row.device_id,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    commandType: row.command_type,
    payloadDigest: row.payload_digest,
    status: row.status as RemoteCommandLedgerEntry["status"],
    ...(row.result_json !== null ? { resultJson: row.result_json } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    receivedAt: row.received_at,
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
  };
}

export interface BeginCommandInput {
  requestId: string;
  deviceId: string;
  sessionId?: string;
  commandType: string;
  payloadDigest: string;
  expiresAt?: number;
}

export class RemoteCommandLedgerRepo {
  constructor(private readonly connection: RunStoreConnection) {}

  async ensureReady(): Promise<void> {
    await this.connection.ensureReady();
  }

  /**
   * 命令准入：INSERT OR IGNORE 后回读。reused=true 表示重复 requestId——
   * 调用方必须返回 entry.resultJson（先前结果），不得再次执行（spec 09 §6）。
   */
  async begin(
    input: BeginCommandInput,
  ): Promise<{ entry: RemoteCommandLedgerEntry; reused: boolean }> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO pb_remote_command_ledger
         (request_id, device_id, session_id, command_type, payload_digest, status, expires_at, received_at)
       VALUES (?, ?, ?, ?, ?, 'received', ?, ?)`,
    ).run(
      input.requestId,
      input.deviceId,
      input.sessionId ?? null,
      input.commandType,
      input.payloadDigest,
      input.expiresAt ?? null,
      now,
    );
    const row = db
      .prepare(`SELECT * FROM pb_remote_command_ledger WHERE request_id = ?`)
      .get(input.requestId) as unknown as LedgerRow;
    return { entry: rowToEntry(row), reused: row.received_at !== now || row.settled_at !== null };
  }

  /** 命令完成结算（只对未结算的 received 行生效，单次）。 */
  async settle(
    requestId: string,
    input: { resultJson?: string; resultRef?: string },
  ): Promise<RemoteCommandLedgerEntry | null> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const now = Date.now();
    db.prepare(
      `UPDATE pb_remote_command_ledger
       SET status = 'settled', result_json = COALESCE(?, result_json),
           result_ref = COALESCE(?, result_ref), settled_at = ?
       WHERE request_id = ? AND status = 'received'`,
    ).run(input.resultJson ?? null, input.resultRef ?? null, now, requestId);
    return this.get(requestId);
  }

  async get(requestId: string): Promise<RemoteCommandLedgerEntry | null> {
    await this.ensureReady();
    const row = this.connection
      .getDatabase()
      .prepare(`SELECT * FROM pb_remote_command_ledger WHERE request_id = ?`)
      .get(requestId) as unknown as LedgerRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** 过期收敛：received 且 expires_at 已过 → expired（过期后不再准入执行）。 */
  async expireDue(nowMs: number = Date.now()): Promise<number> {
    await this.ensureReady();
    const result = this.connection
      .getDatabase()
      .prepare(
        `UPDATE pb_remote_command_ledger SET status = 'expired', settled_at = ?
         WHERE status = 'received' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(nowMs, nowMs);
    return Number(result.changes ?? 0);
  }
}
