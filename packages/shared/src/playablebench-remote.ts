// 移动远程控制域类型（spec 06 §2、spec 09 §4/§6/§8）。纯类型文件，renderer 安全。
// AuthN（设备是谁）与 AuthZ（允许做什么）分开：设备绑定三能力档，档位展开为
// 六类 scope；每条命令 Host 端重新做权限检查，不凭 relay 认证放行（spec 09 §4）。

/** 设备能力档（spec 09 §4：只读/可发指令/可审批）。 */
export type RemoteDeviceTier = "read_only" | "instruction" | "approver";

/** 命令/数据访问的细分权限（裁决 SR-04 六类 scope）。 */
export type RemoteDeviceScope =
  | "read_status"
  | "read_task"
  | "send_instruction"
  | "approve_operation"
  | "cancel_run"
  | "manage_device";

/** 三能力档 → 允许 scope 的固定映射（不在档位之外临时扩权）。 */
export const REMOTE_DEVICE_TIER_SCOPES: Readonly<
  Record<RemoteDeviceTier, readonly RemoteDeviceScope[]>
> = {
  read_only: ["read_status", "read_task"],
  instruction: ["read_status", "read_task", "send_instruction", "cancel_run"],
  approver: [
    "read_status",
    "read_task",
    "send_instruction",
    "approve_operation",
    "cancel_run",
    "manage_device",
  ],
};

export function remoteDeviceTierAllows(tier: RemoteDeviceTier, scope: RemoteDeviceScope): boolean {
  return REMOTE_DEVICE_TIER_SCOPES[tier].includes(scope);
}

export type RemoteDeviceStatus = "pending" | "active" | "revoked" | "expired";

export interface RemoteDevice {
  id: string;
  name: string;
  deviceType?: string;
  /** 能力档（scope 的唯一来源）。 */
  tier: RemoteDeviceTier;
  status: RemoteDeviceStatus;
  /** 平台安全存储中的凭据引用（不存明文 secret，spec 06 §2）。 */
  credentialRef?: string;
  /** 配对凭证的可验证哈希（不存原始 token）。 */
  credentialHash?: string;
  revokedReason?: string;
  lastUsedAt?: number;
  expiresAt?: number;
  confirmedAt?: number;
  revokedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 命令幂等账本条目（spec 09 §6）：requestId 唯一、有效期、payload digest；
 * 重复 requestId 返回先前结果不再次执行（副作用安全）。
 */
export interface RemoteCommandLedgerEntry {
  requestId: string;
  deviceId: string;
  sessionId?: string;
  commandType: string;
  payloadDigest: string;
  status: "received" | "settled" | "expired";
  resultJson?: string;
  expiresAt?: number;
  receivedAt: number;
  settledAt?: number;
}

/** 安全事件种类（spec 09 §8：绑定/撤销/认证失败/命令拒绝/审批/会话结束）。 */
export type RemoteSecurityEventKind =
  | "device_pending"
  | "device_confirmed"
  | "device_revoked"
  | "all_devices_revoked"
  | "auth_failed"
  | "command_rejected"
  | "approval_decided"
  | "session_ended";

export interface RemoteSecurityEvent {
  id: string;
  kind: RemoteSecurityEventKind;
  deviceId?: string;
  workspaceKey?: string;
  /** 不含 token/原始授权链接/完整敏感输入的摘要（spec 09 §8）。 */
  detail?: string;
  occurredAt: number;
}
