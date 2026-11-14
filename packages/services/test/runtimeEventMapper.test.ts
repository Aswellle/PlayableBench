// V4 事件映射器测试：快照/增量 → Run 状态迁移、审批建档（幂等）、工具执行推进。
// 用真实 zod schema 构造帧（conversationSnapshotSchema.parse 校验形状），
// 重复投递由 (run_id, event_id) 幂等吸收（spec 16 门禁：重复事件不产生重复副作用）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  conversationSnapshotSchema,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { RuntimeEventMapper } from "#src/playablebench/runtimeEventMapper.js";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

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

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-event-mapper-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  const runRepo = new RunRepo(connection);
  const toolExecutions = new ToolExecutionRepo(connection);
  const approvals = new ApprovalRepo(connection);
  const revisions: Array<{ runId: string; sessionId: string; revision: number }> = [];
  const mapper = new RuntimeEventMapper({
    runRepo,
    toolExecutions,
    approvals,
    onSnapshotRevision: (runId, sessionId, revision) => revisions.push({ runId, sessionId, revision }),
  });
  return { mapper, runRepo, toolExecutions, approvals, revisions, connection };
}

function makeSnapshot(overrides?: {
  sessionId?: string;
  phase?: ConversationSnapshot["control"]["phase"];
  revision?: number;
  pendingInteractions?: ConversationSnapshot["pendingInteractions"];
  toolRows?: ConversationSnapshot["rows"]["window"];
}): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: overrides?.sessionId ?? "sess-1",
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
    rows: { window: overrides?.toolRows ?? [], totalCount: overrides?.toolRows?.length ?? 0, firstRowId: null },
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
    summary: "运行删除脚本",
    detail: "rm -rf build",
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
  inputText: "rm -rf build",
  input: { cmd: "rm -rf build" },
  approvalInteractionId: "ia-1",
  startedAt: 1,
};

