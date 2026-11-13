// Phase 3 Run 域迁移（PlayableBench）：runs/run_events/tool_executions/approvals
// 持久化（spec 05 §3/§6、spec 06 §2、docs/audit/10-Phase3-开发计划.md S1）。
// 全部为纯增量 DDL；事件去重靠 (run_id, sequence) 主键 + (run_id, event_id) 唯一，
// 乱序/重复投递由 INSERT OR IGNORE 幂等吸收（spec 16 门禁：重复事件不产生重复副作用）。

export const PB_RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_runs (
  id TEXT PRIMARY KEY,
  template_id TEXT,
  template_version TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  goal TEXT NOT NULL DEFAULT '',
  input_ref TEXT,
  runtime_session_id TEXT,
  workspace_key TEXT,
  workspace_path TEXT,
  permission_mode TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  last_heartbeat_at INTEGER,
  current_step TEXT,
  cost_info TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pb_runs_status ON pb_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pb_runs_session ON pb_runs(runtime_session_id)
  WHERE runtime_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pb_runs_workspace ON pb_runs(workspace_key, updated_at DESC)
  WHERE workspace_key IS NOT NULL;
`;

export const PB_RUN_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_run_events (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  payload_json TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_run_events_event_id ON pb_run_events(run_id, event_id);
CREATE INDEX IF NOT EXISTS idx_pb_run_events_time ON pb_run_events(run_id, occurred_at);
`;

export const PB_TOOL_EXECUTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_tool_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  tool_version TEXT,
  risk_level TEXT,
  input_digest TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 1,
  side_effect_state TEXT NOT NULL DEFAULT 'not_started',
  started_at INTEGER,
  finished_at INTEGER,
  result_summary TEXT,
  error_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_tool_executions_idem
  ON pb_tool_executions(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pb_tool_executions_run ON pb_tool_executions(run_id, started_at);
`;

export const PB_APPROVALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_execution_id TEXT,
  interaction_id TEXT,
  operation_digest TEXT NOT NULL,
  request_json TEXT NOT NULL,
  risk_level TEXT,
  risk_summary TEXT,
  expires_at INTEGER,
  decided_by TEXT,
  decision TEXT NOT NULL DEFAULT 'pending',
  decided_at INTEGER,
  revoke_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_approvals_interaction
  ON pb_approvals(interaction_id) WHERE interaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pb_approvals_run ON pb_approvals(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pb_approvals_pending
  ON pb_approvals(expires_at) WHERE decision='pending';
`;

export const PLAYABLEBENCH_RUNS_V5_SQL = [
  PB_RUNS_SCHEMA,
  PB_RUN_EVENTS_SCHEMA,
  PB_TOOL_EXECUTIONS_SCHEMA,
  PB_APPROVALS_SCHEMA,
].join("\n");

export function applyPlayableBenchRunsV5(db: { exec: (sql: string) => void }): void {
  db.exec(PLAYABLEBENCH_RUNS_V5_SQL);
}
