// 研究工作流服务接口与 descriptor（纯类型/常量文件，renderer 安全）。
// 把信息卡片接入 Agent 研究运行（spec 16 信息到工作流闭环、spec 05 §2/§8、
// spec 08 §4 交给 Agent 研究）：模板落库（版本不可静默变更）、幂等启动
// （同卡片活跃 run 复用）、run 视图透出。实现文件 researchServiceHost.ts
// 携带 node:sqlite 与 runtime 依赖链，不进 renderer barrel。
import type { PbRun, PbWorkflowTemplate } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ResearchStartResult {
  run: PbRun;
  template: PbWorkflowTemplate;
  /** reused=true 表示同卡片已有活跃研究 run，本次幂等复用（spec 16 门禁）。 */
  reused: boolean;
}

/** 研究运行视图（UI 状态透出最小面）。 */
export interface ResearchRunView {
  run: PbRun;
  pendingApprovalCount: number;
}

export interface IResearchService {
  /**
   * 从卡片启动研究运行：内置 research_article 模板（capabilities 白名单），
   * goal 由 untrusted 分隔块组装；同卡片存在活跃 run 时幂等复用。
   */
  startResearchFromCard(input: {
    cardId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ResearchStartResult>;
  /** 研究运行视图（持久化事实 + 未决审批计数）。 */
  getRun(runId: string): Promise<ResearchRunView | null>;
}

export const IResearchService = createServiceDescriptor<IResearchService>(ServiceChannels.Research);
