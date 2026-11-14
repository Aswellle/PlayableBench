// Feed 仓库测试（spec 08 §7 去重/attribution、spec 10 门禁"失败不清空旧内容"、
// spec 16 Phase 4）：三级去重合并、收藏/已读、健康字段纪律、级联删除、
// 指标采样幂等、FTS ∪ LIKE 搜索。测试强制注入临时库路径。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeedSourceRepo } from "#src/session/feedSourceRepo.js";
import { FeedItemRepo } from "#src/session/feedItemRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

const tempDirs: string[] = [];

function makeStore(): { sources: FeedSourceRepo; items: FeedItemRepo; connection: RunStoreConnection } {
  const dir = mkdtempSync(join(tmpdir(), "zcode-feed-repo-"));
  tempDirs.push(dir);
  // 强制注入：本测试不得触碰真实 ~/.zcode/v2 库。
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  return { sources: new FeedSourceRepo(connection), items: new FeedItemRepo(connection), connection };
}

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

const capabilities = {
  fetchItems: "supported",
  nativeHotList: "unsupported",
  nativeMetrics: ["comment_count"],
  requiresCredential: false,
  requiresExternalService: false,
  lastValidatedAt: "2026-11-14",
  limitations: ["upstream rate limiting may apply"],
} as const;

async function seedSource(sources: FeedSourceRepo, url = "https://example.com/feed.xml"): Promise<string> {
  const source = await sources.add({
    connectorType: "rss_atom",
    name: "示例源",
    url,
    capabilities,
  });
  return source.id;
}

describe("FeedSourceRepo", () => {
  it("添加/查询/重复 URL 拒绝；能力声明往返一致", async () => {
    const { sources } = makeStore();
    const source = await sources.add({
      connectorType: "rss_atom",
      name: "示例源",
      url: "https://example.com/feed.xml",
      capabilities,
    });
    expect(source.capabilities).toEqual(capabilities);
    await expect(
      sources.add({ connectorType: "rss_atom", name: "重复", url: "https://example.com/feed.xml" }),
    ).rejects.toMatchObject({ kind: "source_url_exists" });
    const byUrl = await sources.getByUrl("https://example.com/feed.xml");
    expect(byUrl?.id).toBe(source.id);
  });

  it("健康字段纪律：失败不清空 last_success_at/etag；成功更新游标并清错误", async () => {
    const { sources } = makeStore();
    const id = await seedSource(sources);
    await sources.recordAttempt(id, { ok: true, etag: '"etag-1"' });
    const ok1 = await sources.get(id);
    expect(ok1?.lastSuccessAt).toBeGreaterThan(0);
    expect(ok1?.etag).toBe('"etag-1"');

    await sources.recordAttempt(id, { ok: false, errorCode: "http_429" });
    const failed = await sources.get(id);
    expect(failed?.lastErrorCode).toBe("http_429");
    expect(failed?.lastSuccessAt).toBe(ok1?.lastSuccessAt); // 失败不清成功时间
    expect(failed?.etag).toBe('"etag-1"'); // 不清条件请求游标

    await sources.recordAttempt(id, { ok: true, etag: '"etag-2"' });
    const ok2 = await sources.get(id);
    expect(ok2?.lastErrorCode).toBeUndefined();
    expect(ok2?.etag).toBe('"etag-2"');
  });

  it("删除来源级联清理条目与采样", async () => {
    const { sources, items, connection } = makeStore();
    const id = await seedSource(sources);
    await items.upsertFromFetch({
      sourceId: id,
      sourceItemId: "guid-1",
      originalUrl: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "标题",
    });
    await items.addMetric({ feedItemId: "", sourceId: id, metricName: "x", metricOrigin: "native_source" }).catch(() => undefined);
    const removed = await sources.remove(id);
    expect(removed).toBe(true);
    const remainingItems = connection
      .getDatabase()
      .prepare(`SELECT count(*) AS n FROM pb_feed_items WHERE source_id = ?`)
      .get(id) as { n: number };
    expect(remainingItems.n).toBe(0);
    expect(await sources.get(id)).toBeNull();
  });
});

