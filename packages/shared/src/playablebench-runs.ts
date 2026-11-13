// PlayableBench Run 领域类型与状态机（spec 05 §2/§3、spec 06 §2）。
// 状态集合与语义以 spec 05 §3 为准：completed 仅表示流程正常结束；
// cancelled 不代表撤销既有副作用；interrupted 表示中断且安全性未定；
// needs_reconciliation 表示非幂等操作结果不确定，禁止直接重跑。
// waiting_approval 必须绑定操作 digest，参数或目标变化需重新审批（S5）。

export type PbRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_approval"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "needs_reconciliation";

/** 终态：不允许再迁出；needs_reconciliation 仅在人工决策后按裁决流向收尾。 */
export const PB_RUN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "needs_reconciliation",
] as const satisfies readonly PbRunStatus[];

/** spec 05 §3 合法迁移表；任何未列出的 from→to 都是非法迁移，必须被拒绝持久化。 */
export const PB_RUN_LEGAL_TRANSITIONS: Readonly<Record<PbRunStatus, readonly PbRunStatus[]>> = {
  queued: ["planning", "running", "waiting_approval", "failed", "cancelled", "interrupted", "needs_reconciliation"],
  planning: ["running", "waiting_approval", "failed", "cancelled", "interrupted", "needs_reconciliation"],
  running: [
    "waiting_approval",
    "verifying",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "needs_reconciliation",
  ],
  waiting_approval: ["running", "verifying", "completed", "failed", "cancelled", "interrupted", "needs_reconciliation"],
  verifying: ["completed", "running", "waiting_approval", "failed", "cancelled", "interrupted", "needs_reconciliation"],
  interrupted: ["running", "failed", "cancelled", "needs_reconciliation"],
  needs_reconciliation: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** 纯函数状态机校验；非法迁移返回 false，由 Repo 拒绝持久化（spec 05 §3）。 */
export function isRunTransitionLegal(from: PbRunStatus, to: PbRunStatus): boolean {
  if (from === to) return false;
  return PB_RUN_LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface PbRun {
  id: string;
  templateId?: string;
  templateVersion?: string;
  status: PbRunStatus;
  goal: string;
  inputRef?: string;
  /** 关联的 V4 会话 id（tasks-index tasks.task_id 同源）。 */
  runtimeSessionId?: string;
  workspaceKey?: string;
  workspacePath?: string;
  /** SR-02：PB 新启动路径显式记录的权限 mode；run 层默认禁 yolo。 */
  permissionMode?: string;
  startedAt?: number;
  finishedAt?: number;
  lastHeartbeatAt?: number;
  currentStep?: string;
  costInfo?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRunInput {
  goal: string;
  templateId?: string;
  templateVersion?: string;
  inputRef?: string;
  runtimeSessionId?: string;
  workspaceKey?: string;
  workspacePath?: string;
  permissionMode?: string;
}

/** RunEvent（spec 06 §2）：单调 sequence + 全局 event_id 双键去重。 */
export interface PbRunEvent {
  runId: string;
  sequence: number;
  eventId: string;
  eventType: string;
  occurredAt: number;
  /** 已脱敏 payload（JSON 文本）；不允许写入凭据或完整文件内容。 */
  payloadJson?: string;
  schemaVersion: number;
}

/** ToolExecution（spec 06 §2）：attempt/幂等键/副作用状态支撑崩溃恢复扫描。 */
export type PbToolExecutionStatus = "pending" | "running" | "success" | "failed" | "cancelled" | "needs_reconciliation";

export type PbSideEffectState = "not_started" | "unknown" | "confirmed" | "rolled_back" | "needs_reconciliation";

export interface PbToolExecution {
  id: string;
  runId: string;
  toolId: string;
  toolVersion?: string;
  riskLevel?: string;
  /** 入参规范化摘要（sha256），审批 digest 同源。 */
  inputDigest?: string;
  idempotencyKey?: string;
  status: PbToolExecutionStatus;
  attempt: number;
  sideEffectState: PbSideEffectState;
  startedAt?: number;
  finishedAt?: number;
  resultSummary?: string;
  errorSummary?: string;
  createdAt: number;
  updatedAt: number;
}

/** Approval（spec 06 §2）：digest 绑定、截止、决策与撤销原因。 */
export type PbApprovalDecision = "pending" | "approved" | "denied" | "expired" | "revoked";

export interface PbApproval {
  id: string;
  runId: string;
  toolExecutionId?: string;
  /** V4 resolveInteraction 的 interactionId；一对一映射。 */
  interactionId?: string;
  /** 操作摘要 digest（规范化 JSON 的 sha256）；参数或目标变化必须产生新 digest。 */
  operationDigest: string;
  /** 脱敏后的请求内容（JSON 文本）。 */
  requestJson: string;
  riskLevel?: string;
  riskSummary?: string;
  expiresAt?: number;
  decidedBy?: string;
  decision: PbApprovalDecision;
  decidedAt?: number;
  revokeReason?: string;
  createdAt: number;
  updatedAt: number;
}
