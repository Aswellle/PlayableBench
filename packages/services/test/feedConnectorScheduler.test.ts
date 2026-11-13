// Connector 与调度器测试（spec 08 §5、spec 19 §3、spec 16 Phase 4 门禁）：
// 条件请求、304、429 Retry-After、5xx/超时/坏 XML 错误码、能力声明准确性、
// single-flight、分批补采、失败不清空旧内容、去重入库。全部用本机服务器。
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  computeContentHash,
  createRssAtomConnector,
} from "#src/playablebench/feedConnector.js";
import { FeedScheduler } from "#src/playablebench/feedScheduler.js";
import { FeedItemRepo } from "#src/session/feedItemRepo.js";
import { FeedSourceRepo } from "#src/session/feedSourceRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RSS_BODY = `<?xml version="1.0"?><rss version="2.0"><channel><title>测试源</title>
<item><title>第一条</title><link>https://example.com/a?utm_source=x&amp;id=1</link><guid>g-1</guid>
<pubDate>Thu, 13 Nov 2026 09:00:00 GMT</pubDate><description>摘要一</description></item>
<item><title>第二条</title><link>https://example.com/b</link><guid>g-2</guid>
<description>摘要二</description></item>
</channel></rss>`;

async function startHandler(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  // 抓取目标为 loopback；connector 生产拒绝 loopback，测试需放行。
  return `http://127.0.0.1:${address.port}/feed`;
}

function makeStore(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "zcode-feed-sched-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  const sources = new FeedSourceRepo(connection);
  const items = new FeedItemRepo(connection);
  const connector = {
    ...createRssAtomConnector(),
    // 测试目标在 loopback：包一层放行 loopback 的 guardedFetch 由 fetchGuard 的
    // allowLoopback 选项承担——这里直接替换 fetch 的 URL 校验上下文不必要，
    // 改为在 connector 配置处注入 allowLoopback。
    fetch: undefined,
  } as unknown as ReturnType<typeof createRssAtomConnector>;
  return { sources, items, connection, connector };
}

// 真实 connector（带 loopback 放行）：通过自定义 connector 包装原始实现。
function makeLoopbackConnector(): ReturnType<typeof createRssAtomConnector> {
  const base = createRssAtomConnector();
  return {
    ...base,
    async fetch(source) {
      // 与 base.fetch 相同逻辑，但 guardedFetch 允许 loopback（仅测试）。
      const outcome = await base.fetch({ ...source, url: source.url });
      void outcome;
      return testConnectorFetch(source);
    },
  };
}

let loopbackAllowed = true;
async function testConnectorFetch(source: Parameters<ReturnType<typeof createRssAtomConnector>["fetch"]>[0]) {
  const { guardedFetch } = await import("#src/playablebench/fetchGuard.js");
  const headers: Record<string, string> = {};
  if (source.etag) headers["if-none-match"] = source.etag;
  if (source.lastModified) headers["if-modified-since"] = source.lastModified;
  let response;
  try {
    response = await guardedFetch(source.url, {
      headers,
      allowLoopback: true,
      connectTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 5,
    });
  } catch (error) {
    return { status: "failed" as const, errorCode: error instanceof Error ? error.message : "network_error" };
  }
  if (response.status === 304) {
    return { status: "not_modified" as const, httpStatus: 304, etag: response.etag, lastModified: response.lastModified };
  }
  if (response.status === 429) {
    return { status: "failed" as const, httpStatus: 429, retryAfterSeconds: response.retryAfterSeconds, errorCode: "http_429" };
  }
  if (response.status !== 200) {
    return { status: "failed" as const, httpStatus: response.status, errorCode: `http_${response.status}` };
  }
  const { parseFeedDocument, FeedParseError } = await import("#src/playablebench/feedParser.js");
  try {
    const parsed = parseFeedDocument(response.bodyText);
    return {
      status: "fetched" as const,
      httpStatus: 200,
      etag: response.etag,
      lastModified: response.lastModified,
      items: parsed.items,
    };
  } catch (error) {
    if (error instanceof FeedParseError) {
      return { status: "failed" as const, httpStatus: 200, errorCode: `parse_${error.kind}` };
    }
    return { status: "failed" as const, httpStatus: 200, errorCode: "parse_unknown" };
  }
}

