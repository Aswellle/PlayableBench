// 研究工作流服务实现（Host 侧；node:sqlite 与 runtime 依赖链，不进 renderer barrel）。
// 组装 FeedItemRepo/FeedSourceRepo/WorkflowTemplateRepo/RunRepo/IAgentRuntimePort；
// goal 经 untrusted 分隔块组装（goalComposer）；启动幂等：同卡片活跃 run 直接
// 复用（spec 16 门禁）。内置 research_article 模板版本 v1：capabilities 白名单
// 与工具策略取交集，外部内容不能提升工具权限（SR-12）。
import type { PbRun, PbWorkflowTemplate } from "@zcode/shared";
import type { IAgentRuntimePort } from "#src/playablebench/agentRuntimePort.js";
import { composeResearchGoal } from "#src/playablebench/goalComposer.js";
import type { IResearchService, ResearchRunView, ResearchStartResult } from "#src/playablebench/researchService.js";
import { FeedItemRepo } from "#src/session/feedItemRepo.js";
import { FeedSourceRepo } from "#src/session/feedSourceRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { WorkflowTemplateRepo } from "#src/session/workflowTemplateRepo.js";

export const RESEARCH_TEMPLATE_ID = "research_article";
export const RESEARCH_TEMPLATE_VERSION = "v1";

/** research_article v1 允许的工具能力（白名单与 TOOL_POLICY_REGISTRY 交集）。 */
const RESEARCH_TEMPLATE_PERMISSIONS = {
  capabilities: ["read_local", "write_local", "network_read"],
  approvalPolicy: "tool_policy_requires_approval",
} as const;

export interface ResearchServiceHostOptions {
  port: IAgentRuntimePort;
  /** 测试注入临时库路径；生产缺省走进程默认 tasks-index 库。 */
  dbPath?: string;
  connection?: RunStoreConnection;
}

export function createResearchService(options: ResearchServiceHostOptions): IResearchService {
  const connection = options.connection ?? new RunStoreConnection(options.dbPath);
  const items = new FeedItemRepo(connection);
  const sources = new FeedSourceRepo(connection);
  const templates = new WorkflowTemplateRepo(connection);
  const runs = new RunRepo(connection);

  async function ensureResearchTemplate(): Promise<PbWorkflowTemplate> {
    // 种子只在缺失时插入：版本发布后不可静默改变旧 run 的执行定义（spec 05 §8）。
    return templates.ensure({
      id: RESEARCH_TEMPLATE_ID,
      version: RESEARCH_TEMPLATE_VERSION,
      name: "研究一篇文章",
      inputSchema: JSON.stringify({
        type: "object",
        required: ["cardId"],
        properties: { cardId: { type: "string" } },
      }),
      definition: JSON.stringify({
        steps: ["读取 untrusted 块中的原文", "整理来源事实与引用", "产出摘要与引用列表"],
      }),
      permissions: JSON.stringify(RESEARCH_TEMPLATE_PERMISSIONS),
      approvalPolicy: JSON.stringify({ mode: "tool_policy", highRisk: "require_approval" }),
      outputSchema: JSON.stringify({
        type: "object",
        properties: {
          summary: { type: "string" },
          citations: { type: "array", items: { type: "object" } },
        },
        required: ["summary"],
      }),
    });
  }

  return {
    async startResearchFromCard(input): Promise<ResearchStartResult> {
      const card = await items.get(input.cardId);
      if (!card) {
        throw Object.assign(new Error(`卡片不存在: ${input.cardId}`), { kind: "card_not_found" });
      }
      const template = await ensureResearchTemplate();
      // 幂等复用（spec 16 门禁）：同卡片活跃 run 存在则直接返回，不重复创建。
      const existing = await runs.findActiveRunByTemplateInput(RESEARCH_TEMPLATE_ID, card.id);
      if (existing) {
        return { run: existing, template, reused: true };
      }
      const source = await sources.get(card.sourceId);
      const descriptor = await options.port.createRun(
        {
          goal: composeResearchGoal({
            title: card.title,
            originalUrl: card.originalUrl,
            ...(card.canonicalUrl !== card.originalUrl ? { canonicalUrl: card.canonicalUrl } : {}),
            ...(card.author ? { author: card.author } : {}),
            ...(card.publishedAt !== undefined ? { publishedAt: card.publishedAt } : {}),
            ...(card.summary ? { summary: card.summary } : {}),
            ...(source?.name ? { sourceName: source.name } : {}),
          }),
          templateId: template.id,
          templateVersion: template.version,
          inputRef: card.id,
        },
        {
          permissionMode: "build",
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        },
      );
      const run: PbRun | null = await runs.getRun(descriptor.runId);
      if (!run) {
        throw new Error(`研究 run 建档后不可读: ${descriptor.runId}`);
      }
      return { run, template, reused: false };
    },

    async getRun(runId): Promise<ResearchRunView | null> {
      const snapshot = await options.port.getRun(runId);
      if (!snapshot) return null;
      return {
        run: snapshot.run,
        pendingApprovalCount: snapshot.pendingApprovals.length,
      };
    },
  };
}
