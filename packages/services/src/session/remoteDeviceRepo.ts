// 远程设备注册表（spec 06 §2、spec 09 §3/§4、裁决 SR-04）。
// 生命周期：pending（配对码消费后登记，等待桌面确认）→ active（确认后可用）
// → revoked/expired。撤销即时失效语义：撤销后 credential 查找与 scope 判定
// 一律拒绝（活跃 WS 的强制断开由 manager 层执行）。凭据只存引用与可验证哈希。
import { randomUUID } from "node:crypto";
import type {
  RemoteDevice,
  RemoteDeviceScope,
  RemoteDeviceStatus,
  RemoteDeviceTier,
  RemoteSecurityEventKind,
} from "@zcode/shared";
import { remoteDeviceTierAllows } from "@zcode/shared";
import type { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { RemoteSecurityEventRepo } from "#src/session/remoteSecurityEventRepo.js";

interface DeviceRow {
  id: string;
  name: string;
  device_type: string | null;
  scope: string;
  scopes_json: string | null;
  credential_ref: string | null;
  credential_hash: string | null;
  status: string;
  revoked_reason: string | null;
  last_used_at: number | null;
  expires_at: number | null;
  confirmed_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToDevice(row: DeviceRow): RemoteDevice {
  return {
    id: row.id,
    name: row.name,
    ...(row.device_type !== null ? { deviceType: row.device_type } : {}),
    tier: row.scope as RemoteDeviceTier,
    status: row.status as RemoteDeviceStatus,
    ...(row.credential_ref !== null ? { credentialRef: row.credential_ref } : {}),
    ...(row.credential_hash !== null ? { credentialHash: row.credential_hash } : {}),
    ...(row.revoked_reason !== null ? { revokedReason: row.revoked_reason } : {}),
    ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(row.confirmed_at !== null ? { confirmedAt: row.confirmed_at } : {}),
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RegisterDeviceInput {
  name: string;
  deviceType?: string;
  credentialRef?: string;
  credentialHash: string;
  expiresAt?: number;
}

export class RemoteDeviceRepo {
  private readonly securityEvents: RemoteSecurityEventRepo;

  constructor(private readonly connection: RunStoreConnection) {
    this.securityEvents = new RemoteSecurityEventRepo(connection);
  }

  async ensureReady(): Promise<void> {
    await this.connection.ensureReady();
  }

  /** 配对码消费后登记 pending 设备（等待桌面侧确认，spec 09 §3 第 4 步）。 */
  async registerPending(input: RegisterDeviceInput): Promise<RemoteDevice> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const now = Date.now();
    const id = `rdev-${randomUUID()}`;
    db.prepare(
      `INSERT INTO pb_remote_devices
         (id, name, device_type, scope, credential_ref, credential_hash, status,
          expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'read_only', ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.deviceType ?? null,
      input.credentialRef ?? null,
      input.credentialHash,
      input.expiresAt ?? null,
      now,
      now,
    );
    await this.securityEvents.record({ kind: "device_pending", deviceId: id });
    return this.getOrThrow(id);
  }

  /**
   * 桌面用户确认绑定并指定能力档（spec 09 §3 第 4 步：展示名称/类型/权限/
   * 有效期后确认）。pending → active；确认时同时设置有效期。
   */
  async confirm(
    id: string,
    input: { tier: RemoteDeviceTier; expiresAt?: number },
  ): Promise<RemoteDevice | null> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const device = await this.get(id);
    if (!device || device.status !== "pending") return null;
    const now = Date.now();
    db.prepare(
      `UPDATE pb_remote_devices
       SET scope = ?, status = 'active', confirmed_at = ?, expires_at = COALESCE(?, expires_at),
           updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(input.tier, now, input.expiresAt ?? null, now, id);
    await this.securityEvents.record({ kind: "device_confirmed", deviceId: id });
    return this.get(id);
  }

  async get(id: string): Promise<RemoteDevice | null> {
    await this.ensureReady();
    const row = this.connection
      .getDatabase()
      .prepare(`SELECT * FROM pb_remote_devices WHERE id = ?`)
      .get(id) as unknown as DeviceRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  private async getOrThrow(id: string): Promise<RemoteDevice> {
    const device = await this.get(id);
    if (!device) throw new Error(`设备不存在: ${id}`);
    return device;
  }

  async list(params?: { status?: RemoteDeviceStatus }): Promise<RemoteDevice[]> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const rows = params?.status
      ? (db
          .prepare(`SELECT * FROM pb_remote_devices WHERE status = ? ORDER BY updated_at DESC`)
          .all(params.status) as unknown as DeviceRow[])
      : (db
          .prepare(`SELECT * FROM pb_remote_devices ORDER BY updated_at DESC`)
          .all() as unknown as DeviceRow[]);
    return rows.map(rowToDevice);
  }

  /** 认证查找：仅 active 且未过期设备可命中（撤销/过期即时失效）。 */
  async findActiveByCredentialHash(
    credentialHash: string,
    nowMs: number = Date.now(),
  ): Promise<RemoteDevice | null> {
    await this.ensureReady();
    const device = await this.findByCredentialHash(credentialHash);
    if (!device || device.status !== "active") return null;
    if (device.expiresAt !== undefined && device.expiresAt <= nowMs) return null;
    return device;
  }

  async findByCredentialHash(credentialHash: string): Promise<RemoteDevice | null> {
    await this.ensureReady();
    const row = this.connection
      .getDatabase()
      .prepare(
        `SELECT * FROM pb_remote_devices WHERE credential_hash = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(credentialHash) as unknown as DeviceRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  /** 最近使用推进（纯活性记录，不改权限）。 */
  async touch(id: string, atMs: number = Date.now()): Promise<void> {
    await this.ensureReady();
    this.connection
      .getDatabase()
      .prepare(
        `UPDATE pb_remote_devices SET last_used_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
      )
      .run(atMs, atMs, id);
  }

  /** 逐设备撤销：撤销后凭据查找与 scope 判定一律拒绝（spec 09 §4 一键撤销）。 */
  async revoke(id: string, reason: string): Promise<RemoteDevice | null> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const device = await this.get(id);
    if (!device || device.status === "revoked") return device;
    const now = Date.now();
    db.prepare(
      `UPDATE pb_remote_devices SET status = 'revoked', revoked_reason = ?, revoked_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(reason, now, now, id);
    await this.securityEvents.record({ kind: "device_revoked", deviceId: id });
    return this.get(id);
  }

  /** 一键撤销全部活跃设备；返回撤销数量。 */
  async revokeAll(reason: string): Promise<number> {
    await this.ensureReady();
    const active = await this.list({ status: "active" });
    for (const device of active) {
      await this.revoke(device.id, reason);
    }
    if (active.length > 0) {
      await this.securityEvents.record({ kind: "all_devices_revoked" });
    }
    return active.length;
  }

  /** 到期收敛：pending/active 且 expires_at 已过 → expired。返回过期数量。 */
  async expireDue(nowMs: number = Date.now()): Promise<number> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const result = db
      .prepare(
        `UPDATE pb_remote_devices SET status = 'expired', revoked_reason = 'expired',
           revoked_at = ?, updated_at = ?
         WHERE status IN ('pending','active') AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(nowMs, nowMs, nowMs);
    return Number(result.changes ?? 0);
  }

  /** AuthZ 判定（Host 端每条命令重检，spec 09 §4）：仅 active 设备按能力档校验。 */
  async allows(deviceId: string, scope: RemoteDeviceScope): Promise<boolean> {
    await this.ensureReady();
    const device = await this.get(deviceId);
    if (!device || device.status !== "active") return false;
    return remoteDeviceTierAllows(device.tier, scope);
  }

  async recordSecurityEvent(input: {
    kind: RemoteSecurityEventKind;
    deviceId?: string;
    workspaceKey?: string;
    detail?: string;
  }): Promise<void> {
    await this.securityEvents.record(input);
  }
}
