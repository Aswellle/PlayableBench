// Feed 连接器契约与 RSS/Atom 实现（spec 19 §3 能力声明、spec 08 §5 抓取纪律）。
// 能力声明以运行时 getCapabilities() 为准（A 级 RSS/Atom：无凭据、无外部服务、
// 无原生热榜/指标）；抓取全部经 fetchGuard（SSRF 防线），条件请求用
// ETag / If-Modified-Since，429 透传 Retry-After 供调度层退避。
import { createHash } from "node:crypto";
import type { FeedConnectorType, FeedSource, FeedSourceCapabilities } from "@zcode/shared";
import type { ParsedFeedItem } from "#src/playablebench/feedParser.js";
import { parseFeedDocument, FeedParseError } from "#src/playablebench/feedParser.js";
import { FetchGuardError, guardedFetch } from "#src/playablebench/fetchGuard.js";

const RSS_ATOM_CAPABILITIES: FeedSourceCapabilities = {
  fetchItems: "supported",
  nativeHotList: "unsupported",
  nativeMetrics: [],
  requiresCredential: false,
  requiresExternalService: false,
  lastValidatedAt: "2026-11-14",
  limitations: [
    "upstream rate limiting may apply",
    "only http/https origins; private network addresses are rejected",
  ],
};

export interface FeedFetchOutcome {
  status: "fetched" | "not_modified" | "failed";
  httpStatus?: number;
  etag?: string;
  lastModified?: string;
  retryAfterSeconds?: number;
  errorCode?: string;
  items?: ParsedFeedItem[];
}

export interface FeedConnector {
  readonly connectorType: FeedConnectorType;
  getCapabilities(): FeedSourceCapabilities;
  fetch(source: FeedSource): Promise<FeedFetchOutcome>;
}

const TRACKING_PARAM_PREFIXES = ["utm_", "fbclid", "gclid", "msclkid", "spm", "ref_src", "igshid"];
const TRACKING_PARAMS = new Set(["ref", "referrer", "from", "share", "sh"]);

/** 规范化 URL（spec 08 §7）：仅移除白名单追踪参数；小写 host；去 fragment。 */
export function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }
    const removeKeys: Array<string> = [];
    for (const key of new Set(url.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix)) || TRACKING_PARAMS.has(lower)) {
        removeKeys.push(key);
      }
    }
    for (const key of removeKeys) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/** 内容哈希（去重第三级键）：规范化文本（标题+摘要），不含 URL——转载变体可命中。 */
export function computeContentHash(title: string, summary?: string): string {
  return createHash("sha256")
    .update(`${title.trim()}\n${(summary ?? "").trim()}`)
    .digest("hex");
}

export function createRssAtomConnector(): FeedConnector {
  return {
    connectorType: "rss_atom",
    getCapabilities: () => ({ ...RSS_ATOM_CAPABILITIES }),
    async fetch(source: FeedSource): Promise<FeedFetchOutcome> {
      const headers: Record<string, string> = {};
      if (source.etag) headers["if-none-match"] = source.etag;
      if (source.lastModified) headers["if-modified-since"] = source.lastModified;
      let response;
      try {
        response = await guardedFetch(source.url, {
          headers,
          allowLoopback: false,
          connectTimeoutMs: 10_000,
          totalTimeoutMs: 20_000,
          maxBytes: 2 * 1024 * 1024,
          maxRedirects: 5,
        });
      } catch (error) {
        if (error instanceof FetchGuardError) {
          return { status: "failed", errorCode: error.kind };
        }
        return { status: "failed", errorCode: "network_error" };
      }
      if (response.status === 304) {
        return {
          status: "not_modified",
          httpStatus: 304,
          etag: response.etag ?? source.etag,
          lastModified: response.lastModified ?? source.lastModified,
        };
      }
      if (response.status === 429) {
        return {
          status: "failed",
          httpStatus: 429,
          retryAfterSeconds: response.retryAfterSeconds,
          errorCode: "http_429",
        };
      }
      if (response.status >= 400 && response.status < 500) {
        return { status: "failed", httpStatus: response.status, errorCode: `http_${response.status}` };
      }
      if (response.status >= 500) {
        return { status: "failed", httpStatus: response.status, errorCode: `http_${response.status}` };
      }
      if (response.status !== 200) {
        return { status: "failed", httpStatus: response.status, errorCode: `http_${response.status}` };
      }
      try {
        const parsed = parseFeedDocument(response.bodyText);
        return {
          status: "fetched",
          httpStatus: 200,
          etag: response.etag,
          lastModified: response.lastModified,
          items: parsed.items,
        };
      } catch (error) {
        if (error instanceof FeedParseError) {
          return { status: "failed", httpStatus: 200, errorCode: `parse_${error.kind}` };
        }
        return { status: "failed", httpStatus: 200, errorCode: "parse_unknown" };
      }
    },
  };
}
