// Harness 应用层合约测试（spec 05 §9 矩阵的端口层覆盖；spec 16 Phase 3 门禁）。
// 端口 + 事件映射器 + 三仓库全链路，fake runtime 只回 ACK：
// 全生命周期（create→running→waiting_approval→审批 digest→running→completed）、
// 帧重复投递无重复副作用、崩溃恢复扫描 → needs_reconciliation → 人工决策收尾。
// 上游 runtime 内部行为（超时/上下文超限/模型失效/恶意输出）由上游自有测试承担
// （07 裁决：保留 harness 不改）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope, ZCodeSessionStateSnapshot } from "@zcode/shared";
import {
  conversationSnapshotSchema,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { createAgentRuntimePort } from "#src/playablebench/agentRuntimePortAdapter.js";
import { RuntimeEventMapper } from "#src/playablebench/runtimeEventMapper.js";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";
import type { AgentRuntimeAgentService } from "#src/playablebench/agentRuntimePortAdapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows 句柄释放延迟交给系统清理。
      }
    }
  }
});

function makeSnapshot(overrides?: {
  phase?: ConversationSnapshot["control"]["phase"];
  revision?: number;
  pendingInteractions?: ConversationSnapshot["pendingInteractions"];
  toolRows?: ConversationSnapshot["rows"]["window"];
}): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: "sess-1",
    logEpoch: "le-1",
    seq: 1,
    revision: overrides?.revision ?? 1,
    control: {
      phase: overrides?.phase ?? "running",
      sessionEnded: false,
      canStop: true,
      stopState: "idle",
      stopTargetKind: "assistant",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: true },
    },
    inputRouting: { mode: "startNow" },
    config: { provider: "zcode", model: "glm", thought: "high", followupMode: "queue" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: false },
    pendingInteractions: overrides?.pendingInteractions ?? [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: {
      window: overrides?.toolRows ?? [],
      totalCount: overrides?.toolRows?.length ?? 0,
      firstRowId: null,
    },
  });
}

const permissionInteraction = {
  interactionId: "ia-1",
  kind: "permission" as const,
  anchorRowId: 1,
  createdAt: 1,
  payload: {
    kind: "permission" as const,
    toolCallId: "tc-1",
    toolName: "Bash",
    summary: "运行构建脚本",
    detail: "pnpm build",
    options: [
      { optionId: "allow", label: "允许", kind: "allowOnce" as const },
      { optionId: "deny", label: "拒绝", kind: "deny" as const },
    ],
  },
};

const pendingBashRow = {
  rowId: 1,
  turnId: "turn-1",
  createdAt: 1,
  createdAtSeq: 1,
  kind: "toolCall" as const,
  toolCallId: "tc-1",
  toolName: "Bash",
  status: "pendingApproval" as const,
  inputText: "pnpm build",
  input: { cmd: "pnpm build" },
  approvalInteractionId: "ia-1",
  startedAt: 1,
};

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-runtime-contract-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  const runRepo = new RunRepo(connection);
  const toolExecutions = new ToolExecutionRepo(connection);
  const approvals = new ApprovalRepo(connection);
  const agentService: AgentRuntimeAgentService = {
    createSession: vi.fn().mockImplementation(async () => {
      return { session: { sessionId: "sess-1" } } as unknown as ZCodeSessionStateSnapshot;
    }),
    sendConversationCommandV4: vi.fn().mockImplementation(async (params: { envelope: CommandEnvelope }) => {
      return { status: "accepted", commandId: params.envelope.commandId } as CommandAck;
    }),
  };
  const port = createAgentRuntimePort({ agentService, runRepo, toolExecutions, approvals });
  const mapper = new RuntimeEventMapper({
    runRepo,
    toolExecutions,
    approvals,
    onSnapshotRevision: (runId, sessionId, revision) =>
      (port as unknown as { observeSnapshotRevision: (r: string, s: string, v: number) => void }).observeSnapshotRevision(
        runId,
        sessionId,
        revision,
      ),
  });
  return { port, mapper, runRepo, toolExecutions, approvals, connection };
}

const policy = { permissionMode: "build" as const, workspacePath: "/tmp/ws-a" };

