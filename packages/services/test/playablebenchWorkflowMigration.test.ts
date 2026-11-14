// 信息到工作流闭环存储层测试：0007→0008 迁移保数据、WorkflowTemplate 复合
// 主键（版本不可静默变更）、摘要缓存唯一键（同卡同模型 / 同内容同模型跨源）、
// model_version 空串语义（UNIQUE 索引 NULL 不相等，空串避免重复行）。
// 门禁对应 spec 16（摘要可追溯/幂等保护）与 spec 06 §2（WorkflowTemplate）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-workflow-"));
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

describe("tasks-index migration 0008 (workflow + feed summaries)", () => {
  it("0007 库升级到 0008 后既有数据保留且新表可用；账本完整", async () => {
    const { runTasksDatabaseMigrations, areTasksDatabaseMigrationsApplied } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    db.exec("PRAGMA journal_mode = WAL");
    try {
      // 建 0007 时代库并写入升级前数据，模拟旧库升级。
      runTasksDatabaseMigrations(db);
      db.prepare(
        `INSERT INTO pb_notes (id, title, body, created_at, updated_at)
         VALUES ('note-keep', '升级前笔记', 'legacy', 1, 1)`,
      ).run();
      db.exec(`DELETE FROM tasks_schema_migration WHERE id = '0008_playablebench_workflow'`);
      db.exec(`DROP TABLE IF EXISTS pb_feed_summaries`);
      db.exec(`DROP TABLE IF EXISTS pb_workflow_templates`);

      runTasksDatabaseMigrations(db);
      expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
      const kept = db
        .prepare(`SELECT title FROM pb_notes WHERE id = 'note-keep'`)
        .get() as { title: string };
      expect(kept.title).toBe("升级前笔记");
      // 两张新表可写可查。
      db.prepare(
        `INSERT INTO pb_workflow_templates (id, version, name, created_at)
         VALUES ('research_article', 'v1', '研究一篇文章', 1)`,
      ).run();
      const template = db
        .prepare(`SELECT name FROM pb_workflow_templates WHERE id='research_article' AND version='v1'`)
        .get() as { name: string };
      expect(template.name).toBe("研究一篇文章");
    } finally {
      db.close();
    }
  });

  it("模板 (id, version) 复合主键：同 id 不同版本共存，同版本冲突拒绝", async () => {
    const { runTasksDatabaseMigrations } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    db.exec("PRAGMA journal_mode = WAL");
    try {
      runTasksDatabaseMigrations(db);
      const insert = db.prepare(
        `INSERT INTO pb_workflow_templates (id, version, name, created_at) VALUES (?, ?, ?, ?)`,
      );
      insert.run("t", "v1", "one", 1);
      insert.run("t", "v2", "two", 2);
      expect(db.prepare(`SELECT count(*) AS n FROM pb_workflow_templates`).get()).toMatchObject({ n: 2 });
      expect(() => insert.run("t", "v1", "dup", 3)).toThrow();
    } finally {
      db.close();
    }
  });

  it("摘要缓存唯一键：同卡同模型唯一；同内容跨卡命中；model_version 空串防 NULL 重复", async () => {
    const { runTasksDatabaseMigrations } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    db.exec("PRAGMA journal_mode = WAL");
    try {
      runTasksDatabaseMigrations(db);
      const insert = db.prepare(
        `INSERT INTO pb_feed_summaries
           (id, feed_item_id, content_hash, source_url, title, model, model_version, summary_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run("s1", "item-1", "h1", "https://example.com/a", "标题", "m", "", "摘要", 1);
      // 同卡同模型重复 → 拒绝。
      expect(() => insert.run("s2", "item-1", "h1", "https://example.com/a", "标题", "m", "", "重复", 2)).toThrow();
      // 同内容跨卡（镜像）→ 唯一键拒绝（缓存命中场景，由 repo 层先查后写）。
      expect(() => insert.run("s3", "item-2", "h1", "https://example.com/b", "标题", "m", "", "镜像", 3)).toThrow();
      // 不同模型 → 允许并存。
      insert.run("s4", "item-1", "h1", "https://example.com/a", "标题", "m2", "", "另一模型", 4);
      // 无 content_hash（镜像前未见规范化正文）的条目不做内容级缓存去重：
      // (content_hash, model, model_version) 为部分唯一索引，NULL 哈希行可并存。
      insert.run("s5", "item-9", null, "https://example.com/c", "标题", "m", "", "无哈希", 5);
      expect(() =>
        insert.run("s6", "item-10", null, "https://example.com/d", "标题", "m", "", "无哈希2", 6),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