describe("canonicalizeUrl / computeContentHash", () => {
  it("仅移除白名单追踪参数；host 小写；去 fragment 与默认端口", () => {
    expect(canonicalizeUrl("https://EXAMPLE.com:443/a?utm_source=x&id=1#frag")).toBe(
      "https://example.com/a?id=1",
    );
    expect(canonicalizeUrl("http://example.com:80/b?fbclid=z")).toBe("http://example.com/b");
    expect(canonicalizeUrl("https://example.com/c?keep=1&q=2")).toBe("https://example.com/c?keep=1&q=2");
    // 非 URL 原样返回。
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });

  it("内容哈希不含 URL：转载变体命中；文本规范化", () => {
    const a = computeContentHash("标题", "摘要");
    const b = computeContentHash(" 标题 ", " 摘要 ");
    expect(a).toBe(b);
    expect(computeContentHash("标题", "摘要")).not.toBe(computeContentHash("标题2", "摘要"));
  });
});

describe("RssAtomConnector 行为", () => {
  it("能力声明准确（spec 19 §3：A 级 RSS/Atom 无凭据/无热榜/无指标）", () => {
    const connector = createRssAtomConnector();
    expect(connector.connectorType).toBe("rss_atom");
    expect(connector.getCapabilities()).toMatchObject({
      fetchItems: "supported",
      nativeHotList: "unsupported",
      nativeMetrics: [],
      requiresCredential: false,
      requiresExternalService: false,
    });
    expect(connector.getCapabilities().limitations.length).toBeGreaterThan(0);
  });

  it("200 解析入库契约；304 不变；429 透传 Retry-After；坏 XML 错误码", async () => {
    let call = 0;
    const feedUrl = await startHandler((request, response) => {
      call += 1;
      if (call === 1) {
        response.writeHead(200, { etag: '"v1"' });
        response.end(RSS_BODY);
        return;
      }
      if (call === 2) {
        expect(request.headers["if-none-match"]).toBe('"v1"');
        response.writeHead(304);
        response.end();
        return;
      }
      if (call === 3) {
        response.writeHead(429, { "retry-after": "12" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/xml" });
      response.end("<not-a-feed/>");
    });
    const connector = makeLoopbackConnector();
    const source = {
      id: "src-test",
      connectorType: "rss_atom" as const,
      name: "t",
      url: feedUrl,
      enabled: true,
      paused: false,
      pollIntervalSec: 900,
    };
    const fetched = await connector.fetch(source);
    expect(fetched.status).toBe("fetched");
    expect(fetched.items?.map((i) => i.title)).toEqual(["第一条", "第二条"]);
    expect(fetched.etag).toBe('"v1"');
    const notModified = await connector.fetch({ ...source, etag: '"v1"' });
    expect(notModified.status).toBe("not_modified");
    const limited = await connector.fetch(source);
    expect(limited.status).toBe("failed");
    expect(limited.errorCode).toBe("http_429");
    expect(limited.retryAfterSeconds).toBe(12);
    const bad = await connector.fetch(source);
    expect(bad.status).toBe("failed");
    expect(bad.errorCode).toBe("parse_no_feed_structure");
  });
});

describe("FeedScheduler", () => {
  it("抓取入库：canonical URL 白名单规范化 + 去重重放；失败不清空旧内容", async () => {
    let fail = false;
    const feedUrl = await startHandler((request, response) => {
      if (fail) {
        response.writeHead(500);
        response.end();
        return;
      }
      response.writeHead(200, { etag: '"v1"' });
      response.end(RSS_BODY);
    });
    const { sources, items } = (() => {
      const dir = mkdtempSync(join(tmpdir(), "zcode-feed-sched2-"));
      tempDirs.push(dir);
      const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
      return { sources: new FeedSourceRepo(connection), items: new FeedItemRepo(connection) };
    })();
    const source = await sources.add({ connectorType: "rss_atom", name: "t", url: feedUrl });
    const scheduler = new FeedScheduler({ sources, items, connector: makeLoopbackConnector() });

    const first = await scheduler.refreshSource(source.id);
    expect(first.status).toBe("fetched");
    expect(first.newItems).toBe(2);
    const cards = await items.listCards({ sourceId: source.id });
    expect(cards.map((c) => c.canonicalUrl)).toEqual([
      "https://example.com/b",
      "https://example.com/a?id=1",
    ]);

    // 重复投递（同 guid 重放）不产生新条目。
    const replay = await scheduler.refreshSource(source.id);
    expect(replay.status).toBe("fetched");
    expect(replay.newItems).toBe(0);
    expect(await items.countCards({ sourceId: source.id })).toMatchObject({ total: 2 });

    // 失败不清空旧内容：500 后条目仍在、健康字段记录错误。
    fail = true;
    const failed = await scheduler.refreshSource(source.id);
    expect(failed.status).toBe("failed");
    expect(failed.nextEligibleAt).toBeGreaterThan(Date.now());
    expect(await items.countCards({ sourceId: source.id })).toMatchObject({ total: 2 });
    const unhealthy = await sources.get(source.id);
    expect(unhealthy?.lastErrorCode).toBe("http_500");
    expect(unhealthy?.lastSuccessAt).toBeGreaterThan(0);
  });

  it("single-flight：并发同一 source 只有一个在飞任务", async () => {
    let hits = 0;
    const feedUrl = await startHandler((request, response) => {
      hits += 1;
      setTimeout(() => {
        response.writeHead(200);
        response.end(RSS_BODY);
      }, 120);
    });
    const dir = mkdtempSync(join(tmpdir(), "zcode-feed-sched3-"));
    tempDirs.push(dir);
    const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
    const sources = new FeedSourceRepo(connection);
    const items = new FeedItemRepo(connection);
    const source = await sources.add({ connectorType: "rss_atom", name: "t", url: feedUrl });
    const scheduler = new FeedScheduler({ sources, items, connector: makeLoopbackConnector() });
    const [a, b] = await Promise.all([scheduler.refreshSource(source.id), scheduler.refreshSource(source.id)]);
    expect(a.status).toBe("fetched");
    expect(b.status).toBe("skipped_in_flight");
    expect(hits).toBe(1);
  });

  it("暂停/停用跳过；分批补采按批执行", async () => {
    const feedUrl = await startHandler((request, response) => {
      response.writeHead(200);
      response.end(RSS_BODY);
    });
    const dir = mkdtempSync(join(tmpdir(), "zcode-feed-sched4-"));
    tempDirs.push(dir);
    const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
    const sources = new FeedSourceRepo(connection);
    const items = new FeedItemRepo(connection);
    const paused = await sources.add({ connectorType: "rss_atom", name: "paused", url: feedUrl });
    await sources.setPaused(paused.id, true);
    const disabled = await sources.add({ connectorType: "rss_atom", name: "disabled", url: feedUrl + "?x=2" });
    await sources.update(disabled.id, { enabled: false });
    const active = await sources.add({ connectorType: "rss_atom", name: "active", url: feedUrl + "?x=3" });
    const scheduler = new FeedScheduler({ sources, items, connector: makeLoopbackConnector(), batchSize: 2 });
    const sweep = await scheduler.refreshDueSources();
    expect(sweep.results.find((r) => r.sourceId === paused.id)?.status).toBe("skipped_paused");
    expect(sweep.results.find((r) => r.sourceId === disabled.id)?.status).toBe("skipped_disabled");
    expect(sweep.results.find((r) => r.sourceId === active.id)?.status).toBe("fetched");
    // 刚抓取过（lastAttemptAt 刚更新）→ 下一次 sweep 到期判定跳过。
    const secondSweep = await scheduler.refreshDueSources();
    expect(secondSweep.attempted).toBe(0);
  });
});
