// PlayableBench 信息雷达领域类型（spec 06 §2、spec 08、spec 19 §3）。
// 卡片契约优先字段（spec 08 §4）：原始标题/来源/作者/发布时间/首次发现时间/
// 摘要/原文链接；互动数据必须带指标名与采样时刻，不允许无来源的"热度"。
// A 级首批 connector：RSS/Atom（spec 19 §2）；GitHub/HN 官方源下批。

export type FeedConnectorType = "rss_atom" | "custom_json" | "manual_url";

/** 运行时能力声明（spec 19 §3）：以实际检测结果为准，不是静态文案。 */
export type FeedCapabilityState = "supported" | "partial" | "unsupported" | "unknown";

export interface FeedSourceCapabilities {
  fetchItems: FeedCapabilityState;
  nativeHotList: FeedCapabilityState;
  /** 实际可获得的指标名（如 comment_count）；无则空数组。 */
  nativeMetrics: string[];
  requiresCredential: boolean;
  requiresExternalService: boolean;
  /** 上次核验日期（ISO 日期）；正式实现前必须重新核验（spec 19 §4）。 */
  lastValidatedAt?: string;
  limitations: string[];
}

export type FeedMetricOrigin = "native_source" | "derived_estimate";

export interface FeedSource {
  id: string;
  connectorType: FeedConnectorType;
  name: string;
  /** 订阅 URL；同 URL 视为同一来源（库内唯一）。 */
  url: string;
  enabled: boolean;
  pollIntervalSec: number;
  /** 条件请求游标（ETag / If-Modified-Since，支持时）。 */
  etag?: string;
  lastModified?: string;
  /** 连接器配置（脱敏 JSON 文本）；凭据不入此字段（spec 06 §2）。 */
  configJson?: string;
  capabilities?: FeedSourceCapabilities;
  termsUrl?: string;
  /** 单源暂停（spec 08 §5：支持全局/单源暂停）。 */
  paused: boolean;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastErrorCode?: string;
  lastErrorAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface FeedItem {
  id: string;
  sourceId: string;
  /** 源内条目 id（guid/entry id）；存在时 (sourceId, sourceItemId) 唯一。 */
  sourceItemId?: string;
  /** 规范化 URL（仅移除白名单追踪参数；spec 08 §7）。 */
  canonicalUrl: string;
  /** 原始 URL 逐字保留。 */
  originalUrl: string;
  title: string;
  author?: string;
  publishedAt?: number;
  firstSeenAt: number;
  lastSeenAt: number;
  summary?: string;
  /** 规范化内容哈希（去重第三级键）。 */
  contentHash?: string;
  language?: string;
  /** 媒体引用（JSON 文本数组）。 */
  mediaRefsJson?: string;
  tagsJson?: string;
  /** 多来源 attribution（JSON 文本数组 [{sourceId,url}]；重复合并保留，spec 08 §7）。 */
  attributionJson?: string;
  readAt?: number;
  /** 收藏时间（spec 16 Phase 4：收藏）。 */
  favoriteAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** 指标采样（spec 06 §2）：不同平台指标定义不同，禁止直接跨源求和。 */
export interface FeedMetricSnapshot {
  id: string;
  feedItemId: string;
  sourceId: string;
  sampledAt: number;
  metricName: string;
  /** 数值以文本保存（避免浮点精度/大数损失）。 */
  metricValue?: string;
  metricUnit?: string;
  metricOrigin: FeedMetricOrigin;
  sourceRank?: number;
}

export interface FeedSourceInput {
  connectorType: FeedConnectorType;
  name: string;
  url: string;
  pollIntervalSec?: number;
  configJson?: string;
  capabilities?: FeedSourceCapabilities;
  termsUrl?: string;
}

export interface FeedItemUpsertInput {
  sourceId: string;
  sourceItemId?: string;
  originalUrl: string;
  canonicalUrl: string;
  title: string;
  author?: string;
  publishedAt?: number;
  summary?: string;
  contentHash?: string;
  language?: string;
  mediaRefsJson?: string;
  tagsJson?: string;
  seenAt?: number;
}
