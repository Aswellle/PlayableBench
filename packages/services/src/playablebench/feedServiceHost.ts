// PlayableBench 信息雷达服务实现（Host 侧；携带 node:sqlite 链，不进 renderer barrel）。
// 组装 FeedSourceRepo/FeedItemRepo/connector/调度器；来源 URL 添加时即做
// scheme/字面量校验（SSRF 防线的前置反馈，抓取时仍逐跳校验）。
import type { FeedItem, FeedMetricSnapshot, ZCodeTaskPriority } from "@zcode/shared";
import type { FeedCardQueryParams, FeedCardTaskResult, FeedRefreshSummary, IFeedService } from "#src/playablebench/feedService.js";
import type { FeedConnector } from "#src/playablebench/feedConnector.js";
import { createRssAtomConnector } from "#src/playablebench/feedConnector.js";
import { FetchGuardError, assertFetchableUrl } from "#src/playablebench/fetchGuard.js";
import { FeedScheduler } from "#src/playablebench/feedScheduler.js";
import type { IPlayableBenchService } from "#src/playablebench/playablebench.js";
import { createPlayableBenchService } from "#src/playablebench/playablebenchService.js";
import { InboxRepo } from "#src/session/inboxRepo.js";
import { FeedItemRepo } from "#src/session/feedItemRepo.js";
import { FeedSourceRepo } from "#src/session/feedSourceRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

export interface FeedServiceHostOptions {
  /** 测试注入临时库路径；生产缺省走进程默认 tasks-index 库。 */
  dbPath?: string;
  connector?: FeedConnector;
  now?: () => number;
  /** 卡片转任务编排依赖（缺省 wire 进程默认 repo；注入便于测试与路径隔离）。 */
  inboxRepo?: InboxRepo;
  taskIndexRepo?: TaskIndexRepo;
}

export function createFeedService(options: FeedServiceHostOptions = {}): IFeedService {
  const connection = new RunStoreConnection(options.dbPath);
  const sources = new FeedSourceRepo(connection);
  const items = new FeedItemRepo(connection);
  const connector = options.connector ?? createRssAtomConnector();
  const scheduler = new FeedScheduler({
    sources,
    items,
    connector,
    ...(options.now ? { now: options.now } : {}),
  });
  // 卡片转任务复用 PlayableBench 既有 capture→convert 写入路径（单一写入方）；
  // 注入同一 Inbox/TaskIndex repo 保证与工作管理服务共享同一连接配置。
  const inboxRepo = options.inboxRepo ?? new InboxRepo(options.dbPath);
  const taskIndexRepo = options.taskIndexRepo ?? new TaskIndexRepo(options.dbPath);
  const bench: Pick<IPlayableBenchService, "captureInboxItem" | "convertInboxItemToTask"> =
    createPlayableBenchService({
      inboxRepo,
      taskIndexRepo,
    });

  return {
    async addSource(input) {
      // 添加时即做 scheme/字面量地址校验（抓取时仍逐跳校验，本处是前置反馈）。
      let parsed: URL;
      try {
        parsed = assertFetchableUrl(input.url);
      } catch (error) {
        if (error instanceof FetchGuardError) {
          throw Object.assign(new Error(error.message), { kind: error.kind });
        }
        throw error;
      }
      const name = input.name?.trim() || parsed.hostname;
      const source = await sources.add({
        connectorType: "rss_atom",
        name,
        url: input.url,
        ...(input.pollIntervalSec ? { pollIntervalSec: input.pollIntervalSec } : {}),
        capabilities: connector.getCapabilities(),
        termsUrl: undefined,
      });
      return source;
    },

    async listSources() {
      return sources.list();
    },

    async pauseSource(id, paused) {
      return sources.setPaused(id, paused);
    },

    async removeSource(id) {
      return sources.remove(id);
    },

    async refreshSource(id): Promise<FeedRefreshSummary> {
      const result = await scheduler.refreshSource(id);
      return {
        status: result.status,
        ...(result.newItems !== undefined ? { newItems: result.newItems } : {}),
        ...(result.outcome?.errorCode ? { errorCode: result.outcome.errorCode } : {}),
        ...(result.nextEligibleAt !== undefined ? { nextEligibleAt: result.nextEligibleAt } : {}),
      };
    },

    async convertCardToTask(input): Promise<FeedCardTaskResult> {
      const card = await items.get(input.cardId);
      if (!card) {
        throw Object.assign(new Error(`卡片不存在: ${input.cardId}`), { kind: "card_not_found" });
      }
      // 幂等复用（spec 16 门禁）：同卡片原始 URL 已成功转出任务的最近 Inbox
      // 条目直接返回，不重复建任务；原始 URL 逐字比对，跨源镜像各自可转。
      const existing = await inboxRepo.findConvertedBySourceUrl(card.originalUrl);
      if (existing?.taskId) {
        const task = await taskIndexRepo.getTaskMeta({
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          taskId: existing.taskId,
        });
        return { card, inboxItemId: existing.id, ...(task ? { task } : {}), reused: true };
      }
      // 原始输入逐字保留（PRD-02）：标题 + 原文 URL 两行。
      const captured = await bench.captureInboxItem({
        kind: "text",
        rawInput: `${card.title}\n${card.originalUrl}`,
        title: card.title,
        sourceUrl: card.originalUrl,
      });
      const priority = (input.priority ?? undefined) as ZCodeTaskPriority | undefined;
      const converted = await bench.convertInboxItemToTask({
        id: captured.id,
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(priority ? { priority } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      });
      return {
        card,
        inboxItemId: converted.inboxItemId,
        task: converted.task,
        reused: false,
      };
    },

    async listCards(params?: FeedCardQueryParams): Promise<FeedItem[]> {
      return items.listCards(params ?? {});
    },

    async getCardCounts(params?: { sourceId?: string }) {
      return items.countCards(params);
    },

    async setFavorite(id, favorite) {
      return items.setFavorite(id, favorite);
    },

    async markRead(id, read = true) {
      return items.markRead(id, read);
    },

    async listMetrics(itemId): Promise<FeedMetricSnapshot[]> {
      return items.listMetrics(itemId);
    },
  };
}
