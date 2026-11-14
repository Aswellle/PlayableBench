// PB Agent 运行控制与审批服务实现（Host 侧；runtime 依赖链，不进 renderer barrel）。
// 审批决定 = 端口 submitApproval（digest 绑定校验 + 审批单向收敛 + V4
// resolveInteraction），控制 = 端口命令映射；列表/详情直读 Run 域仓库。
import type { PbApproval } from "@zcode/shared";
import type {
  AgentApprovalCard,
  AgentRunDetail,
  AgentRunListItem,
  IAgentRunControlService,
} from "#src/playablebench/agentRunControl.js";
import type { IAgentRuntimePort } from "#src/playablebench/agentRuntimePort.js";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";

export interface AgentRunControlHostOptions {
  port: IAgentRuntimePort;
  connection?: RunStoreConnection;
  dbPath?: string;
}

/** 请求 JSON 的紧凑预览（审批卡展示摘要/目标/参数；截断防膨胀）。 */
function buildRequestPreview(requestJson: string, maxLength = 400): string {
  try {
    const parsed = JSON.parse(requestJson) as Record<string, unknown>;
    const parts = Object.entries(parsed)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(
        ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      );
    const preview = parts.join("；");
    return preview.length > maxLength ? `${preview.slice(0, maxLength)}…` : preview;
  } catch {
    return requestJson.length > maxLength ? `${requestJson.slice(0, maxLength)}…` : requestJson;
  }
}

function toApprovalCard(approval: PbApproval): AgentApprovalCard {
  // toolId 存于 requestJson（审批建档时不复制到列）；解析失败回退 unknown。
  let toolId = "unknown";
  try {
    const parsed = JSON.parse(approval.requestJson) as { toolId?: string };
    if (parsed.toolId) toolId = parsed.toolId;
  } catch {
    /* 损坏请求按 unknown 展示，不掩盖 digest 与风险摘要。 */
  }
  return {
    id: approval.id,
    runId: approval.runId,
    toolId,
    operationDigest: approval.operationDigest,
    ...(approval.riskLevel !== undefined ? { riskLevel: approval.riskLevel } : {}),
    ...(approval.riskSummary !== undefined ? { riskSummary: approval.riskSummary } : {}),
    requestPreview: buildRequestPreview(approval.requestJson),
    ...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
    createdAt: approval.createdAt,
  };
}

export function createAgentRunControlService(
  options: AgentRunControlHostOptions,
): IAgentRunControlService {
  const connection = options.connection ?? new RunStoreConnection(options.dbPath);
  const runRepo = new RunRepo(connection);
  const approvals = new ApprovalRepo(connection);
  const toolExecutions = new ToolExecutionRepo(connection);
  const port = options.port;

  return {
    async listRuns(limit?: number): Promise<AgentRunListItem[]> {
      const runs = await runRepo.listRuns({ limit: Math.min(limit ?? 50, 200) });
      const items: AgentRunListItem[] = [];
      for (const run of runs) {
        const pending = (await approvals.list(run.id, { decision: "pending" })).length;
        items.push({
          id: run.id,
          goal: run.goal.slice(0, 120),
          status: run.status,
          ...(run.templateId ? { templateId: run.templateId } : {}),
          ...(run.workspaceKey ? { workspaceKey: run.workspaceKey } : {}),
          ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
          ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
          ...(run.errorCode ? { errorCode: run.errorCode } : {}),
          pendingApprovals: pending,
        });
      }
      // 未决审批的行置顶（审批面板的操作优先级）。
      return items.sort((a, b) => b.pendingApprovals - a.pendingApprovals);
    },

    async getRunDetail(runId): Promise<AgentRunDetail | null> {
      const run = await runRepo.getRun(runId);
      if (!run) return null;
      const pending = await approvals.list(runId, { decision: "pending" });
      const unfinished = await toolExecutions.listUnfinished(runId);
      return {
        run,
        pendingApprovals: pending.map(toApprovalCard),
        unfinishedToolExecutions: unfinished.map((entry) => ({
          id: entry.execution.id,
          toolId: entry.execution.toolId,
          status: entry.execution.status,
        })),
      };
    },

    async decideApproval(approvalId, decision, decisionDigest) {
      const outcome = await port.submitApproval(approvalId, decision, decisionDigest);
      if (outcome.status !== "accepted" && outcome.status !== "duplicate") {
        return {
          decided: false,
          decision,
          error: outcome.reasonCode ?? `submit_${outcome.status}`,
        };
      }
      const approval = await approvals.get(approvalId);
      return {
        decided: true,
        decision: approval?.decision ?? decision,
      };
    },

    async controlRun(runId, action) {
      if (action === "pause") {
        const receipt = await port.requestPause(runId);
        return {
          status: receipt.status,
          ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
        };
      }
      if (action === "resume") {
        const receipt = await port.resume(runId);
        return {
          status: receipt.status,
          ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
        };
      }
      const receipt = await port.cancel(runId, "user-cancel");
      return {
        status: receipt.status,
        ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
      };
    },
  };
}
