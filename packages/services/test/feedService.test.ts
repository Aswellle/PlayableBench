// 信息雷达服务面测试（spec 08 §4 卡片契约、spec 16 Phase 4）：添加/暂停/删除、
// 手动刷新（含 skipped 语义）、统一卡片查询、收藏/已读、能力声明进来源。
// 强制注入临时库路径 + loopback 测试 connector（SSRF 拒绝语义在 fetchGuard 测试）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFeedService } from "#src/playablebench/feedServiceHost.js";
import type { FeedConnector } from "#src/playablebench/feedConnector.js";

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

const RSS_BODY = `<?xml version="1.0"?><rss version="2.0"><channel><title>测试源</title>
<item><title>第一条</title><link>https://example.com/a?utm_source=x&amp;id=1</link><guid>g-1</guid>
<description>摘要一</description></item>
</channel></rss>`;

function makeHarness(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
  options?: { schedulerPollIntervalMs?: number },
) {
  const { createServer } = require("node:http") as typeof import("node:http");
  const { once } = require("node:events") as typeof import("node:events");
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  const portReady = once(server, "listening");
  const dir = mkdtempSync(join(tmpdir(), "zcode-feed-service-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "tasks-index.sqlite");
  const connector: FeedConnector = {
    connectorType: "rss_atom",
    getCapabilities: () => ({
      fetchItems: "supported",
      nativeHotList: "unsupported",
      nativeMetrics: [],
      requiresCredential: false,
      requiresExternalService: false,
      lastValidatedAt: "2026-11-14",
      limitations: ["test connector"],
    }),
    // 测试 connector 与生产管线一致，但目标在本机：经 fetchGuard 放行 loopback 由
    // fetchGuard 测试覆盖拒绝语义，此处仅注入连接选项。
    fetch: async (source) => {
      await portReady;
      void server;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const real = new URL(source.url);
      real.protocol = "http:"; // 本机测试服务器为纯 http
      real.hostname = "127.0.0.1";
      real.port = String(address.port);
      const { guardedFetch } = await import("#src/playablebench/fetchGuard.js");
      const response = await guardedFetch(real.toString(), {
        allowLoopback: true,
        maxBytes: 2 * 1024 * 1024,
      });
      if (response.status !== 200) {
        return {
          status: "failed" as const,
          httpStatus: response.status,
          errorCode: `http_${response.status}`,
        };
      }
      const { parseFeedDocument, FeedParseError } =
        await import("#src/playablebench/feedParser.js");
      try {
        const parsed = parseFeedDocument(response.bodyText);
        return { status: "fetched" as const, httpStatus: 200, items: parsed.items };
      } catch (error) {
        if (error instanceof FeedParseError) {
          return { status: "failed" as const, httpStatus: 200, errorCode: `parse_${error.kind}` };
        }
        return { status: "failed" as const, httpStatus: 200, errorCode: "parse_unknown" };
      }
    },
  };
  const service = createFeedService({
    dbPath,
    connector,
    ...(options?.schedulerPollIntervalMs !== undefined
      ? { schedulerPollIntervalMs: options.schedulerPollIntervalMs }
      : {}),
  });
  return { service, server, dbPath };
}

describe("IFeedService 服务面", () => {
  it("添加来源：非 http(s) 立即拒绝；默认名取主机名；能力声明落到来源", async () => {
    const { service } = makeHarness(() => undefined);
    await expect(service.addSource({ url: "file:///etc/passwd" })).rejects.toMatchObject({
      kind: "ssrf_forbidden_scheme",
    });
    await expect(service.addSource({ url: "http://169.254.169.254/meta" })).rejects.toMatchObject({
      kind: "ssrf_forbidden_host",
    });
    const source = await service.addSource({ url: "https://blog.example.com/feed.xml" });
    expect(source.name).toBe("blog.example.com");
    expect(source.connectorType).toBe("rss_atom");
    expect(source.capabilities?.fetchItems).toBe("supported");
    expect(source.capabilities?.requiresCredential).toBe(false);
  });

  it("手动刷新入库：卡片契约字段齐备；重复刷新去重；暂停返回 skipped", async () => {
    const { service } = makeHarness((request, response) => {
      response.writeHead(200, { etag: '"v1"' });
      response.end(RSS_BODY);
    });
    const source = await service.addSource({ url: "https://blog.example.com/feed.xml" });

    const refresh = await service.refreshSource(source.id);
    expect(refresh.status).toBe("fetched");
    expect(refresh.newItems).toBe(1);

    const cards = await service.listCards();
    const card = cards[0];
    expect(card).toMatchObject({
      title: "第一条",
      canonicalUrl: "https://example.com/a?id=1",
      sourceId: source.id,
    });
    expect(card.originalUrl).toContain("utm_source=x"); // 原始 URL 逐字保留
    expect(card.firstSeenAt).toBeGreaterThan(0);

    const replay = await service.refreshSource(source.id);
    expect(replay.status).toBe("fetched");
    expect(replay.newItems).toBe(0);
    expect(await service.getCardCounts()).toMatchObject({ total: 1, unread: 1 });

    await service.pauseSource(source.id, true);
    const skipped = await service.refreshSource(source.id);
    expect(skipped.status).toBe("skipped_paused");
    await service.pauseSource(source.id, false);

    await service.setFavorite(cards[0]?.id ?? "", true);
    const favorites = await service.listCards({ favoritesOnly: true });
    expect(favorites).toHaveLength(1);
    const afterRead = await service.markRead(cards[0]?.id ?? "", true);
    expect(afterRead?.readAt).toBeGreaterThan(0);
    expect(await service.getCardCounts()).toMatchObject({ unread: 0, favorites: 1 });

    const removed = await service.removeSource(source.id);
    expect(removed).toBe(true);
    expect(await service.listCards()).toHaveLength(0);
  });

  it("卡片转任务：逐字入 Inbox 后转任务；重复触发幂等复用（spec 16 门禁）", async () => {
    const { service, dbPath } = makeHarness((request, response) => {
      response.writeHead(200);
      response.end(RSS_BODY);
    });
    const source = await service.addSource({ url: "https://blog.example.com/feed.xml" });
    await service.refreshSource(source.id);
    const cards = await service.listCards();
    const card = cards[0]!;

    const first = await service.convertCardToTask({
      cardId: card.id,
      workspacePath: "/tmp/ws",
      priority: "high",
    });
    expect(first.reused).toBe(false);
    expect(first.task?.title).toBe("第一条");
    expect(first.task?.priority).toBe("high");

    // 重复触发：同卡片原始 URL 已成功转换 → 幂等复用同一任务。
    const second = await service.convertCardToTask({ cardId: card.id, workspacePath: "/tmp/ws" });
    expect(second.reused).toBe(true);
    expect(second.task?.taskId).toBe(first.task?.taskId);

    // Inbox 原始输入逐字保留（标题 + 原文 URL 两行）；经独立实例读同一库文件。
    const { InboxRepo } = await import("#src/session/inboxRepo.js");
    const probeRepo = new InboxRepo(dbPath);
    const probe = await probeRepo.get(first.inboxItemId);
    expect(probe?.rawInput).toBe(`第一条\n${card.originalUrl}`);
    expect(probe?.sourceUrl).toBe(card.originalUrl);

    await expect(
      service.convertCardToTask({ cardId: "missing", workspacePath: "/tmp/ws" }),
    ).rejects.toMatchObject({ kind: "card_not_found" });
  });

  it("常驻调度：到期来源自动补采；stopScheduler 停止", async () => {
    const { service, server } = makeHarness(
      (request, response) => {
        response.writeHead(200);
        response.end(RSS_BODY);
      },
      { schedulerPollIntervalMs: 15 },
    );
    void server;
    try {
      const source = await service.addSource({ url: "https://blog.example.com/feed.xml" });
      // 等待若干个 tick 内完成自动扫描入库。
      await new Promise((resolve) => setTimeout(resolve, 400));
      const counts = await service.getCardCounts();
      expect(counts.total).toBeGreaterThanOrEqual(1);
      void source;
    } finally {
      (service as { stopScheduler?(): void }).stopScheduler?.();
    }
  });

  it("抓取失败：状态/错误码返回，旧内容保留（spec 16 门禁）", async () => {
    let fail = false;
    const { service } = makeHarness((request, response) => {
      if (fail) {
        response.writeHead(429, { "retry-after": "9" });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(RSS_BODY);
    });
    const source = await service.addSource({ url: "https://blog.example.com/feed.xml" });
    await service.refreshSource(source.id);
    expect(await service.getCardCounts()).toMatchObject({ total: 1 });

    fail = true;
    const refresh = await service.refreshSource(source.id);
    expect(refresh.status).toBe("failed");
    expect(refresh.errorCode).toBe("http_429");
    expect(refresh.nextEligibleAt).toBeGreaterThan(Date.now());
    // 失败不清空旧内容（spec 16 门禁）。
    expect(await service.getCardCounts()).toMatchObject({ total: 1, unread: 1 });
  });
});
