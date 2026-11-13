// Phase 4 存储层测试：0006→0007 迁移保数据、Feed 三表可用、去重约束、
// FTS content 表名逐字断言（吸取 0006 教训）+ rebuild 可用。
// 门禁对应 spec 16 Phase 4 与 spec 06 §3（去重索引/FTS 删除同步/重建）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-phase4-feed-"));
  tempDirs.push(dir);
  return join(dir, "tasks-index.sqlite");
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

async function importMigrations() {
  return import("#src/session/tasksDatabase/migrations.js");
}

describe("tasks-index migration 0007 (playablebench feed)", () => {
  it("0006 库升级到 0007 后既有数据保留且 Feed 三表可用", async () => {
    const { runTasksDatabaseMigrations, areTasksDatabaseMigrationsApplied } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    db.exec("PRAGMA journal_mode = WAL");
    try {
      // 建 0006 时代库：写一条笔记，移除 0007 账本行与对象，模拟旧库升级。
      runTasksDatabaseMigrations(db);
      db.prepare(
        `INSERT INTO pb_notes (id, title, body, created_at, updated_at)
         VALUES ('note-keep', '升级前笔记', 'legacy', 1, 1)`,
      ).run();
      db.exec(`DELETE FROM tasks_schema_migration WHERE id = '0007_playablebench_feed'`);
      db.exec(`
        DROP TRIGGER IF EXISTS pb_feed_items_fts_ai;
        DROP TRIGGER IF EXISTS pb_feed_items_fts_ad;
        DROP TRIGGER IF EXISTS pb_feed_items_fts_au;
        DROP INDEX IF EXISTS idx_pb_feed_metrics_sample;
        DROP INDEX IF EXISTS idx_pb_feed_items_seen;
        DROP INDEX IF EXISTS idx_pb_feed_items_source_published;
        DROP INDEX IF EXISTS idx_pb_feed_items_canonical;
        DROP INDEX IF EXISTS idx_pb_feed_items_source_hash;
        DROP INDEX IF EXISTS idx_pb_feed_items_source_item;
        DROP INDEX IF EXISTS idx_pb_feed_sources_enabled;
        DROP INDEX IF EXISTS idx_pb_feed_sources_url;
        DROP TABLE IF EXISTS fts_pb_feed_items;
        DROP TABLE IF EXISTS pb_feed_metric_snapshots;
        DROP TABLE IF EXISTS pb_feed_items;
        DROP TABLE IF EXISTS pb_feed_sources;
      `);

      runTasksDatabaseMigrations(db);
      expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
      const kept = db
        .prepare(`SELECT title FROM pb_notes WHERE id = 'note-keep'`)
        .get() as { title: string };
      expect(kept.title).toBe("升级前笔记");

      db.prepare(
        `INSERT INTO pb_feed_sources (id, connector_type, name, url, created_at, updated_at)
         VALUES ('src-1', 'rss_atom', '示例源', 'https://example.com/feed.xml', 1, 1)`,
      ).run();
      const sourceRow = db
        .prepare(`SELECT enabled, paused FROM pb_feed_sources WHERE id = 'src-1'`)
        .get() as { enabled: number; paused: number };
      expect(sourceRow.enabled).toBe(1);
      expect(sourceRow.paused).toBe(0);
    } finally {
      db.close();
    }
  });

  it("去重约束：(source_id, source_item_id) 与 (source_id, content_hash) 部分唯一", async () => {
    const { runTasksDatabaseMigrations } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    try {
      runTasksDatabaseMigrations(db);
      const insert = db.prepare(
        `INSERT INTO pb_feed_items
          (id, source_id, source_item_id, canonical_url, original_url, title,
           first_seen_at, last_seen_at, content_hash, created_at, updated_at)
         VALUES (?, 'src-1', ?, 'https://e.com/a', 'https://e.com/a?utm=x', '标题', 1, 1, ?, 1, 1)`,
      );
      insert.run("item-1", "guid-1", "hash-1");
      // 同源同 source_item_id：拒绝。
      expect(() => insert.run("item-2", "guid-1", "hash-2")).toThrow();
      // 同源同 content_hash：拒绝（同源重复内容）。
      expect(() => insert.run("item-3", "guid-2", "hash-1")).toThrow();
      // source_item_id 为空不受 (source_id, source_item_id) 约束。
      db.prepare(
        `INSERT INTO pb_feed_items
          (id, source_id, canonical_url, original_url, title, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ('item-4', 'src-1', 'https://e.com/b', 'https://e.com/b', '无 guid', 2, 2, 2, 2)`,
      ).run();
      // content_hash 为空不受 (source_id, content_hash) 约束。
      db.prepare(
        `INSERT INTO pb_feed_items
          (id, source_id, canonical_url, original_url, title, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ('item-5', 'src-1', 'https://e.com/c', 'https://e.com/c', '无哈希', 3, 3, 3, 3)`,
      ).run();
    } finally {
      db.close();
    }
  });

  it("FTS content 表逐字为 pb_feed_items；触发器同步与 rebuild 可用", async () => {
    const { runTasksDatabaseMigrations } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    try {
      runTasksDatabaseMigrations(db);
      // 0006 教训：content 表名必须逐字比对，防止重命名漏改复发。
      const ftsSql = db
        .prepare(`SELECT sql FROM sqlite_master WHERE name = 'fts_pb_feed_items'`)
        .get() as { sql: string };
      expect(ftsSql.sql).toContain("content='pb_feed_items'");

      db.prepare(
        `INSERT INTO pb_feed_items
          (id, source_id, canonical_url, original_url, title, summary, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ('item-1', 'src-1', 'https://e.com/a', 'https://e.com/a', '错误边界重构', 'error boundary 讨论', 1, 1, 1, 1)`,
      ).run();
      const hit = db
        .prepare(
          `SELECT pb_feed_items.id FROM fts_pb_feed_items JOIN pb_feed_items ON pb_feed_items.rowid = fts_pb_feed_items.rowid
           WHERE fts_pb_feed_items MATCH 'boundary'`,
        )
        .all() as Array<{ id: string }>;
      expect(hit.map((r) => r.id)).toEqual(["item-1"]);

      // 幽灵行漂移后 rebuild 收敛（spec 06 §3）。
      db.prepare(`INSERT INTO fts_pb_feed_items(rowid, title, summary) VALUES (999999, 'ghost', 'drift')`).run();
      const domain = await import("#src/session/tasksDatabase/playablebench-feed-v7.js");
      db.exec(domain.PB_FEED_FTS_REBUILD_SQL);
      const ghost = db
        .prepare(
          `SELECT pb_feed_items.id FROM fts_pb_feed_items JOIN pb_feed_items ON pb_feed_items.rowid = fts_pb_feed_items.rowid
           WHERE fts_pb_feed_items MATCH 'ghost'`,
        )
        .all() as Array<{ id: string }>;
      expect(ghost).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("同 URL 视为同一来源（source url 唯一）；metric 采样键唯一", async () => {
    const { runTasksDatabaseMigrations } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    try {
      runTasksDatabaseMigrations(db);
      db.prepare(
        `INSERT INTO pb_feed_sources (id, connector_type, name, url, created_at, updated_at)
         VALUES ('src-1', 'rss_atom', '源A', 'https://example.com/feed.xml', 1, 1)`,
      ).run();
      expect(() =>
        db.prepare(
          `INSERT INTO pb_feed_sources (id, connector_type, name, url, created_at, updated_at)
           VALUES ('src-2', 'rss_atom', '源B', 'https://example.com/feed.xml', 2, 2)`,
        ).run(),
      ).toThrow();

      db.prepare(
        `INSERT INTO pb_feed_items
          (id, source_id, canonical_url, original_url, title, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ('item-1', 'src-1', 'https://e.com/a', 'https://e.com/a', '标题', 1, 1, 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO pb_feed_metric_snapshots
          (id, feed_item_id, source_id, sampled_at, metric_name, metric_value, metric_origin)
         VALUES ('m-1', 'item-1', 'src-1', 100, 'comment_count', '42', 'native_source')`,
      ).run();
      // 同 item 同指标同采样时刻：拒绝（重复采样幂等去重）。
      expect(() =>
        db.prepare(
          `INSERT INTO pb_feed_metric_snapshots
            (id, feed_item_id, source_id, sampled_at, metric_name, metric_value, metric_origin)
           VALUES ('m-2', 'item-1', 'src-1', 100, 'comment_count', '43', 'native_source')`,
        ).run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
