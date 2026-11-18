// 第二批 A 级 connector 注册（spec 19 §1/§2：GitHub Releases A/P0-P1、
// HackerNews A/P1；§3 能力声明以运行时为准、§4 上线检查逐条落实）。
// GitHub Releases 与 rss_atom 同为 Atom 协议，复用 fetchAtomFeed，能力声明
// 差异化（limitations 记 API 限额、termsUrl 指条款）。HackerNews 用官方
// Firebase API（无凭据）：topstories 取前 30 → 批量 item（并发 5、单条容错），
// 原生指标（score/descendants）按来源字段定义保存（spec 08 §8 不推断缺失值）。
// 核验日期 2026-11-16：GitHub Atom 端点 github.com/{owner}/{repo}.releases.atom、
// HN API hacker-news.firebaseio.com/v0（公开、无认证；限速宽松但按退避纪律处理）。
import type { FeedConnectorType, FeedSource, FeedSourceCapabilities } from "@zcode/shared";
import type {
  FeedConnector,
  FeedFetchOutcome,
  FeedNativeMetric,
} from "#src/playablebench/feedConnector.js";
import { createRssAtomConnector, fetchAtomFeed } from "#src/playablebench/feedConnector.js";
import { FetchGuardError, guardedFetch } from "#src/playablebench/fetchGuard.js";

export const GITHUB_RELEASES_TERMS_URL = "https://docs.github.com/site-policy/github-terms";
export const HACKERNEWS_TERMS_URL = "https://www.ycombinator.com/legal/terms-of-use";

const GITHUB_RELEASES_CAPABILITIES: FeedSourceCapabilities = {
  fetchItems: "supported",
  nativeHotList: "unsupported",
  // Releases Atom 不含 stars/forks——spec 19 §2 明确"是否可取决于 API/权限"，
  // 未核验到可靠指标前声明 unsupported，不用 stars 增长等同内容质量。
  nativeMetrics: [],
  requiresCredential: false,
  requiresExternalService: false,
  lastValidatedAt: "2026-11-16",
  limitations: [
    "upstream rate limiting may apply (unauthenticated requests)",
    "release notes are upstream-authored; not repository activity metrics",
  ],
};

/** GitHub Releases connector：Atom 协议复用，能力声明差异化。 */
export function createGitHubReleasesConnector(): FeedConnector {
  return {
    connectorType: "github_releases",
    getCapabilities: () => ({ ...GITHUB_RELEASES_CAPABILITIES }),
    fetch: fetchAtomFeed,
  };
}

const HACKERNEWS_CAPABILITIES: FeedSourceCapabilities = {
  fetchItems: "supported",
  nativeHotList: "supported",
  nativeMetrics: ["score", "comment_count"],
  requiresCredential: false,
  requiresExternalService: false,
  lastValidatedAt: "2026-11-16",
  limitations: [
    "top stories snapshot per fetch; ranking is native to Hacker News",
    "unauthenticated public API; backoff on upstream failures",
  ],
};

const HACKERNEWS_API_BASE = "https://hacker-news.firebaseio.com/v0";
const HACKERNEWS_MAX_STORIES = 30;
const HACKERNEWS_ITEM_CONCURRENCY = 5;
const HACKERNEWS_MAX_RESPONSE_BYTES = 512 * 1024;

interface HnStoryItem {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  by?: unknown;
  time?: unknown;
  text?: unknown;
  score?: unknown;
  descendants?: unknown;
  deleted?: unknown;
  dead?: unknown;
}

