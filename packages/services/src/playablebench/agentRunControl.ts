// PB Agent 运行控制与审批服务接口（纯类型/常量文件，renderer 安全）。
// 桌面审批面板与手机审批卡片共用的单一决策路径：审批决定经
// IAgentRuntimePort.submitApproval（digest 绑定校验 + 审批单向收敛），
// 控制（暂停/继续/取消）经端口命令映射（CAS 快照前置）——不制造第二条
// 命令写入路径。实现文件 agentRunControlHost.ts 携带 runtime 依赖链。
import type { PbApproval, PbRun, PbToolExecution } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 运行概览行（列表面）。 */
export interface AgentRunListItem {
  id: string;
  goal: string;
  status: string;
  templateId?: string;
  workspaceKey?: string;
  startedAt?: number;
  finishedAt?: number;
  errorCode?: string;
  /** 未决审批数（>0 的行优先展示）。 */
  pendingApprovals: number;
}

/** 审批卡数据（spec 09 §4：展示被批准操作的摘要 digest/目标/参数/风险）。 */
export interface AgentApprovalCard {
  id: string;
  runId: string;
  toolId: string;
  operationDigest: string;
  riskLevel?: string;
  riskSummary?: string;
  requestPreview?: string;
  expiresAt?: number;
  createdAt: number;
}

export interface AgentRunDetail {
  run: PbRun;
  pendingApprovals: AgentApprovalCard[];
  unfinishedToolExecutions: Array<Pick<PbToolExecution, "id" | "toolId" | "status">>;
}

export interface IAgentRunControlService {
  /** 运行概览（最近优先；pendingApprovals>0 的行置顶）。 */
  listRuns(limit?: number): Promise<AgentRunListItem[]>;
  /** 运行详情（审批卡全量）。 */
  getRunDetail(runId: string): Promise<AgentRunDetail | null>;
  /**
   * 审批决定：decisionDigest 与审批记录的 operationDigest 必须一致
   * （不一致拒绝 digest_mismatch）；并发/重复决定返回已收敛状态。
   */
  decideApproval(
    approvalId: string,
    decision: "approved" | "denied",
    decisionDigest?: string,
  ): Promise<{ decided: boolean; decision: string; error?: string }>;
  /** run 控制：暂停/继续（CAS 快照前置，未观察到快照时诚实拒绝）/取消。 */
  controlRun(
    runId: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<{ status: string; reasonCode?: string }>;
}

export const IAgentRunControlService = createServiceDescriptor<IAgentRunControlService>(
  ServiceChannels.AgentRunControl,
);
