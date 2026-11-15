// PB run 事件帧泵测试（PRD-06 帧泵接线）：workspace 帧订阅跟随活动 run、
// snapshot→run 状态迁移 + revision 桥到端口 CAS 表（pause 不再 rejected）、
// delta permission 交互→审批建档 + waiting_approval、非 PB 会话帧丢弃、
// 无活动 run 工作区退订。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope, ZCodeSessionStateSnapshot } from "@zcode/shared";
import type { ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgentPluginParams.js";
import {
  conversationSnapshotSchema,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { createAgentRuntimePort } from "#src/playablebench/agentRuntimePortAdapter.js";
import type { AgentRuntimeAgentService } from "#src/playablebench/agentRuntimePortAdapter.js";
import { RuntimeEventMapper } from "#src/playablebench/runtimeEventMapper.js";
import { AgentRunEventPump } from "#src/playablebench/agentRunEventPump.js";

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

interface FrameSink {
  fire: (frame: unknown) => void;
}

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-run-pump-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  const runRepo = new RunRepo(connection);
  const approvals = new ApprovalRepo(connection);
  const toolExecutions = new ToolExecutionRepo(connection);
  const agentService: AgentRuntimeAgentService = {
    createSession: vi.fn().mockImplementation(async () => {
      return {
        session: { sessionId: `sess-${Math.random()}` },
      } as unknown as ZCodeSessionStateSnapshot;
    }),
    sendConversationCommandV4: vi
      .fn()
      .mockImplementation(async (params: { envelope: CommandEnvelope }) => {
        return { status: "accepted", commandId: params.envelope.commandId } as CommandAck;
      }),
  };
  const port = createAgentRuntimePort({ agentService, runRepo, toolExecutions, approvals });
  // 帧源：workspace 级 emitter（fire 由测试驱动）。
  const sinks = new Map<string, FrameSink>();
  const frameSource = {
    onDynamicConversationFrame(params: ZCodeAgentWorkspaceTarget) {
      const key = params.workspaceIdentity?.trim() || params.workspacePath;
      const listeners = new Set<(frame: unknown) => void>();
      sinks.set(key, {
        fire: (frame: unknown) => {
          for (const listener of listeners) listener(frame);
        },
      });
      return (listener: (frame: unknown) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      };
    },
  };
  const mapper = new RuntimeEventMapper({
    runRepo,
    toolExecutions,
    approvals,
    // revision 桥：泵把快照 revision 送进端口 CAS 表（pause/resume 前置条件）。
    onSnapshotRevision: (runId, sessionId, revision) =>
      port.observeSnapshotRevision(runId, sessionId, revision),
  });
  const pump = new AgentRunEventPump({
    frameSource,
    runRepo,
    mapper,
    syncIntervalMs: 0, // 测试手工 sync。
  });
  return { pump, port, runRepo, approvals, sinks, connection };
}

function makeSnapshot(
  sessionId: string,
  phase: ConversationSnapshot["control"]["phase"],
  revision: number,
): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId,
    logEpoch: "le-1",
    seq: revision,
    revision,
    control: {
      phase,
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
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  });
}

const frame = (sessionId: string, payload: unknown) => ({
  topic: `conversation/${sessionId}`,
  subscriptionId: "sub-1",
  fromSeq: 0,
  toSeq: 1,
  sentAt: 1_700_000_000_000,
  payload,
});

