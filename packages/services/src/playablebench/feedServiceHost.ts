// PlayableBench 信息雷达服务实现（Host 侧；携带 node:sqlite 链，不进 renderer barrel）。
// 组装 FeedSourceRepo/FeedItemRepo/connector/调度器；来源 URL 添加时即做
// scheme/字面量校验（SSRF 防线的前置反馈，抓取时仍逐跳校验）。
import type { FeedItem, FeedMetricSnapshot, FeedSource } from "@zcode/shared";
import type { FeedCardQueryParams, FeedRefreshSummary, IFeedService } from "#src/playablebench/feedService.js";
import type { FeedConnector } from "#src/playablebench/feedConnector.js";
import { createRssAtomConnector } from "#src/playablebench/feedConnector.js";
import { FetchGuardError, assertFetchableUrl } from "#src/playablebench/fetchGuard.js";
import { FeedScheduler } from "#src/playablebench/feedScheduler.js";
import { FeedItemRepo } from "#src/session/feedItemRepo.js";
import { FeedSourceRepo } from "#src/session/feedSourceRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

export interface FeedServiceHostOptions {
  /** 测试注入临时库路径；生产缺省走进程默认 tasks-index 库。 */
  dbPath?: string;
  connector?: FeedConnector;
  now?: () => number;
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