describe("Harness 应用层合约（spec 05 §9 端口层）", () => {
  it("全生命周期：建档→运行→等待审批→digest 审批→完成；事件有序且终态收敛", async () => {
    const { port, mapper, runRepo, approvals, toolExecutions } = makeHarness();
    const descriptor = await port.createRun({ goal: "构建项目" }, policy);
    expect(descriptor.status).toBe("planning");

    await mapper.applySnapshot("sess-1", makeSnapshot({ revision: 1 }));
    expect((await runRepo.getRun(descriptor.runId))?.status).toBe("running");

    await mapper.applySnapshot("sess-1", makeSnapshot({ revision: 2, pendingInteractions: [permissionInteraction], toolRows: [pendingBashRow] }));
    const waiting = await runRepo.getRun(descriptor.runId);
    expect(waiting?.status).toBe("waiting_approval");
    const approval = await approvals.findByInteractionId("ia-1");
    expect(approval).not.toBeNull();

    // 命令层受理输入（重复命令幂等由 requestId 承担）。
    const inputReceipt = await port.sendInput(descriptor.runId, "继续", "req-1");
    expect(inputReceipt.status).toBe("accepted");

    const decided = await port.submitApproval(approval!.id, "approved", approval!.operationDigest);
    expect(decided.status).toBe("accepted");
    expect((await approvals.get(approval!.id))?.decision).toBe("approved");

    // 审批清空快照：覆盖态回到 running；工具成功行确认副作用。
    await mapper.applySnapshot("sess-1", makeSnapshot({
      revision: 3,
      toolRows: [{ ...pendingBashRow, status: "success" as const, endedAt: 5 }],
    }));
    expect((await runRepo.getRun(descriptor.runId))?.status).toBe("running");

    await mapper.applySnapshot("sess-1", makeSnapshot({ phase: "completedSuccess", revision: 4 }));
    const finished = await runRepo.getRun(descriptor.runId);
    expect(finished?.status).toBe("completed");
    expect(finished?.finishedAt).toBeGreaterThan(0);

    const events = await runRepo.listRunEvents(descriptor.runId);
    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(await toolExecutions.listUnfinished(descriptor.runId)).toHaveLength(0);
  });

  it("崩溃与重复投递：整轮帧重放不产生重复副作用或重复迁移", async () => {
    const { port, mapper, runRepo, approvals, toolExecutions } = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    const frames = [
      makeSnapshot({ revision: 1 }),
      makeSnapshot({ revision: 2, pendingInteractions: [permissionInteraction], toolRows: [pendingBashRow] }),
    ];
    for (const frame of frames) {
      await mapper.applySnapshot("sess-1", frame);
      await mapper.applySnapshot("sess-1", frame); // 每帧都投递两次（重连重放模拟）
    }
    expect((await approvals.list(descriptor.runId)).length).toBe(1);
    expect((await toolExecutions.list(descriptor.runId)).length).toBe(1);
    const transitionEvents = (await runRepo.listRunEvents(descriptor.runId)).filter(
      (e) => e.eventType.startsWith("run.status."),
    );
    // queued→planning（建档）+ running + waiting_approval；重放不追加迁移。
    expect(transitionEvents.map((e) => e.eventType)).toEqual([
      "run.status.planning",
      "run.status.running",
      "run.status.waiting_approval",
    ]);
    expect(await runRepo.getRun(descriptor.runId)).toMatchObject({ status: "waiting_approval" });
  });

  it("崩溃恢复：未完成工具执行扫描 → needs_reconciliation → 禁止直接重跑 → 人工决策收尾", async () => {
    const { port, mapper, runRepo, toolExecutions } = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    await mapper.applySnapshot("sess-1", makeSnapshot({ revision: 1 }));
    // 进程崩溃前的在飞工具调用：pending 且副作用未知。
    await toolExecutions.create({ runId: descriptor.runId, toolId: "Bash", idempotencyKey: "tc-crash" });

    // 中断相位：进程/环境中断，可否续跑未定（spec 05 §3）。
    await mapper.applySnapshot("sess-1", makeSnapshot({ phase: "completedInterrupted", revision: 2 }));
    const interrupted = await runRepo.getRun(descriptor.runId);
    expect(interrupted?.status).toBe("interrupted");

    // 恢复扫描发现结果不可查的执行 → needs_reconciliation（spec 05 §6）。
    const unfinished = await toolExecutions.listUnfinished(descriptor.runId);
    expect(unfinished.map((u) => u.execution.idempotencyKey)).toEqual(["tc-crash"]);
    await runRepo.transitionRun(descriptor.runId, {
      from: "interrupted",
      to: "needs_reconciliation",
      eventId: "evt:recon",
      reason: "崩溃恢复扫描发现未确定副作用",
    });
    expect((await runRepo.getRun(descriptor.runId))?.status).toBe("needs_reconciliation");

    // 禁止直接重跑（spec 05 §3：needs_reconciliation 不允许重放副作用）。
    await expect(
      port.sendInput(descriptor.runId, "重跑一次"),
    ).resolves.toMatchObject({ status: "accepted" }); // 输入受理与状态机解耦
    await expect(
      runRepo.transitionRun(descriptor.runId, { from: "needs_reconciliation", to: "running", eventId: "evt:rerun" }),
    ).rejects.toMatchObject({ kind: "illegal_run_transition" });

    // 人工决策收尾。
    const decided = await runRepo.transitionRun(descriptor.runId, {
      from: "needs_reconciliation",
      to: "cancelled",
      eventId: "evt:human-decision",
      reason: "人工决策放弃该副作用",
    });
    expect(decided.run.status).toBe("cancelled");
  });

  it("审批过期后提交被拒且转发被阻止（spec 05 §9 审批过期）", async () => {
    const { port, mapper, runRepo, approvals } = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    await mapper.applySnapshot("sess-1", makeSnapshot({ revision: 1, pendingInteractions: [permissionInteraction], toolRows: [pendingBashRow] }));
    const approval = await approvals.findByInteractionId("ia-1");
    // 直接把记录改为已过期（到期扫描同语义）。
    await approvals.decide(approval!.id, "expired", { revokeReason: "expired" });
    const receipt = await port.submitApproval(approval!.id, "approved", approval!.operationDigest);
    expect(receipt).toMatchObject({ status: "rejected", reasonCode: "approval_already_decided" });
  });
});
