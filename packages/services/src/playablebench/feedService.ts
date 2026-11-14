// PlayableBench 信息雷达服务接口与 descriptor（纯类型/常量文件，renderer 安全）。
// 与实现文件（feedServiceHost.ts）分离：实现携带 node:sqlite 链（同
// playablebench.ts/playablebenchService.ts 的 descriptor/实现分离惯例）。
// 卡片契约（spec 08 §4）：原始标题/来源/作者/发布时间/firstSeenAt/摘要/
// 原文链接；互动指标带指标名与采样时刻，不允许无来源的"热度"。
import type {
  FeedItem,
  FeedMetricSnapshot,
  FeedSource,
  ZCodeTaskMeta,
  ZCodeTaskPriority,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface FeedRefreshSummary {
  status:
    | "fetched"
    | "not_modified"
    | "failed"
    | "skipped_paused"
    | "skipped_in_flight"
    | "skipped_disabled";
  newItems?: number;
  errorCode?: string;
  nextEligibleAt?: number;
}

export interface FeedCardQueryParams {
  sourceId?: string;
  favoritesOnly?: boolean;
  unreadOnly?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

/** 卡片转任务结果：reused 表示幂等命中既有转换（spec 16 门禁：重复触发有幂等保护）。 */
export interface FeedCardTaskResult {
  card: FeedItem;
  inboxItemId: string;
  task?: ZCodeTaskMeta;
  reused: boolean;
}

export interface IFeedService {
  /** 添加来源（RSS/Atom URL；非 http(s) 立即拒绝）。 */
  addSource(input: { url: string; name?: string; pollIntervalSec?: number }): Promise<FeedSource>;
  listSources(): Promise<FeedSource[]>;
  pauseSource(id: string, paused: boolean): Promise<FeedSource | null>;
  removeSource(id: string): Promise<boolean>;
  /** 手动刷新（single-flight；暂停/停用返回 skipped）。 */
  refreshSource(id: string): Promise<FeedRefreshSummary>;
  /**
   * 卡片转任务（spec 08 §4、PRD-02）：原始标题+URL 逐字进 Inbox 后走既有
   * capture→convert 写入路径；同卡片原始 URL 已有成功转换时幂等复用。
   */
  convertCardToTask(input: {
    cardId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title?: string;
    priority?: ZCodeTaskPriority;
    dueAt?: number;
  }): Promise<FeedCardTaskResult>;
  /** 统一卡片列表（spec 08 §4 契约字段）。 */
  listCards(params?: FeedCardQueryParams): Promise<FeedItem[]>;
  getCardCounts(params?: {
    sourceId?: string;
  }): Promise<{ unread: number; favorites: number; total: number }>;
  setFavorite(id: string, favorite: boolean): Promise<FeedItem | null>;
  markRead(id: string, read?: boolean): Promise<FeedItem | null>;
  /** 互动指标采样（带指标名与采样时刻；spec 08 §8）。 */
  listMetrics(itemId: string): Promise<FeedMetricSnapshot[]>;
}

export const IFeedService = createServiceDescriptor<IFeedService>(ServiceChannels.Feed);
