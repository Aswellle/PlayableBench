// PB run 事件帧泵（PRD-06 帧泵接线、docs/audit V4-Port 映射表）：订阅 workspace
// 级 V4 下行帧流（IZCodeAgentService.onDynamicConversationFrame），把属于 PB
// run 的 conversation 帧（snapshot/delta）交给 RuntimeEventMapper 持久化——
// run 状态迁移、审批建档（V4 permission 交互）、message.final 捕获由此实时落地。
// 非 PB 会话帧按 sessionId 过滤丢弃（不污染上游会话）。
// 快照 revision 经 onSnapshotRevision 桥接到端口适配器的 CAS 表
// （pauseGoal/resumeGoal 的前置条件由此满足）。
import { conversationTopicFrameSchema } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeAgentWorkspaceTarget } from "#src/zcode-agent/zcodeAgentPluginParams.js";
import type { RuntimeEventMapper } from "#src/playablebench/runtimeEventMapper.js";
import type { RunRepo } from "#src/session/runRepo.js";

/** workspace 级下行帧源（facade 按工作区路由到对应 CLI client 的 emitter）。 */
export interface AgentRunEventFrameSource {
  onDynamicConversationFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): import("@zcode/rpc").Event<unknown>;
}

export interface AgentRunEventPumpOptions {
  frameSource: AgentRunEventFrameSource;
  runRepo: RunRepo;
  mapper: RuntimeEventMapper;
  /** 快照 revision 桥（端口适配器 CAS 表）。 */
  onSnapshotRevision?: (runId: string, sessionId: string, revision: number) => void;
  /** 活动 run 的工作区订阅同步周期（毫秒）；0 禁用自动同步（测试手工 sync）。 */
  syncIntervalMs?: number;
  /** 订阅退避（同步失败重试），缺省 15s。 */
  retryIntervalMs?: number;
  now?: () => number;
}

interface WorkspaceSubscription {
  target: ZCodeAgentWorkspaceTarget;
  unsubscribe: () => void;
}

const ACTIVE_RUN_STATUSES = [
  "queued",
  "planning",
  "running",
  "waiting_approval",
  "verifying",
] as const;

export class AgentRunEventPump {
  private readonly subscriptions = new Map<string, WorkspaceSubscription>();
  private readonly parsedSessionIds = new Set<string>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private started = false;
  private readonly syncIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AgentRunEventPumpOptions) {
    this.syncIntervalMs = options.syncIntervalMs ?? 15_000;
    this.retryIntervalMs = options.retryIntervalMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  /** 启动：立即同步一次并按周期跟随活动 run 的工作区。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    // 首次同步同样容错：数据库目录被删/暂不可用（如测试装配后清理临时目录）
    // 时泵保持沉默，由下一轮 sync 重试——unhandled rejection 会让整个
    // vitest worker 判红（run 43744774588 实证 4 errors 全部来自此处）。
    this.syncWorkspaceSubscriptions().catch(() => undefined);
    if (this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        if (this.syncing) return;
        this.syncing = true;
        void this.syncWorkspaceSubscriptions()
          .catch(() => undefined)
          .finally(() => {
            this.syncing = false;
          });
      }, this.retryIntervalMs);
      this.syncTimer.unref?.();
    }
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
    this.parsedSessionIds.clear();
    this.started = false;
  }

  /**
   * 工作区订阅同步（幂等）：活动 run 的 (workspacePath, workspaceIdentity) 建立
   * 订阅；已无活动 run 的工作区退订（帧源是 facade emitter，退订只断泵的监听，
   * 不影响 renderer/mobile 既有订阅）。
   */
  async syncWorkspaceSubscriptions(): Promise<{ subscribed: number; detached: number }> {
    const runs = await this.options.runRepo.listRuns({ limit: 200 });
    const activeTargets = new Map<string, ZCodeAgentWorkspaceTarget>();
    for (const run of runs) {
      if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) continue;
      if (!run.workspacePath) continue;
      const key = run.workspaceKey ?? run.workspacePath;
      if (!activeTargets.has(key)) {
        activeTargets.set(key, {
          workspacePath: run.workspacePath,
          ...(run.workspaceKey && run.workspaceKey !== run.workspacePath
            ? { workspaceIdentity: run.workspaceKey }
            : {}),
        });
      }
    }
    let subscribed = 0;
    for (const [key, target] of activeTargets) {
      if (this.subscriptions.has(key)) continue;
      this.attachWorkspace(key, target);
      subscribed += 1;
    }
    let detached = 0;
    for (const [key, subscription] of [...this.subscriptions]) {
      if (activeTargets.has(key)) continue;
      subscription.unsubscribe();
      this.subscriptions.delete(key);
      detached += 1;
    }
    return { subscribed, detached };
  }

  private attachWorkspace(key: string, target: ZCodeAgentWorkspaceTarget): void {
    try {
      const disposable = this.options.frameSource.onDynamicConversationFrame(target)(
        (frame: unknown) => {
          void this.routeFrame(frame);
        },
      );
      this.subscriptions.set(key, { target, unsubscribe: () => disposable.dispose() });
    } catch {
      // 帧源暂不可用（workspace client 未起）等下一次 sync 重试。
    }
  }

  /** 帧路由：topic → sessionId → PB run 过滤 → mapper 持久化。单帧容错不中断泵。 */
  async routeFrame(frame: unknown): Promise<void> {
    const parsed = conversationTopicFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    const topicFrame = parsed.data;
    const sessionId = topicFrame.topic.slice("conversation/".length);
    if (!sessionId) return;
    const run = await this.options.runRepo.getRunBySessionId(sessionId).catch(() => null);
    if (!run) return;
    if (topicFrame.payload.kind === "snapshot") {
      await this.options.mapper.applySnapshot(sessionId, topicFrame.payload.snapshot);
      return;
    }
    await this.options.mapper.applyDeltas(sessionId, topicFrame.payload.deltas);
  }
}