describe("RuntimeEventMapper", () => {
  it("非 PB 会话跳过；PB run 相位迁移 + revision 回调", async () => {
    const { mapper, runRepo, revisions } = makeStore();
    // 未注册会话：不产生任何迁移。
    const stranger = await mapper.applySnapshot("sess-stranger", makeSnapshot({ sessionId: "sess-stranger" }));
    expect(stranger.applied).toHaveLength(0);

    const run = await runRepo.createRun({ goal: "目标" });
    await runRepo.setRuntimeSession(run.id, "sess-1");
    await runRepo.transitionRun(run.id, { from: "queued", to: "planning", eventId: "evt-created" });

    const outcome = await mapper.applySnapshot("sess-1", makeSnapshot({ revision: 7 }));
    expect(outcome.errors).toEqual([]);
    expect(outcome.applied.some((a) => a.disposition === "applied")).toBe(true);
    const updated = await runRepo.getRun(run.id);
    expect(updated?.status).toBe("running");
    expect(revisions).toEqual([{ runId: run.id, sessionId: "sess-1", revision: 7 }]);
  });

  it("permission 交互：审批建档（digest 绑定）+ waiting_approval；重复投递幂等", async () => {
    const { mapper, runRepo, approvals, toolExecutions } = makeStore();
    const run = await runRepo.createRun({ goal: "目标" });
    await runRepo.setRuntimeSession(run.id, "sess-1");
    await runRepo.transitionRun(run.id, { from: "queued", to: "running", eventId: "evt-r" });

    const snapshot = makeSnapshot({ pendingInteractions: [permissionInteraction], toolRows: [pendingBashRow] });
    const first = await mapper.applySnapshot("sess-1", snapshot);
    expect(first.errors).toEqual([]);
    const afterFirst = await runRepo.getRun(run.id);
    expect(afterFirst?.status).toBe("waiting_approval");
    const approval = await approvals.findByInteractionId("ia-1");
    expect(approval?.decision).toBe("pending");
    expect(approval?.riskLevel).toBe("high");
    const execution = await toolExecutions.findByIdempotencyKey("tc-1");
    expect(execution?.status).toBe("pending");
    expect(execution?.inputDigest).toBe(approval?.operationDigest);

    // 重放同一快照：interactionId/幂等键吸收，不产生第二条审批或执行。
    const replay = await mapper.applySnapshot("sess-1", { ...snapshot, revision: snapshot.revision + 1 });
    expect(replay.errors).toEqual([]);
    expect((await approvals.list(run.id)).length).toBe(1);
    expect((await toolExecutions.list(run.id)).length).toBe(1);
    // waiting_approval → running 不因重放抢跳（快照仍带 pending interaction）。
    expect((await runRepo.getRun(run.id))?.status).toBe("waiting_approval");
  });

  it("交互清空后 waiting_approval → running；error 相位 → failed 记录 errorCode", async () => {
    const { mapper, runRepo, approvals } = makeStore();
    const run = await runRepo.createRun({ goal: "目标" });
    await runRepo.setRuntimeSession(run.id, "sess-1");
    await runRepo.transitionRun(run.id, { from: "queued", to: "running", eventId: "evt-r" });
    await mapper.applySnapshot("sess-1", makeSnapshot({ pendingInteractions: [permissionInteraction], toolRows: [pendingBashRow] }));
    await mapper.applySnapshot("sess-1", makeSnapshot({ revision: 9 }));
    expect((await runRepo.getRun(run.id))?.status).toBe("running");
    expect(await approvals.findByInteractionId("ia-1")).not.toBeNull();

    const errorFrame = makeSnapshot({ phase: "error", revision: 10 });
    await mapper.applySnapshot("sess-1", errorFrame);
    const failed = await runRepo.getRun(run.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.finishedAt).toBeGreaterThan(0);
  });

  it("toolCall 行终态推进工具执行：success 确认副作用，error 记录摘要", async () => {
    const { mapper, runRepo, toolExecutions } = makeStore();
    const run = await runRepo.createRun({ goal: "目标" });
    await runRepo.setRuntimeSession(run.id, "sess-1");
    await runRepo.transitionRun(run.id, { from: "queued", to: "running", eventId: "evt-r" });

    const successRow = {
      rowId: 2,
      turnId: "turn-2",
      createdAt: 2,
      createdAtSeq: 2,
      kind: "toolCall" as const,
      toolCallId: "tc-2",
      toolName: "Edit",
      status: "success" as const,
      inputText: "edit",
      startedAt: 1,
      endedAt: 2,
    };
    await mapper.applySnapshot("sess-1", makeSnapshot({ toolRows: [successRow], revision: 3 }));
    const done = await toolExecutions.findByIdempotencyKey("tc-2");
    expect(done?.status).toBe("success");
    expect(done?.sideEffectState).toBe("confirmed");

    const errorRow = { ...successRow, rowId: 3, toolCallId: "tc-3", status: "error" as const, error: { code: "tool_failed", message: "写入失败" } };
    await mapper.applySnapshot("sess-1", makeSnapshot({ toolRows: [errorRow], revision: 4 }));
    const failedExec = await toolExecutions.findByIdempotencyKey("tc-3");
    expect(failedExec?.status).toBe("failed");
    expect(failedExec?.errorSummary).toContain("写入失败");
    // 未完成扫描不再包含已确认成功项。
    const unfinished = await toolExecutions.listUnfinished(run.id);
    expect(unfinished.map((u) => u.execution.id)).not.toContain(done?.id);
  });

  it("增量帧：state.updated control 迁移 + toolCall upsert 推进", async () => {
    const { mapper, runRepo, toolExecutions } = makeStore();
    const run = await runRepo.createRun({ goal: "目标" });
    await runRepo.setRuntimeSession(run.id, "sess-1");

    await mapper.applyDeltas("sess-1", [
      { op: "state.updated", patch: { control: { phase: "running", sessionEnded: false, canStop: true, stopState: "idle", stopTargetKind: "assistant", activeWorks: [], lastError: null, apiRetry: null } } },
    ], { frameSeq: 1 });
    expect((await runRepo.getRun(run.id))?.status).toBe("running");

    await mapper.applyDeltas("sess-1", [
      { op: "row.upserted", row: { ...pendingBashRow, rowId: 5, turnId: "turn-3", createdAt: 3, createdAtSeq: 3, status: "success" as const, endedAt: 9 } },
    ], { frameSeq: 2 });
    const execution = await toolExecutions.findByIdempotencyKey("tc-1");
    expect(execution?.status).toBe("success");
    expect(execution?.sideEffectState).toBe("confirmed");
  });

  it("非法跳转记入 errors 不抛出（queued→completed 不得落库）", async () => {
    const { mapper, runRepo } = makeStore();
    const run = await runRepo.createRun({ goal: "目标" });
    await runRepo.setRuntimeSession(run.id, "sess-1");
    const outcome = await mapper.applySnapshot("sess-1", makeSnapshot({ phase: "completedSuccess" }));
    expect(outcome.errors.some((e) => e.includes("illegal transition"))).toBe(true);
    expect((await runRepo.getRun(run.id))?.status).toBe("queued");
  });

  it("assistantText 完成态捕获 message.final（限长）；重放幂等；流式/空文本不落", async () => {
    const { mapper, runRepo } = makeStore();
    const run = await runRepo.createRun({ goal: "目标" });
    await runRepo.setRuntimeSession(run.id, "sess-1");
    const longText = "结论。引用 https://example.com/src。".padEnd(9000, "尾");
    const assistantRow = {
      rowId: 7,
      turnId: "turn-9",
      createdAt: 9,
      createdAtSeq: 9,
      kind: "assistantText" as const,
      text: longText,
      state: "complete" as const,
      model: "glm-test",
    };
    await mapper.applySnapshot("sess-1", makeSnapshot({ toolRows: [assistantRow] }));
    let events = await runRepo.listRunEvents(run.id, { limit: 50 });
    const final = events.filter((e) => e.eventType === "message.final");
    expect(final).toHaveLength(1);
    const payload = JSON.parse(final[0]?.payloadJson ?? "{}") as { text: string; model: string };
    expect(payload.text.startsWith("结论。")).toBe(true);
    expect(payload.text.endsWith("…[截断]")).toBe(true);
    expect(payload.model).toBe("glm-test");

    // 重放同快照：确定性 eventId 幂等吸收，不产生第二条。
    await mapper.applySnapshot("sess-1", makeSnapshot({ toolRows: [assistantRow] }));
    events = await runRepo.listRunEvents(run.id, { limit: 50 });
    expect(events.filter((e) => e.eventType === "message.final")).toHaveLength(1);

    // 流式行与空文本不落事件。
    await mapper.applyDeltas("sess-1", [
      { op: "row.appended", row: { ...assistantRow, rowId: 8, text: "半截", state: "streaming" as const } },
      { op: "row.appended", row: { ...assistantRow, rowId: 9, text: "", state: "complete" as const } },
    ], { frameSeq: 1 });
    events = await runRepo.listRunEvents(run.id, { limit: 50 });
    expect(events.filter((e) => e.eventType === "message.final")).toHaveLength(1);
  });
});
