// 第二批 A 级 connector 测试（spec 19 §2/§3/§4、spec 08 §8）：
// HackerNews（官方 Firebase API fixture 注入）——链路、原生指标、单条容错、
// 全失败退避、坏 JSON、429 透传；GitHub Releases 能力声明；工厂路由。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFeedConnector,
  createGitHubReleasesConnector,
  createHackerNewsConnector,
  GITHUB_RELEASES_TERMS_URL,
  HACKERNEWS_TERMS_URL,
} from "#src/playablebench/feedConnectorsRegistry.js";
import type { FeedSource } from "@zcode/shared";

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

function makeSource(url: string): FeedSource {
  return {
    id: "src-1",
    connectorType: "hackernews",
    name: "Hacker News",
    url,
    enabled: true,
    paused: false,
    pollIntervalSec: 900,
  };
}

const TOP_IDS = {
  ok: true as const,
  bodyText: JSON.stringify([1001, 1002, 1003, 1004]),
  etag: '"t1"',
};
const STORY_1001 = {
  ok: true as const,
  bodyText: JSON.stringify({
    id: 1001,
    title: "Story one",
    url: "https://example.com/1",
    by: "alice",
    time: 1_700_000_000,
    score: 120,
    descendants: 34,
  }),
};
const STORY_1002 = {
  ok: true as const,
  bodyText: JSON.stringify({
    id: 1002,
    title: "Ask HN: something",
    by: "bob",
    time: 1_700_000_100,
    text: "正文文本",
    score: 5,
  }),
};
const STORY_1003 = {
  ok: true as const,
  bodyText: JSON.stringify({ id: 1003, title: "Deleted", deleted: true }),
};
const STORY_1004 = {
  ok: true as const,
  bodyText: JSON.stringify({ id: 1004, title: "No score yet" }),
};

describe("HackerNews connector（spec 19 §2 A/P1）", () => {
  it("链路：topstories → 批量 item → ParsedFeedItem + 原生指标（score/comment_count）", async () => {
    const calls: string[] = [];
    const connector = createHackerNewsConnector({
      fetchJson: async (url) => {
        calls.push(url);
        if (url.endsWith("topstories.json")) return TOP_IDS;
        if (url.endsWith("/1001.json")) return STORY_1001;
        if (url.endsWith("/1002.json")) return STORY_1002;
        if (url.endsWith("/1003.json")) return STORY_1003;
        if (url.endsWith("/1004.json")) return STORY_1004;
        return { ok: false, errorCode: "http_404" };
      },
    });
    const outcome = await connector.fetch(
      makeSource("https://hacker-news.firebaseio.com/v0/topstories.json"),
    );
    expect(outcome.status).toBe("fetched");
    expect(outcome.items).toHaveLength(3); // deleted 条目剔除
    const first = outcome.items?.[0];
    expect(first).toMatchObject({
      sourceItemId: "1001",
      title: "Story one",
      linkUrl: "https://example.com/1",
      author: "alice",
    });
    // 无外链的条目保留 HN item 链接（原帖 URL 纪律）。
    expect(outcome.items?.[1]?.linkUrl).toBe("https://news.ycombinator.com/item?id=1002");
    expect(outcome.items?.[1]?.summaryText).toBe("正文文本");
    // 原生指标按来源字段定义保存（score=120 points、comment_count=34）。
    expect(outcome.metrics).toContainEqual({
      sourceItemId: "1001",
      name: "score",
      value: "120",
      unit: "points",
    });
    expect(outcome.metrics).toContainEqual({
      sourceItemId: "1001",
      name: "comment_count",
      value: "34",
      unit: "comments",
    });
    // 无 score 字段的条目不推断指标（spec 08 §8）。
    expect(outcome.metrics?.filter((metric) => metric.sourceItemId === "1004")).toHaveLength(0);
    // 批量取 item：topstories 1 次 + item 4 次（并发 5 内）。
    expect(calls.filter((url) => url.includes("/item/"))).toHaveLength(4);
  });

  it("单条失败容错（不整体判败）；全部失败进入退避；坏 JSON 判 parse_invalid_json；429 透传", async () => {
    // 单条 404：其余成功 → fetched。
    const partial = createHackerNewsConnector({
      fetchJson: async (url) => {
        if (url.endsWith("topstories.json")) return TOP_IDS;
        if (url.endsWith("/1001.json")) return STORY_1001;
        return { ok: false, errorCode: "http_404" };
      },
    });
    const partialOutcome = await partial.fetch(
      makeSource("https://hacker-news.firebaseio.com/v0/topstories.json"),
    );
    expect(partialOutcome.status).toBe("fetched");
    expect(partialOutcome.items?.length).toBeGreaterThanOrEqual(1);

    // 全部失败 → failed 进调度退避。
    const allFail = createHackerNewsConnector({
      fetchJson: async (url) =>
        url.endsWith("topstories.json") ? TOP_IDS : { ok: false, errorCode: "http_500" },
    });
    const failed = await allFail.fetch(
      makeSource("https://hacker-news.firebaseio.com/v0/topstories.json"),
    );
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("hn_items_unavailable");

    // topstories 坏 JSON。
    const badJson = createHackerNewsConnector({
      fetchJson: async () => ({ ok: true, bodyText: "<html>not json</html>" }),
    });
    const badOutcome = await badJson.fetch(
      makeSource("https://hacker-news.firebaseio.com/v0/topstories.json"),
    );
    expect(badOutcome.status).toBe("failed");
    expect(badOutcome.errorCode).toBe("parse_invalid_json");

    // topstories 429：Retry-After 透传给调度退避。
    const rate = createHackerNewsConnector({
      fetchJson: async () => ({
        ok: false,
        httpStatus: 429,
        errorCode: "http_429",
        retryAfterSeconds: 9,
      }),
    });
    const rateOutcome = await rate.fetch(
      makeSource("https://hacker-news.firebaseio.com/v0/topstories.json"),
    );
    expect(rateOutcome.status).toBe("failed");
    expect(rateOutcome.errorCode).toBe("http_429");
    expect(rateOutcome.retryAfterSeconds).toBe(9);
  });
});

describe("GitHub Releases connector 与工厂（spec 19 §2/§3）", () => {
  it("能力声明：GitHub 无原生指标（stars 不等同内容质量）；HN 声明 score/comment_count；条款链接", () => {
    const github = createGitHubReleasesConnector().getCapabilities();
    expect(github.nativeMetrics).toEqual([]);
    expect(github.requiresCredential).toBe(false);
    expect(github.lastValidatedAt).toBe("2026-11-16");
    expect(github.limitations.some((limitation) => limitation.includes("rate limiting"))).toBe(
      true,
    );
    expect(GITHUB_RELEASES_TERMS_URL).toContain("github.com");

    const hn = createHackerNewsConnector().getCapabilities();
    expect(hn.nativeMetrics).toEqual(["score", "comment_count"]);
    expect(hn.nativeHotList).toBe("supported");
    expect(HACKERNEWS_TERMS_URL).toContain("ycombinator.com");
  });

  it("工厂按类型路由；未知类型回落 rss_atom", () => {
    expect(createFeedConnector("github_releases").connectorType).toBe("github_releases");
    expect(createFeedConnector("hackernews").connectorType).toBe("hackernews");
    expect(createFeedConnector("rss_atom").connectorType).toBe("rss_atom");
    expect(createFeedConnector("custom_json").connectorType).toBe("rss_atom");
  });
});
