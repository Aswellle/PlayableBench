// Run 域行结构与行→实体转换（pb_runs/pb_run_events/pb_tool_executions/pb_approvals）。
// 供 runRepo/toolExecutionRepo/approvalRepo 共享；类型保持与迁移 0005 冻结列一致。
import type {
  PbApproval,
  PbApprovalDecision,
  PbRun,
  PbRunEvent,
  PbRunStatus,
  PbSideEffectState,
  PbToolExecution,
  PbToolExecutionStatus,
} from "@zcode/shared";

export interface RunRow {
  id: string;
  template_id: string | null;
  template_version: string | null;
  status: string;
  goal: string;
  input_ref: string | null;
  runtime_session_id: string | null;
  workspace_key: string | null;
  workspace_path: string | null;
  permission_mode: string | null;
  started_at: number | null;
  finished_at: number | null;
  last_heartbeat_at: number | null;
  current_step: string | null;
  cost_info: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

export function rowToRun(row: RunRow): PbRun {
  return {
    id: row.id,
    templateId: row.template_id ?? undefined,
    templateVersion: row.template_version ?? undefined,
    status: row.status as PbRunStatus,
    goal: row.goal,
    inputRef: row.input_ref ?? undefined,
    runtimeSessionId: row.runtime_session_id ?? undefined,
    workspaceKey: row.workspace_key ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    permissionMode: row.permission_mode ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    currentStep: row.current_step ?? undefined,
    costInfo: row.cost_info ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RunEventRow {
  run_id: string;
  sequence: number;
  event_id: string;
  event_type: string;
  occurred_at: number;
  payload_json: string | null;
  schema_version: number;
  created_at: number;
}

export function rowToEvent(row: RunEventRow): PbRunEvent {
  return {
    runId: row.run_id,
    sequence: row.sequence,
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    payloadJson: row.payload_json ?? undefined,
    schemaVersion: row.schema_version,
  };
}

export interface ToolExecutionRow {
  id: string;
  run_id: string;
  tool_id: string;
  tool_version: string | null;
  risk_level: string | null;
  input_digest: string | null;
  idempotency_key: string | null;
  status: string;
  attempt: number;
  side_effect_state: string;
  started_at: number | null;
  finished_at: number | null;
  result_summary: string | null;
  error_summary: string | null;
  created_at: number;
  updated_at: number;
}

export function rowToToolExecution(row: ToolExecutionRow): PbToolExecution {
  return {
    id: row.id,
    runId: row.run_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version ?? undefined,
    riskLevel: row.risk_level ?? undefined,
    inputDigest: row.input_digest ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    status: row.status as PbToolExecutionStatus,
    attempt: row.attempt,
    sideEffectState: row.side_effect_state as PbSideEffectState,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    resultSummary: row.result_summary ?? undefined,
    errorSummary: row.error_summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ApprovalRow {
  id: string;
  run_id: string;
  tool_execution_id: string | null;
  interaction_id: string | null;
  operation_digest: string;
  request_json: string;
  risk_level: string | null;
  risk_summary: string | null;
  expires_at: number | null;
  decided_by: string | null;
  decision: string;
  decided_at: number | null;
  revoke_reason: string | null;
  created_at: number;
  updated_at: number;
}

export function rowToApproval(row: ApprovalRow): PbApproval {
  return {
    id: row.id,
    runId: row.run_id,
    toolExecutionId: row.tool_execution_id ?? undefined,
    interactionId: row.interaction_id ?? undefined,
    operationDigest: row.operation_digest,
    requestJson: row.request_json,
    riskLevel: row.risk_level ?? undefined,
    riskSummary: row.risk_summary ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decision: row.decision as PbApprovalDecision,
    decidedAt: row.decided_at ?? undefined,
    revokeReason: row.revoke_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RunTransitionInput {
  /** 观察到的迁移起点；与当前状态不一致视为 stale（乱序/过期观测），不落库。 */
  from: PbRunStatus;
  to: PbRunStatus;
  eventId: string;
  reason?: string;
  eventType?: string;
  occurredAt?: number;
  payloadJson?: string;
}

export type RunTransitionDisposition = "applied" | "deduplicated" | "stale";

export interface RunTransitionResult {
  run: PbRun;
  disposition: RunTransitionDisposition;
  /** applied 时返回本次落库的事件（含分配的 sequence）。 */
  event?: PbRunEvent;
}
