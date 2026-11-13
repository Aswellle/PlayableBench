// AgentRuntimePort 适配器合约测试（spec 05 §2/§9、docs/audit/V4-Port映射表.md）。
// fake runtime 只实现适配器依赖的最小面（createSession/sendConversationCommandV4），
// 断言：ACK 语义透传、事件确定性 eventId、SR-02 禁 yolo、审批过期路径、
// 命令层不抢跳 run 状态（终态由事件映射收敛）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope, ZCodeSessionStateSnapshot } from "@zcode/shared";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { createAgentRuntimePort } from "#src/playablebench/agentRuntimePortAdapter.js";
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

interface RecordedCommand {
  envelope: CommandEnvelope;
  workspacePath: string;
}

function makeHarness(options?: {
  createSessionError?: Error;
  ackFor?: (envelope: CommandEnvelope) => CommandAck;
}) {
  const dir = mkdtempSync(join(tmpdir(), "zcode-agent-port-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  const runRepo = new RunRepo(connection);
  const toolExecutions = new ToolExecutionRepo(connection);
  const approvals = new ApprovalRepo(connection);
  const sent: RecordedCommand[] = [];
  const agentService: AgentRuntimeAgentService = {
    createSession: options?.createSessionError
      ? vi.fn().mockRejectedValue(options.createSessionError)
      : vi.fn().mockImplementation(async () => {
          return {
            session: { sessionId: `sess-${sent.length + 1}` },
          } as unknown as ZCodeSessionStateSnapshot;
        }),
    sendConversationCommandV4: vi.fn().mockImplementation(async (params) => {
      sent.push({ envelope: params.envelope, workspacePath: params.workspacePath });
      const ack = options?.ackFor?.(params.envelope);
      if (ack) return ack;
      return { status: "accepted", commandId: params.envelope.commandId } as CommandAck;
    }),
  };
  const port = createAgentRuntimePort({ agentService, runRepo, toolExecutions, approvals });
  return { port, runRepo, approvals, toolExecutions, sent, agentService };
}

const policy = { permissionMode: "build" as const, workspacePath: "/tmp/ws-a" };

describe("AgentRuntimePort 命令映射", () => {
  it("createRun 建档、绑定会话并推进 queued→planning；SR-02 拒绝 yolo/auto", async () => {
    const { port, runRepo, agentService } = makeHarness();
    const descriptor = await port.createRun({ goal: "整理资料" }, policy);
    expect(descriptor.status).toBe("planning");
    expect(descriptor.sessionId).toBe("sess-1");
    const run = await runRepo.getRun(descriptor.runId);
    expect(run?.permissionMode).toBe("build");
    expect(run?.runtimeSessionId).toBe("sess-1");
    expect(agentService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/tmp/ws-a", mode: "build" }),
    );

    for (const forbidden of ["yolo", "auto"] as const) {
      await expect(
        port.createRun({ goal: "目标" }, { ...policy, permissionMode: forbidden }),
      ).rejects.toMatchObject({ kind: "yolo_forbidden" });
    }
  });

  it("createSession 失败时 run 落 failed 并保留错误码，不把已发出当成功", async () => {
    const { port, runRepo } = makeHarness({
      createSessionError: new Error("agent spawn failed"),
    });
    await expect(port.createRun({ goal: "目标" }, policy)).rejects.toThrow("agent spawn failed");
    const runs = await runRepo.listRuns({ workspaceKey: "/tmp/ws-a" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.errorCode).toBe("agent spawn failed");
    expect(runs[0]?.finishedAt).toBeGreaterThan(0);
  });

  it("sendInput 透传 ACK；accepted 记录确定性事件且 requestId 幂等；rejected 不记录", async () => {
    const { port, runRepo } = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    const receipt = await port.sendInput(descriptor.runId, "开始整理", "req-1");
    expect(receipt.status).toBe("accepted");
    expect(receipt.commandId).toBe("req-1");
    const inputEvents = (await runRepo.listRunEvents(descriptor.runId)).filter(
      (e) => e.eventType === "input.sent",
    );
    expect(inputEvents.map((e) => e.eventId)).toEqual([`evt:${descriptor.runId}:input:req-1`]);

    // requestId 幂等：同 id 重试得到同 receipt，事件去重只落一条。
    const retry = await port.sendInput(descriptor.runId, "开始整理", "req-1");
    expect(retry.status).toBe("accepted");
    const inputEventsAfterRetry = (await runRepo.listRunEvents(descriptor.runId)).filter(
      (e) => e.eventType === "input.sent",
    );
    expect(inputEventsAfterRetry).toHaveLength(1);

    const rejected = await port.sendInput("run-missing", "x");
    expect(rejected).toMatchObject({ status: "rejected", reasonCode: "run_has_no_session" });
  });

  it("cancel 透传 stop；命令层不抢跳终态（仍由事件映射收敛）", async () => {
    const { port, runRepo, sent } = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    const receipt = await port.cancel(descriptor.runId, "用户取消");
    expect(receipt.status).toBe("accepted");
    expect(sent[0]?.envelope.type).toBe("stop");
    expect(sent[0]?.envelope.sessionId).toBe("sess-1");
    const run = await runRepo.getRun(descriptor.runId);
    // 命令层只记录 cancelRequested 事件；状态仍 planning（映射层观察 stopState 收敛）。
    expect(run?.status).toBe("planning");
    const events = await runRepo.listRunEvents(descriptor.runId);
    expect(events.some((e) => e.eventType === "run.cancelRequested")).toBe(true);
  });

  it("pause/resume 无快照 revision 时诚实拒绝，不假装已暂停", async () => {
    const { port, sent } = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    const paused = await port.requestPause(descriptor.runId);
    expect(paused).toMatchObject({ status: "rejected", reasonCode: "pause_requires_snapshot" });
    expect(sent).toHaveLength(0);
    const resumed = await port.resume(descriptor.runId);
    expect(resumed).toMatchObject({ status: "rejected", reasonCode: "resume_requires_snapshot" });
  });

  it("观察到快照 revision 后 pause/resume 以 CAS 信封发出", async () => {
    const { port, sent } = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    port.observeSnapshotRevision(descriptor.runId, "sess-1", 42);
    const paused = await port.requestPause(descriptor.runId);
    expect(paused.status).toBe("accepted");
    expect(sent.at(-1)?.envelope).toMatchObject({ type: "pauseGoal", baseRevision: 42 });
    const resumed = await port.resume(descriptor.runId);
    expect(resumed.status).toBe("accepted");
    expect(sent.at(-1)?.envelope).toMatchObject({ type: "resumeGoal" });
  });

  it("submitApproval：过期/重复决策拒绝，resolveInteraction 映射与单向收敛", async () => {
    const { port, approvals, runRepo, sent } = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    await runRepo.transitionRun(descriptor.runId, {
      from: "planning",
      to: "waiting_approval",
      eventId: "evt-wa",
    });
    const approval = await approvals.create({
      runId: descriptor.runId,
      interactionId: "ia-1",
      operationDigest: "digest-1",
      requestJson: '{"tool":"bash"}',
      riskLevel: "high",
    });
    const decided = await port.submitApproval(approval.id, "approved");
    expect(decided.status).toBe("accepted");
    expect(sent.at(-1)?.envelope.type).toBe("resolveInteraction");
    expect(sent.at(-1)?.envelope.payload).toMatchObject({
      interactionId: "ia-1",
      answer: { action: "accept" },
    });
    expect((await approvals.get(approval.id))?.decision).toBe("approved");

    // 重复决策被拒（单向收敛），不再转发 resolveInteraction。
    const again = await port.submitApproval(approval.id, "denied");
    expect(again).toMatchObject({ status: "rejected", reasonCode: "approval_already_decided" });
    expect(sent.filter((c) => c.envelope.type === "resolveInteraction")).toHaveLength(1);

    // 过期审批：标记 expired 并拒绝转发。
    const expiring = await approvals.create({
      runId: descriptor.runId,
      interactionId: "ia-2",
      operationDigest: "digest-2",
      requestJson: "{}",
      expiresAt: Date.now() - 1,
    });
    const expiredReceipt = await port.submitApproval(expiring.id, "approved");
    expect(expiredReceipt).toMatchObject({ status: "rejected", reasonCode: "approval_expired" });
    expect((await approvals.get(expiring.id))?.decision).toBe("expired");
    expect(sent.filter((c) => c.envelope.type === "resolveInteraction")).toHaveLength(1);
  });

  it("getRun 聚合持久化事实与事件 cursor", async () => {
    const { port, runRepo, toolExecutions } = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    await runRepo.transitionRun(descriptor.runId, { from: "planning", to: "running", eventId: "evt-r" });
    await toolExecutions.create({ runId: descriptor.runId, toolId: "bash", idempotencyKey: "k1" });
    const snapshot = await port.getRun(descriptor.runId);
    expect(snapshot?.run.status).toBe("running");
    expect(snapshot?.unfinishedToolExecutions).toHaveLength(1);
    expect(snapshot?.eventsCursor).toBeGreaterThan(1);
    expect(await port.getRun("missing")).toBeNull();
  });
});
