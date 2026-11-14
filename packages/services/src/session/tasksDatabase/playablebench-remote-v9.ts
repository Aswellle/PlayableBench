// 移动远程控制域迁移（PlayableBench）：设备注册表 / 命令幂等账本 / 安全事件
// （spec 06 §2 RemoteDevice/RemoteCommand、spec 09 §3/§4/§6/§8、
// docs/audit/13-移动远程控制-开发计划.md S1）。
// 全部为纯增量 DDL。安全纪律（spec 09 §3/§8）：设备凭据只存引用与可验证哈希，
// 不存明文 token/长期秘密；安全事件不落原始授权链接/token/完整敏感输入。
// 命令账本：request_id 全局唯一（幂等键），重复提交按已存行返回先前结果
// （spec 09 §6：过期/已撤销/重复/越权必须拒绝；副作用命令不再次执行）。

export const PB_REMOTE_DEVICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_remote_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  device_type TEXT,
  scope TEXT NOT NULL DEFAULT 'read_only',
  scopes_json TEXT,
  credential_ref TEXT,
  credential_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  revoked_reason TEXT,
  last_used_at INTEGER,
  expires_at INTEGER,
  confirmed_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pb_remote_devices_status
  ON pb_remote_devices(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pb_remote_devices_credential_hash
  ON pb_remote_devices(credential_hash) WHERE credential_hash IS NOT NULL;
`;

export const PB_REMOTE_COMMANDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_remote_command_ledger (
  request_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  session_id TEXT,
  command_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  result_ref TEXT,
  result_json TEXT,
  expires_at INTEGER,
  received_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pb_remote_commands_device
  ON pb_remote_command_ledger(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_pb_remote_commands_expiry
  ON pb_remote_command_ledger(expires_at) WHERE expires_at IS NOT NULL;
`;

export const PB_REMOTE_SECURITY_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_remote_security_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  device_id TEXT,
  workspace_key TEXT,
  detail TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pb_remote_security_events_time
  ON pb_remote_security_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pb_remote_security_events_device
  ON pb_remote_security_events(device_id, occurred_at DESC) WHERE device_id IS NOT NULL;
`;

export const PLAYABLEBENCH_REMOTE_V9_SQL = [
  PB_REMOTE_DEVICES_SCHEMA,
  PB_REMOTE_COMMANDS_SCHEMA,
  PB_REMOTE_SECURITY_EVENTS_SCHEMA,
].join("\n");

export function applyPlayableBenchRemoteV9(db: { exec: (sql: string) => void }): void {
  db.exec(PLAYABLEBENCH_REMOTE_V9_SQL);
}
