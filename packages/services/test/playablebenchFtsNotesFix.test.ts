// 0006 修复测试：fts_pb_notes 影子表 content 重指向 pb_notes 后，触发器同步
// 与 rebuild 均可用（修复前 rebuild 因内容表 'notes' 不存在而必失败）。
// 覆盖：全新库、0004 时代库升级两条路径 + 幽灵行 rebuild 收敛（spec 06 §3）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-fts-notes-fix-"));
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

async function insertNoteAndAssertSearchable(db: InstanceType<typeof DatabaseSync>): Promise<void> {
  db.prepare(
    `INSERT INTO pb_notes (id, title, body, created_at, updated_at)
     VALUES ('note-1', '重建验证标题', 'notes rebuild probe content 重建探针', 1, 1)`,
  ).run();
  const hit = db
    .prepare(
      `SELECT pb_notes.id FROM fts_pb_notes JOIN pb_notes ON pb_notes.rowid = fts_pb_notes.rowid
       WHERE fts_pb_notes MATCH 'rebuild'`,
    )
    .all() as Array<{ id: string }>;
  expect(hit.map((r) => r.id)).toEqual(["note-1"]);
}

describe("migration 0006 fts_pb_notes 重指向", () => {
  it("全新库：notes 全文检索同步与 rebuild 可用", async () => {
    const { runTasksDatabaseMigrations, PLAYABLEBENCH_FTS_REBUILD_SQL } = await import(
      "#src/session/tasksDatabase/migrations.js"
    );
    void PLAYABLEBENCH_FTS_REBUILD_SQL;
    const domain = await import("#src/session/tasksDatabase/playablebench-domain-v4.js");
    const db = new DatabaseSync(makeDbPath());
    try {
      runTasksDatabaseMigrations(db);
      await insertNoteAndAssertSearchable(db);
      // 幽灵行模拟索引漂移，rebuild 重扫 pb_notes 后收敛（修复前此步必失败）。
      db.prepare(`INSERT INTO fts_pb_notes(rowid, title, body) VALUES (999999, 'ghost', 'ghost drift')`).run();
      db.exec(domain.PLAYABLEBENCH_FTS_REBUILD_SQL);
      const ghost = db
        .prepare(
          `SELECT pb_notes.id FROM fts_pb_notes JOIN pb_notes ON pb_notes.rowid = fts_pb_notes.rowid
           WHERE fts_pb_notes MATCH 'ghost'`,
        )
        .all() as Array<{ id: string }>;
      expect(ghost).toHaveLength(0);
      const still = db
        .prepare(
          `SELECT pb_notes.id FROM fts_pb_notes JOIN pb_notes ON pb_notes.rowid = fts_pb_notes.rowid
           WHERE fts_pb_notes MATCH 'rebuild'`,
        )
        .all() as Array<{ id: string }>;
      expect(still).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("0005 时代库升级到 0006：既有 notes 数据进索引，内容表为 pb_notes", async () => {
    const { runTasksDatabaseMigrations, areTasksDatabaseMigrationsApplied } = await import(
      "#src/session/tasksDatabase/migrations.js"
    );
    const db = new DatabaseSync(makeDbPath());
    try {
      // 建 0005 时代库：移除 0006 账本行并按 0005 时代的错误定义重建影子表。
      runTasksDatabaseMigrations(db);
      db.prepare(`DELETE FROM tasks_schema_migration WHERE id = '0006_fts_pb_notes_repoint'`).run();
      db.exec(`
        DROP TRIGGER IF EXISTS pb_notes_fts_ai;
        DROP TRIGGER IF EXISTS pb_notes_fts_ad;
        DROP TRIGGER IF EXISTS pb_notes_fts_au;
        DROP TABLE IF EXISTS fts_pb_notes;
        CREATE VIRTUAL TABLE fts_pb_notes USING fts5(
          title, body, content='notes', content_rowid='rowid', tokenize='trigram'
        );
        CREATE TRIGGER pb_notes_fts_ai AFTER INSERT ON pb_notes BEGIN
          INSERT INTO fts_pb_notes(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
      `);
      db.prepare(
        `INSERT INTO pb_notes (id, title, body, created_at, updated_at)
         VALUES ('note-legacy', '升级前笔记', 'legacy rebuild probe 遗留探针', 1, 1)`,
      ).run();
      // 修复前状态：rebuild 必失败（内容表 notes 不存在）。
      const domain = await import("#src/session/tasksDatabase/playablebench-domain-v4.js");
      expect(() => db.exec(domain.PLAYABLEBENCH_FTS_REBUILD_SQL)).toThrow();

      runTasksDatabaseMigrations(db);
      expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
      const contentTable = db
        .prepare(`SELECT sql FROM sqlite_master WHERE name = 'fts_pb_notes'`)
        .get() as { sql: string };
      expect(contentTable.sql).toContain("content='pb_notes'");
      // 升级即 rebuild：遗留笔记已进索引，rebuild 全量可用。
      const hit = db
        .prepare(
          `SELECT pb_notes.id FROM fts_pb_notes JOIN pb_notes ON pb_notes.rowid = fts_pb_notes.rowid
           WHERE fts_pb_notes MATCH 'legacy'`,
        )
        .all() as Array<{ id: string }>;
      expect(hit.map((r) => r.id)).toEqual(["note-legacy"]);
      expect(() => db.exec(domain.PLAYABLEBENCH_FTS_REBUILD_SQL)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
