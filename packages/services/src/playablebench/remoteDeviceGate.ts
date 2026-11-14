// 远程设备准入门（spec 09 §4/§6、门禁"授权测试全过/未授权设备无法获得数据/
// 命令重放与撤销立即生效"）。AuthZ+幂等一体化：每条命令先做 scope 重检
// （不凭 relay 认证放行），再过 requestId 幂等账本；拒绝路径写安全事件。
// 设备会话：以配对凭证哈希识别；未确认设备不产生任何数据访问。
import { hashPairingCredential } from "@zcode/shared/node";
import type { RemoteDevice, RemoteDeviceScope, RemoteDeviceTier } from "@zcode/shared";
import { RemoteCommandLedgerRepo } from "#src/session/remoteCommandLedgerRepo.js";
import { RemoteDeviceRepo } from "#src/session/remoteDeviceRepo.js";
import { RemoteSecurityEventRepo } from "#src/session/remoteSecurityEventRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

export interface RemoteDeviceGateOptions {
  dbPath?: string;
  connection?: RunStoreConnection;
  now?: () => number;
}

export type RemoteDeviceGateRejection =
  | "device_unconfirmed"
  | "device_revoked"
  | "device_expired"
  | "scope_denied"
  | "command_expired";

export interface RemoteDeviceAuthorizationResult {
  ok: boolean;
  device?: RemoteDevice;
  rejection?: RemoteDeviceGateRejection;
  /** 重复 requestId：携带先前结果，调用方原样返回且不得再次执行（spec 09 §6）。 */
  replayResult?: { resultJson?: string };
}

/** 命令类型 → 所需 scope（Host 端白名单，spec 09 §6 远程输入不调用任意函数名）。 */
const COMMAND_SCOPE_MAP: Readonly<Record<string, RemoteDeviceScope>> = {
  workspace_list: "read_status",
  workspace_switch: "read_task",
  task_list: "read_task",
  run_summary: "read_status",
  run_events: "read_status",
  send_instruction: "send_instruction",
  approve_operation: "approve_operation",
  pause_run: "cancel_run",
  resume_run: "send_instruction",
  cancel_run: "cancel_run",
  manage_device: "manage_device",
  // relay app payload 面（desktop manager 接线）：只读探测与配置读取按只读档；
  // 产生临时附件/写桌面配置的动作为指令档。
  bootstrap_request: "read_status",
  workspace_bridge_open: "read_task",
  workspace_reconnect: "read_task",
  platform_isDockerAvailable: "read_status",
  platform_listWSLDistros: "read_status",
  platform_listDockerContainers: "read_status",
  platform_listSSHConfigAliases: "read_status",
  platform_loadMcpFromUserDirectory: "read_status",
  platform_migrateLegacyCommonMcp: "read_status",
  platform_createTempTextAttachment: "send_instruction",
  platform_saveMcpToUserDirectory: "send_instruction",
};

export function resolveCommandScope(commandType: string): RemoteDeviceScope | null {
  return COMMAND_SCOPE_MAP[commandType] ?? null;
}

export class RemoteDeviceGate {
  private readonly devices: RemoteDeviceRepo;
  private readonly ledger: RemoteCommandLedgerRepo;
  private readonly securityEvents: RemoteSecurityEventRepo;
  private readonly now: () => number;

  constructor(options: RemoteDeviceGateOptions = {}) {
    const connection = options.connection ?? new RunStoreConnection(options.dbPath);
    this.devices = new RemoteDeviceRepo(connection);
    this.ledger = new RemoteCommandLedgerRepo(connection);
    this.securityEvents = new RemoteSecurityEventRepo(connection);
    this.now = options.now ?? Date.now;
  }

