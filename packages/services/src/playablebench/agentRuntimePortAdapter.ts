// AgentRuntimePort 适配器（spec 05 §2 → V4 命令映射；docs/audit/V4-Port映射表.md）。
// 只调用 IZCodeAgentService 公开面，不改 runtime 内部（07 裁决 §3 阶段 3 行）。
// 状态权威在 RunRepo（持久化事实）；命令层只记录"请求已接受"事件，终态收敛由
// 事件映射（runtimeEventMapper）依据 V4 快照/增量完成，避免双写竞态。
// workspace 定位一律取 run 持久化字段（workspacePath/Identity），适配器无跨 run 状态。
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { PbApproval } from "@zcode/shared";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgent.js";
import { createHostCommandEnvelope } from "#src/zcode-agent/zcodeV4HostCommand.js";
import type { ApprovalRepo } from "#src/session/approvalRepo.js";
import type { RunRepo } from "#src/session/runRepo.js";
import type { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";
import type {
  AgentCommandReceipt,
  AgentRunDescriptor,
  AgentRunSnapshot,
  AgentRuntimePolicyContext,
  AgentToolDescriptor,
  IAgentRuntimePort,
  RuntimeHealth,
} from "#src/playablebench/agentRuntimePort.js";
import { computeOperationDigest } from "#src/playablebench/approvalDigest.js";
import { getToolPolicyEntry, listToolDescriptors } from "#src/playablebench/toolPolicy.js";

/** SR-02：PB run 默认禁 yolo/auto（workspace 默认 yolo，端口层显式收窄）。 */
const ALLOWED_RUN_PERMISSION_MODES = ["plan", "build", "edit", "guarded"] as const;

/** 适配器依赖的 agent 服务最小面（测试可注入 fake）。 */
export type AgentRuntimeAgentService = Pick<
  IZCodeAgentService,
  "createSession" | "sendConversationCommandV4"
>;

export interface AgentRuntimePortAdapterOptions {
  agentService: AgentRuntimeAgentService;
  runRepo: RunRepo;
  toolExecutions: ToolExecutionRepo;
  approvals: ApprovalRepo;
}

function receiptFromAck(runId: string, ack: CommandAck): AgentCommandReceipt {
  return {
    runId,
    commandId: ack.commandId,
    status: ack.status,
    reasonCode: ack.reasonCode ?? undefined,
  };
}

function rejectedReceipt(runId: string, reasonCode: string): AgentCommandReceipt {
  return { runId, status: "rejected", reasonCode };
}

export class AgentRuntimePortAdapter implements IAgentRuntimePort {
  // 已观察快照的 CAS revision（pauseGoal/resumeGoal 需要）；事件映射层更新。
  private readonly observedRevisions = new Map<string, { sessionId: string; revision: number }>();

  constructor(private readonly options: AgentRuntimePortAdapterOptions) {}

  /** 事件映射层（runtimeEventMapper）在观察到快照后登记 CAS revision。 */
  observeSnapshotRevision(runId: string, sessionId: string, revision: number): void {
    this.observedRevisions.set(runId, { sessionId, revision });
  }

  private workspaceTargetFor(run: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): ZCodeAgentWorkspaceTarget | null {
    if (!run.workspacePath) return null;
    return {
      workspacePath: run.workspacePath,
      ...(run.workspaceIdentity ? { workspaceIdentity: run.workspaceIdentity } : {}),
    };
  }

  async createRun(
    input: { goal: string; templateId?: string; templateVersion?: string; inputRef?: string },
    policyContext: AgentRuntimePolicyContext,
  ): Promise<AgentRunDescriptor> {
    if (!(ALLOWED_RUN_PERMISSION_MODES as readonly string[]).includes(policyContext.permissionMode)) {
      throw Object.assign(
        new Error(
          `SR-02：PB run 权限 mode 必须显式指定且默认禁 yolo/auto，收到 ${policyContext.permissionMode}`,
        ),
        { kind: "yolo_forbidden" },
      );
    }
    const run = await this.options.runRepo.createRun({
      goal: input.goal,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      inputRef: input.inputRef,
      permissionMode: policyContext.permissionMode,
      workspacePath: policyContext.workspacePath,
      workspaceKey: policyContext.workspaceIdentity ?? policyContext.workspacePath,
    });
    const acceptedAt = Date.now();
    try {
      const snapshot = await this.options.agentService.createSession({
        workspacePath: policyContext.workspacePath,
        ...(policyContext.workspaceIdentity
          ? { workspaceIdentity: policyContext.workspaceIdentity }
          : {}),
        mode: policyContext.permissionMode,
      });
      const sessionId = snapshot.session.sessionId;
      await this.options.runRepo.setRuntimeSession(run.id, sessionId);
      const transition = await this.options.runRepo.transitionRun(run.id, {
        from: run.status,
        to: "planning",
        eventId: `evt:${run.id}:session-created`,
        reason: "v4 createSession accepted",
      });
      const descriptorRun = transition.disposition === "applied" ? transition.run : run;
      return { runId: run.id, sessionId, status: descriptorRun.status, acceptedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.runRepo
        .transitionRun(run.id, {
          from: run.status,
          to: "failed",
          eventId: `evt:${run.id}:session-failed`,
          reason: message,
          eventType: "run.session.createFailed",
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async sendInput(runId: string, message: string, requestId?: string): Promise<AgentCommandReceipt> {
    const run = await this.options.runRepo.getRun(runId);
    if (!run?.runtimeSessionId) {
      return rejectedReceipt(runId, "run_has_no_session");
    }
    const target = this.workspaceTargetFor(run);
    if (!target) return rejectedReceipt(runId, "run_has_no_workspace");
    const commandId = requestId ?? `send:${runId}:${Date.now()}`;
    const envelope = createHostCommandEnvelope({
      sessionId: run.runtimeSessionId,
      type: "sendText",
      payload: { text: message, requestedDelivery: "startNow" },
      commandId,
    });
    const ack = await this.options.agentService.sendConversationCommandV4({ ...target, envelope });
    if (ack.status === "accepted" || ack.status === "duplicate") {
      await this.options.runRepo
        .appendRunEvent(runId, {
          eventId: `evt:${runId}:input:${commandId}`,
          eventType: "input.sent",
          payloadJson: JSON.stringify({ commandId, delivery: "startNow" }),
        })
        .catch(() => undefined);
    }
    return receiptFromAck(runId, ack);
  }

  async getRun(runId: string): Promise<AgentRunSnapshot | null> {
    const run = await this.options.runRepo.getRun(runId);
    if (!run) return null;
    const [pendingApprovals, unfinished, events] = await Promise.all([
      this.options.approvals.list(runId, { decision: "pending" }),
      this.options.toolExecutions.listUnfinished(runId),
      this.options.runRepo.listRunEvents(runId, { limit: 1000 }),
    ]);
    const eventsCursor = events.at(-1)?.sequence ?? 0;
    return {
      run,
      pendingApprovals,
      unfinishedToolExecutions: unfinished.map((u) => u.execution),
      eventsCursor,
    };
  }

  async requestPause(runId: string): Promise<AgentCommandReceipt> {
    return this.sendGoalCommand(runId, "pauseGoal", "pause_requires_snapshot");
  }

  async resume(runId: string): Promise<AgentCommandReceipt> {
    return this.sendGoalCommand(runId, "resumeGoal", "resume_requires_snapshot");
  }

  private async sendGoalCommand(
    runId: string,
    type: "pauseGoal" | "resumeGoal",
    noSnapshotReason: string,
  ): Promise<AgentCommandReceipt> {
    const run = await this.options.runRepo.getRun(runId);
    if (!run?.runtimeSessionId) {
      return rejectedReceipt(runId, "run_has_no_session");
    }
    const target = this.workspaceTargetFor(run);
    if (!target) return rejectedReceipt(runId, "run_has_no_workspace");
    const observed = this.observedRevisions.get(runId);
    if (!observed || observed.sessionId !== run.runtimeSessionId) {
      // 诚实语义：无快照 revision 时不发 CAS 命令，不假装已暂停/恢复。
      return rejectedReceipt(runId, noSnapshotReason);
    }
    const envelope = createHostCommandEnvelope({
      sessionId: run.runtimeSessionId,
      type,
      payload: {},
      baseRevision: observed.revision,
    });
    const ack = await this.options.agentService.sendConversationCommandV4({ ...target, envelope });
    if (ack.status === "accepted") {
      await this.options.runRepo
        .appendRunEvent(runId, {
          eventId: `evt:${runId}:${type}:${ack.commandId}`,
          eventType: `run.${type === "pauseGoal" ? "pauseRequested" : "resumeRequested"}`,
        })
        .catch(() => undefined);
    }
    return receiptFromAck(runId, ack);
  }

  async cancel(runId: string, reason?: string): Promise<AgentCommandReceipt> {
    const run = await this.options.runRepo.getRun(runId);
    if (!run?.runtimeSessionId) {
      return rejectedReceipt(runId, "run_has_no_session");
    }
    const target = this.workspaceTargetFor(run);
    if (!target) return rejectedReceipt(runId, "run_has_no_workspace");
    const envelope = createHostCommandEnvelope({
      sessionId: run.runtimeSessionId,
      type: "stop",
      payload: {},
    });
    const ack = await this.options.agentService.sendConversationCommandV4({ ...target, envelope });
    if (ack.status === "accepted" || ack.status === "duplicate") {
      await this.options.runRepo
        .appendRunEvent(runId, {
          eventId: `evt:${runId}:cancel-requested:${ack.commandId}`,
          eventType: "run.cancelRequested",
          payloadJson: reason ? JSON.stringify({ reason }) : undefined,
        })
        .catch(() => undefined);
    }
    return receiptFromAck(runId, ack);
  }

  async submitApproval(
    approvalId: string,
    decision: "approved" | "denied",
    decisionDigest?: string,
  ): Promise<AgentCommandReceipt> {
    const approval = await this.options.approvals.get(approvalId);
    if (!approval) {
      return rejectedReceipt(approvalId, "approval_not_found");
    }
    const runId = approval.runId;
    if (approval.decision !== "pending") {
      return rejectedReceipt(runId, "approval_already_decided");
    }
    // digest 绑定（spec 05 §3）：决策方携带其看到的操作摘要；与建档 digest
    // 不一致说明参数/目标已变化，原审批失效需重新审批，不转发旧决策。
    if (decisionDigest === undefined || decisionDigest !== approval.operationDigest) {
      return rejectedReceipt(runId, "approval_digest_mismatch");
    }
    const run = await this.options.runRepo.getRun(runId);
    if (!run?.runtimeSessionId || !approval.interactionId) {
      return rejectedReceipt(runId, "approval_has_no_interaction");
    }
    if (approval.expiresAt !== undefined && approval.expiresAt < Date.now()) {
      await this.options.approvals.decide(approvalId, "expired", { revokeReason: "expired_on_submit" });
      return rejectedReceipt(runId, "approval_expired");
    }
    const target = this.workspaceTargetFor(run);
    if (!target) return rejectedReceipt(runId, "run_has_no_workspace");
    const envelope = createHostCommandEnvelope({
      sessionId: run.runtimeSessionId,
      type: "resolveInteraction",
      payload: {
        interactionId: approval.interactionId,
        answer: decision === "approved" ? { action: "accept" } : { action: "decline" },
      },
    });
    const ack = await this.options.agentService.sendConversationCommandV4({ ...target, envelope });
    // noop/duplicate = 先到先得语义下已收口（spec 05 §9 重复命令）；决策记录单向收敛。
    if (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate") {
      await this.options.approvals.decide(approvalId, decision, { decidedBy: "agent-runtime-port" });
    }
    return receiptFromAck(runId, ack);
  }

  async recordPendingApproval(params: {
    runId: string;
    toolId: string;
    toolCallId?: string;
    input?: unknown;
    target?: string;
    interactionId?: string;
    riskSummary?: string;
    expiresAt?: number;
  }): Promise<PbApproval> {
    const digest = computeOperationDigest({
      toolId: params.toolId,
      ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      ...(params.input !== undefined ? { input: params.input } : {}),
      ...(params.target ? { target: params.target } : {}),
    });
    const execution = await this.options.toolExecutions.create({
      runId: params.runId,
      toolId: params.toolId,
      ...(params.toolCallId ? { idempotencyKey: params.toolCallId } : {}),
      inputDigest: digest,
    });
    const risk = getToolPolicyEntry(params.toolId);
    return this.options.approvals.create({
      runId: params.runId,
      toolExecutionId: execution.id,
      ...(params.interactionId ? { interactionId: params.interactionId } : {}),
      operationDigest: digest,
      requestJson: JSON.stringify({
        toolId: params.toolId,
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        ...(params.input !== undefined ? { input: params.input } : {}),
        ...(params.target ? { target: params.target } : {}),
      }),
      riskLevel: risk.riskLevel,
      ...(params.riskSummary ? { riskSummary: params.riskSummary } : {}),
      ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
    });
  }

  async listAvailableTools(runId: string): Promise<AgentToolDescriptor[]> {
    const run = await this.options.runRepo.getRun(runId);
    if (!run) return [];
    // 产品策略侧投影（spec 05 §4）：风险分级来自 toolPolicy 静态声明，模型不可改。
    return listToolDescriptors();
  }

  async health(): Promise<RuntimeHealth> {
    return { healthy: true, detail: "agent runtime port adapter ready" };
  }
}

/** 工厂：组装端口与持久化仓库（Host 侧调用；不进 renderer barrel）。 */
export function createAgentRuntimePort(options: AgentRuntimePortAdapterOptions): IAgentRuntimePort {
  return new AgentRuntimePortAdapter(options);
}
