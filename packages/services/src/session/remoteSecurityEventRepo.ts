// 远程控制安全事件记录（spec 09 §8）：绑定/撤销/认证失败/命令拒绝/审批/
// 会话结束。detail 只允许摘要（不含 token/原始授权链接/完整敏感输入）。
import { randomUUID } from "node:crypto";
import type { RemoteSecurityEvent, RemoteSecurityEventKind } from "@zcode/shared";
import type { RunStoreConnection } from "#src/session/runStoreConnection.js";

interface SecurityEventRow {
  id: string;
  event_type: string;
  device_id: string | null;
  workspace_key: string | null;
  detail: string | null;
  occurred_at: number;
}

function rowToEvent(row: SecurityEventRow): RemoteSecurityEvent {
  return {
    id: row.id,
    kind: row.event_type as RemoteSecurityEventKind,
    ...(row.device_id !== null ? { deviceId: row.device_id } : {}),
    ...(row.workspace_key !== null ? { workspaceKey: row.workspace_key } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    occurredAt: row.occurred_at,
  };
}

export class RemoteSecurityEventRepo {
  constructor(private readonly connection: RunStoreConnection) {}

  async ensureReady(): Promise<void> {
    await this.connection.ensureReady();
  }

  async record(input: {
    kind: RemoteSecurityEventKind;
    deviceId?: string;
    workspaceKey?: string;
    detail?: string;
  }): Promise<RemoteSecurityEvent> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const id = `rsec-${randomUUID()}`;
    const occurredAt = Date.now();
    db.prepare(
      `INSERT INTO pb_remote_security_events (id, event_type, device_id, workspace_key, detail, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.kind,
      input.deviceId ?? null,
      input.workspaceKey ?? null,
      input.detail ?? null,
      occurredAt,
    );
    return {
      id,
      kind: input.kind,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      occurredAt,
    };
  }

  async list(params?: { deviceId?: string; limit?: number }): Promise<RemoteSecurityEvent[]> {
    await this.ensureReady();
    const limit = Math.max(1, Math.min(params?.limit ?? 100, 500));
    const db = this.connection.getDatabase();
    const rows = params?.deviceId
      ? (db
          .prepare(
            `SELECT * FROM pb_remote_security_events WHERE device_id = ? ORDER BY occurred_at DESC LIMIT ?`,
          )
          .all(params.deviceId, limit) as unknown as SecurityEventRow[])
      : (db
          .prepare(`SELECT * FROM pb_remote_security_events ORDER BY occurred_at DESC LIMIT ?`)
          .all(limit) as unknown as SecurityEventRow[]);
    return rows.map(rowToEvent);
  }
}