  /**
   * 设备会话识别：同 credentialHash 复用既有条目；新设备登记 pending。
   * pending/revoked/expired 一律拒绝数据访问（门禁：未授权设备无法获得数据）。
   */
  async ensureDeviceSession(input: {
    credentialHash: string;
    deviceName?: string;
    deviceType?: string;
  }): Promise<{ device: RemoteDevice; confirmed: boolean }> {
    await this.devices.expireDue(this.now());
    const existing = await this.devices.findByCredentialHash(input.credentialHash);
    if (existing) {
      if (existing.status !== "active") {
        return { device: existing, confirmed: false };
      }
      await this.devices.touch(existing.id, this.now());
      return { device: existing, confirmed: true };
    }
    const created = await this.devices.registerPending({
      name: input.deviceName ?? "未命名设备",
      ...(input.deviceType ? { deviceType: input.deviceType } : {}),
      credentialHash: input.credentialHash,
    });
    return { device: created, confirmed: false };
  }

  /** 桌面确认绑定（配对确认门）：确认前设备无法获得任何数据。 */
  async confirmDevice(
    deviceId: string,
    tier: RemoteDeviceTier,
    expiresAt?: number,
  ): Promise<RemoteDevice | null> {
    return this.devices.confirm(deviceId, {
      tier,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
  }

  async listDevices() {
    return this.devices.list();
  }

  async revokeDevice(deviceId: string, reason: string) {
    return this.devices.revoke(deviceId, reason);
  }

  async revokeAllDevices(reason: string) {
    return this.devices.revokeAll(reason);
  }

  async listSecurityEvents(params?: { deviceId?: string; limit?: number }) {
    return this.securityEvents.list(params);
  }

  /**
   * 命令准入（spec 09 §6）：未知命令类型拒绝（白名单外 RPC）；scope 重检；
   * requestId 幂等（重复返回先前结果不再次执行）；有效期校验。拒绝写安全事件。
   */
  async authorizeCommand(input: {
    credentialHash: string;
    commandType: string;
    requestId: string;
    payloadDigest: string;
    sessionId?: string;
    expiresAt?: number;
  }): Promise<RemoteDeviceAuthorizationResult> {
    const scope = resolveCommandScope(input.commandType);
    if (!scope) {
      await this.securityEvents.record({
        kind: "command_rejected",
        detail: `unknown command type: ${input.commandType}`,
      });
      return { ok: false, rejection: "scope_denied" };
    }
    const session = await this.ensureDeviceSession({ credentialHash: input.credentialHash });
    const device = session.device;
    const deviceEvent = { deviceId: device.id };
    if (!session.confirmed) {
      const rejection: RemoteDeviceGateRejection =
        device.status === "revoked"
          ? "device_revoked"
          : device.status === "expired"
            ? "device_expired"
            : "device_unconfirmed";
      await this.securityEvents.record({
        ...deviceEvent,
        kind: "command_rejected",
        detail: `device ${device.status}`,
      });
      return { ok: false, rejection, device };
    }
    if (!(await this.devices.allows(device.id, scope))) {
      await this.securityEvents.record({
        ...deviceEvent,
        kind: "command_rejected",
        detail: `scope denied: ${scope} for tier ${device.tier}`,
      });
      return { ok: false, rejection: "scope_denied", device };
    }
    // 有效期前置校验（spec 09 §6：过期请求拒绝）。
    if (input.expiresAt !== undefined && input.expiresAt <= this.now()) {
      await this.securityEvents.record({
        ...deviceEvent,
        kind: "command_rejected",
        detail: `command expired: ${input.requestId}`,
      });
      return { ok: false, rejection: "command_expired", device };
    }
    const begun = await this.ledger.begin({
      requestId: input.requestId,
      deviceId: device.id,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      commandType: input.commandType,
      payloadDigest: input.payloadDigest,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
    if (begun.reused) {
      await this.securityEvents.record({
        ...deviceEvent,
        kind: "command_rejected",
        detail: `replayed requestId: ${input.requestId}`,
      });
      return { ok: true, device, replayResult: { resultJson: begun.entry.resultJson } };
    }
    await this.devices.touch(device.id, this.now());
    return { ok: true, device };
  }

  async settleCommand(requestId: string, resultJson?: string) {
    return this.ledger.settle(requestId, { ...(resultJson !== undefined ? { resultJson } : {}) });
  }
}