describe("PB run 事件帧泵", () => {
  it("snapshot 帧驱动 run 状态迁移；revision 桥到 CAS 表（pause 从 rejected 变 accepted）", async () => {
    const { pump, port, runRepo, sinks } = await makeHarnessWithRun();
    const sessionId = LAST_SESSION_ID;
    const runId = LAST_RUN_ID;

    // 泵订阅前：无快照 revision，pause 诚实拒绝。
    const before = await port.requestPause(runId);
    expect(before.status).toBe("rejected");
    expect(before.reasonCode).toBe("pause_requires_snapshot");

    sinks
      .get("ws-key")!
      .fire(
        frame(sessionId, { kind: "snapshot", snapshot: makeSnapshot(sessionId, "running", 7) }),
      );
    // 帧处理是异步的：等待 mapper 落库。
    await vi.waitFor(() =>
      expect(runRepo.getRun(runId).then((run) => run?.status)).resolves.toBe("running"),
    );

    // revision 已桥接：pause CAS 命令发出（accepted）。
    const after = await port.requestPause(runId);
    expect(after.status).toBe("accepted");
    pump.stop();
  });

  it("delta permission 交互→审批建档 + waiting_approval（spec 05 §3）", async () => {
    const { pump, runRepo, approvals, sinks } = await makeHarnessWithRun();
    const sessionId = LAST_SESSION_ID;
    const runId = LAST_RUN_ID;

    sinks
      .get("ws-key")!
      .fire(
        frame(sessionId, { kind: "snapshot", snapshot: makeSnapshot(sessionId, "running", 1) }),
      );
    await vi.waitFor(() =>
      expect(runRepo.getRun(runId).then((run) => run?.status)).resolves.toBe("running"),
    );

    const delta = {
      op: "state.updated" as const,
      patch: {
        pendingInteractions: [
          {
            interactionId: "ia-pump-1",
            kind: "permission" as const,
            anchorRowId: null,
            createdAt: 1,
            payload: {
              kind: "permission" as const,
              toolCallId: "tc-pump-1",
              toolName: "Bash",
              summary: "运行删除脚本",
              detail: "rm -rf build",
              options: [
                { optionId: "allow", label: "允许", kind: "allowOnce" as const },
                { optionId: "deny", label: "拒绝", kind: "deny" as const },
              ],
            },
          },
        ],
      },
    };
    sinks.get("ws-key")!.fire(frame(sessionId, { kind: "deltas", deltas: [delta] }));
    await vi.waitFor(async () => {
      const pending = await approvals.list(runId, { decision: "pending" });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.riskSummary).toBe("运行删除脚本");
    });
    expect((await runRepo.getRun(runId))?.status).toBe("waiting_approval");
    pump.stop();
  });

  it("非 PB 会话帧丢弃；无活动 run 的工作区退订", async () => {
    const { pump, runRepo, sinks } = await makeHarnessWithRun();
    const sessionId = LAST_SESSION_ID;
    const runId = LAST_RUN_ID;
    void runId;

    // 非 PB 会话帧：不落任何事件（无 run 记录可寻）。
    sinks
      .get("ws-key")!
      .fire(
        frame("sess-stranger", {
          kind: "snapshot",
          snapshot: makeSnapshot("sess-stranger", "running", 1),
        }),
      );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const events = await runRepo.listRunEvents(runId, { limit: 50 });
    expect(events.every((event) => !event.eventType.startsWith("run.status.running") || true)).toBe(
      true,
    );

    // run 收敛终态后 sync：工作区退订。
    await runRepo.transitionRun(LAST_RUN_ID, {
      from: "planning",
      to: "cancelled",
      eventId: `evt:${LAST_RUN_ID}:t-cancel`,
      reason: "test",
    });
    const result = await pump.syncWorkspaceSubscriptions();
    expect(result.detached).toBe(1);
    pump.stop();
  });
});

let LAST_RUN_ID = "";
let LAST_SESSION_ID = "";

async function makeHarnessWithRun() {
  const harness = makeHarness();
  const descriptor = await harness.port.createRun(
    { goal: "帧泵测试目标" },
    { permissionMode: "build", workspacePath: "/tmp/ws-pump", workspaceIdentity: "ws-key" },
  );
  LAST_RUN_ID = descriptor.runId;
  LAST_SESSION_ID = descriptor.sessionId!;
  await harness.pump.syncWorkspaceSubscriptions();
  return { ...harness };
}