/** 受限 JSON 数值/字符串提取：字段白名单 + 类型校验，不信任上游形状。 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function fetchHnJson(
  url: string,
): Promise<
  | { ok: true; bodyText: string; etag?: string }
  | { ok: false; httpStatus?: number; errorCode: string; retryAfterSeconds?: number }
> {
  let response;
  try {
    response = await guardedFetch(url, {
      allowLoopback: false,
      connectTimeoutMs: 10_000,
      totalTimeoutMs: 20_000,
      maxBytes: HACKERNEWS_MAX_RESPONSE_BYTES,
      maxRedirects: 5,
    });
  } catch (error) {
    if (error instanceof FetchGuardError) {
      return { ok: false, errorCode: error.kind };
    }
    return { ok: false, errorCode: "network_error" };
  }
  if (response.status === 429) {
    return {
      ok: false,
      httpStatus: 429,
      errorCode: "http_429",
      retryAfterSeconds: response.retryAfterSeconds,
    };
  }
  if (response.status >= 400) {
    return { ok: false, httpStatus: response.status, errorCode: `http_${response.status}` };
  }
  return { ok: true, bodyText: response.bodyText, etag: response.etag };
}

function parseStoryIds(bodyText: string): number[] | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!Array.isArray(parsed)) return null;
    const ids: number[] = [];
    for (const entry of parsed.slice(0, HACKERNEWS_MAX_STORIES)) {
      const id = asFiniteNumber(entry);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  } catch {
    return null;
  }
}

function parseStoryItem(bodyText: string): { item: HnStoryItem } | { error: string } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object") return { error: "parse_not_object" };
    return { item: parsed as HnStoryItem };
  } catch {
    return { error: "parse_invalid_json" };
  }
}

function storyToNativeMetrics(item: HnStoryItem, id: number): FeedNativeMetric[] {
  const metrics: FeedNativeMetric[] = [];
  const score = asFiniteNumber(item.score);
  if (score !== undefined) {
    metrics.push({ sourceItemId: String(id), name: "score", value: String(score), unit: "points" });
  }
  const descendants = asFiniteNumber(item.descendants);
  if (descendants !== undefined) {
    metrics.push({
      sourceItemId: String(id),
      name: "comment_count",
      value: String(descendants),
      unit: "comments",
    });
  }
  return metrics;
}

/** HackerNews connector：官方 Firebase API（spec 19 §2 A/P1）。 */
export function createHackerNewsConnector(deps?: {
  /** 测试注入（loopback 放行）；生产缺省 guardedFetch。 */
  fetchJson?: typeof fetchHnJson;
}): FeedConnector {
  const fetchJson = deps?.fetchJson ?? fetchHnJson;
  return {
    connectorType: "hackernews",
    getCapabilities: () => ({ ...HACKERNEWS_CAPABILITIES }),
    async fetch(source: FeedSource): Promise<FeedFetchOutcome> {
      // source.url 指向 topstories 端点（缺省官方基址）；同源 item 请求派生。
      const topstoriesUrl = source.url.startsWith("https://")
        ? source.url
        : `${HACKERNEWS_API_BASE}/topstories.json`;
      const top = await fetchJson(topstoriesUrl);
      if (!top.ok) {
        return {
          status: "failed",
          httpStatus: top.httpStatus,
          errorCode: top.errorCode,
          retryAfterSeconds: top.retryAfterSeconds,
        };
      }
      const storyIds = parseStoryIds(top.bodyText);
      if (storyIds === null) {
        return { status: "failed", httpStatus: 200, errorCode: "parse_invalid_json" };
      }
      const ids: number[] = storyIds;
      const items: Array<NonNullable<FeedFetchOutcome["items"]>[number]> = [];
      const metrics: FeedNativeMetric[] = [];
      let cursor = 0;
      let failedItems = 0;
      async function nextItem(): Promise<void> {
        const index = cursor++;
        const id = ids[index];
        if (id === undefined) return;
        const story = await fetchJson(`${HACKERNEWS_API_BASE}/item/${id}.json`);
        if (!story.ok) {
          failedItems += 1;
          return;
        }
        const parsedItem = parseStoryItem(story.bodyText);
        if ("error" in parsedItem) {
          failedItems += 1;
          return;
        }
        const item = parsedItem.item;
        if (item.deleted === true || item.dead === true) return;
        const title = asString(item.title);
        if (!title) return;
        const storyUrl = asString(item.url);
        const timeSeconds = asFiniteNumber(item.time);
        items.push({
          sourceItemId: String(id),
          title,
          linkUrl: storyUrl ?? `https://news.ycombinator.com/item?id=${id}`,
          author: asString(item.by),
          publishedAt: timeSeconds !== undefined ? timeSeconds * 1000 : undefined,
          summaryText: asString(item.text),
        });
        metrics.push(...storyToNativeMetrics(item, id));
      }
      // 并发受限批量取 item；单条失败容错（计入 failedItems，不整体判败）。
      const workers = Array.from(
        { length: Math.min(HACKERNEWS_ITEM_CONCURRENCY, ids.length) },
        () => nextItem(),
      );
      await Promise.all(workers);
      if (items.length === 0 && ids.length > 0) {
        // 全部条目失败：按失败处理进入调度退避（保留旧内容，spec 16 Phase 4 门禁）。
        return { status: "failed", httpStatus: 200, errorCode: "hn_items_unavailable" };
      }
      void failedItems;
      return {
        status: "fetched",
        httpStatus: 200,
        etag: top.etag,
        items,
        metrics,
      };
    },
  };
}

/** connector 工厂（spec 19 §3：能力声明按类型运行时返回）。 */
export function createFeedConnector(type: FeedConnectorType): FeedConnector {
  switch (type) {
    case "github_releases":
      return createGitHubReleasesConnector();
    case "hackernews":
      return createHackerNewsConnector();
    case "rss_atom":
    case "custom_json":
    case "manual_url":
    default:
      return createRssAtomConnector();
  }
}