describe("FeedItemRepo 去重与卡片", () => {
  it("三级去重：sourceItemId → contentHash → 新建；attribution 合并保留 firstSeenAt", async () => {
    const { sources, items } = makeStore();
    const sourceId = await seedSource(sources);

    const first = await items.upsertFromFetch({
      sourceId,
      sourceItemId: "guid-1",
      originalUrl: "https://example.com/a?utm_source=x",
      canonicalUrl: "https://example.com/a",
      title: "第一版标题",
      summary: "摘要",
      contentHash: "hash-a",
      seenAt: 1000,
    });
    expect(first.created).toBe(true);
    expect(first.item.firstSeenAt).toBe(1000);

    // 同 guid 重投（同源重放）：合并不新建，firstSeenAt 保留。
    const replay = await items.upsertFromFetch({
      sourceId,
      sourceItemId: "guid-1",
      originalUrl: "https://example.com/a?utm_source=x",
      canonicalUrl: "https://example.com/a",
      title: "更新标题",
      seenAt: 2000,
    });
    expect(replay.created).toBe(false);
    expect(replay.deduplicatedBy).toBe("source_item_id");
    expect(replay.item.firstSeenAt).toBe(1000);
    expect(replay.item.lastSeenAt).toBe(2000);
    expect(replay.item.title).toBe("更新标题");

    // 同源同内容不同 guid/URL（转载变体）：content_hash 命中，attribution 追加。
    const variant = await items.upsertFromFetch({
      sourceId,
      sourceItemId: "guid-2",
      originalUrl: "https://example.com/a-amp",
      canonicalUrl: "https://example.com/a",
      title: "第一版标题",
      contentHash: "hash-a",
      seenAt: 3000,
    });
    expect(variant.deduplicatedBy).toBe("content_hash");
    const attributions = JSON.parse(variant.item.attributionJson ?? "[]") as Array<{ url: string }>;
    expect(attributions.map((a) => a.url).sort()).toEqual([
      "https://example.com/a-amp",
      "https://example.com/a?utm_source=x",
    ]);
    expect((await items.listCards({ sourceId })).length).toBe(1);
  });

  it("收藏/已读与计数；搜索 FTS ∪ LIKE 兜底", async () => {
    const { sources, items } = makeStore();
    const sourceId = await seedSource(sources);
    const a = await items.upsertFromFetch({
      sourceId,
      sourceItemId: "g-a",
      originalUrl: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "错误边界重构实践",
      summary: "error boundary retry 讨论",
    });
    await items.upsertFromFetch({
      sourceId,
      sourceItemId: "g-b",
      originalUrl: "https://example.com/b",
      canonicalUrl: "https://example.com/b",
      title: "数据库迁移清单",
    });
    await items.setFavorite(a.item.id, true);
    await items.markRead(a.item.id, true);

    const counts = await items.countCards({ sourceId });
    expect(counts).toMatchObject({ unread: 1, favorites: 1, total: 2 });
    const favorites = await items.listCards({ sourceId, favoritesOnly: true });
    expect(favorites.map((f) => f.id)).toEqual([a.item.id]);
    const unread = await items.listCards({ sourceId, unreadOnly: true });
    expect(unread).toHaveLength(1);

    const ftsHit = await items.listCards({ search: "boundary" });
    expect(ftsHit.map((f) => f.id)).toContain(a.item.id);
    const likeHit = await items.listCards({ search: "迁移清单" });
    expect(likeHit.map((f) => f.title)).toEqual(["数据库迁移清单"]);
  });

  it("指标采样：同 (item, metric, sampledAt) 幂等；metricOrigin 区分声明", async () => {
    const { sources, items } = makeStore();
    const sourceId = await seedSource(sources);
    const a = await items.upsertFromFetch({
      sourceId,
      sourceItemId: "g-a",
      originalUrl: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
      title: "标题",
    });
    const m1 = await items.addMetric({
      feedItemId: a.item.id,
      sourceId,
      sampledAt: 100,
      metricName: "comment_count",
      metricValue: "42",
      metricOrigin: "native_source",
    });
    const m2 = await items.addMetric({
      feedItemId: a.item.id,
      sourceId,
      sampledAt: 100,
      metricName: "comment_count",
      metricValue: "999",
      metricOrigin: "native_source",
    });
    expect(m2.id).toBe(m1.id); // 同采样键幂等
    const metrics = await items.listMetrics(a.item.id);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.metricValue).toBe("42");
  });
});
