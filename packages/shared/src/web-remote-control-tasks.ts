// 手机任务面 relay payload（spec 09 §2 P0：任务列表/run 摘要与事件/追加指令/
// 等待审批/暂停·继续·取消）。新增 zcode_type 由旧桌面 default 分支跳过
// （闭集枚举加值偏斜已记录在案）；所有响应带 requestId 对齐授权门结算。
import type { PbApproval, PbRun, PbRunEvent } from "./playablebench-runs.js";

export interface WebRemoteControlTaskListRequestPayload {
  zcode_type: "task-list-request";
  requestId: string;
  limit?: number;
}

export interface WebRemoteControlTaskListResponsePayload {
  zcode_type: "task-list-response";
  requestId: string;
  success: true;
  result: {
    runs: Array<
      Pick<
        PbRun,
        | "id"
        | "status"
        | "goal"
        | "templateId"
        | "workspaceKey"
        | "startedAt"
        | "finishedAt"
        | "errorCode"
      > & {
        title?: string;
      }
    >;
  };
}

export interface WebRemoteControlRunSummaryRequestPayload {
  zcode_type: "run-summary-request";
  requestId: string;
  runId: string;
}

export interface WebRemoteControlRunSummaryResponsePayload {
  zcode_type: "run-summary-response";
  requestId: string;
  success: true;
  result: {
    run: PbRun;
    pendingApprovals: Array<Pick<PbApproval, "id" | "riskLevel" | "riskSummary" | "createdAt">>;
  };
}

export interface WebRemoteControlRunEventsRequestPayload {
  zcode_type: "run-events-request";
  requestId: string;
  runId: string;
  afterSequence?: number;
  limit?: number;
}

export interface WebRemoteControlRunEventsResponsePayload {
  zcode_type: "run-events-response";
  requestId: string;
  success: true;
  result: {
    events: Array<Pick<PbRunEvent, "sequence" | "eventId" | "eventType" | "occurredAt">>;
  };
}

/** 追加指令（spec 09 §2）：requestId 即幂等键，重复提交返回先前结果。 */
export interface WebRemoteControlInstructionRequestPayload {
  zcode_type: "instruction-request";
  requestId: string;
  runId: string;
  text: string;
}

export interface WebRemoteControlInstructionResponsePayload {
  zcode_type: "instruction-response";
  requestId: string;
  success: boolean;
  result?: { status: string; reasonCode?: string };
  error?: string;
}

/** 审批决定（spec 09 §4/§7）：只批准特定 operationDigest，CAS 单次生效。 */
export interface WebRemoteControlApprovalDecisionRequestPayload {
  zcode_type: "approval-decision-request";
  requestId: string;
  approvalId: string;
  decision: "approved" | "denied";
  operationDigest?: string;
}

export interface WebRemoteControlApprovalDecisionResponsePayload {
  zcode_type: "approval-decision-response";
  requestId: string;
  success: boolean;
  result?: { decided: boolean; decision: string };
  error?: string;
}

/** run 控制（暂停/继续/取消；runtime 支持才展示，spec 09 §2）。 */
export interface WebRemoteControlRunControlRequestPayload {
  zcode_type: "run-control-request";
  requestId: string;
  runId: string;
  action: "pause" | "resume" | "cancel";
}

export interface WebRemoteControlRunControlResponsePayload {
  zcode_type: "run-control-response";
  requestId: string;
  success: boolean;
  result?: { status: string; reasonCode?: string };
  error?: string;
}

export type WebRemoteControlTaskAppRequestPayload =
  | WebRemoteControlTaskListRequestPayload
  | WebRemoteControlRunSummaryRequestPayload
  | WebRemoteControlRunEventsRequestPayload
  | WebRemoteControlInstructionRequestPayload
  | WebRemoteControlApprovalDecisionRequestPayload
  | WebRemoteControlRunControlRequestPayload;

export type WebRemoteControlTaskAppResponsePayload =
  | WebRemoteControlTaskListResponsePayload
  | WebRemoteControlRunSummaryResponsePayload
  | WebRemoteControlRunEventsResponsePayload
  | WebRemoteControlInstructionResponsePayload
  | WebRemoteControlApprovalDecisionResponsePayload
  | WebRemoteControlRunControlResponsePayload;
