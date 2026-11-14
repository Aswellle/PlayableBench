// 导出/备份最小版测试（spec 06 §5、spec 15 §5；Phase 2 S5 顺延补课验收）。
// 门禁：用户可导出核心数据；manifest 含版本/哈希；恢复先预览且无确认不写入；
// 密钥与凭据不进备份清单；FTS 影子表恢复后 rebuild 可用。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_TABLES,
  createBackupExport,
  previewBackupImport,
  restoreBackup,
} from "#src/playablebench/backupExport.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

const tempDirs: string[] = [];

function makeConnection(): RunStoreConnection {
  const dir = mkdtempSync(join(tmpdir(), "zcode-backup-"));
  tempDirs.push(dir);
  return new RunStoreConnection(join(dir, "tasks-index.sqlite"));
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

describe("备份导出与恢复", () => {
  it("导出含 manifest（format/appVersion/schemaVersion/每表哈希），凭据不在清单", async () => {
    const connection = makeConnection();
    await connection.ensureReady();
    const db = connection.getDatabase();
    db.prepare(`INSERT INTO pb_inbox_items (id, kind, raw_input, status, created_at, updated_at)
      VALUES ('inbox-1', 'text', '备份探针', 'unprocessed', 1, 1)`).run();
    db.prepare(`INSERT INTO tasks (
        workspace_key, workspace_path, task_id, title, mode, created_at, updated_at, searchable_text
      ) VALUES ('ws', '/tmp/ws', 'task-1', '备份任务', 'default', 1, 1, '正文')`).run();

    const file = await createBackupExport(connection, { appVersion: "2026.11.14-test" });
    expect(file.format).toBe("playablebench-backup-v1");
    expect(file.appVersion).toBe("2026.11.14-test");
    expect(file.schemaVersion).toBe("0008_playablebench_workflow");
    const tables = file.contents.map((c) => c.table);
    expect(tables).toEqual([...BACKUP_TABLES]);
    expect(tables.some((t) => t.toLowerCase().includes("credential"))).toBe(false);
    const inbox = file.contents.find((c) => c.table === "pb_inbox_items");
    expect(inbox?.rowCount).toBe(1);
    expect(JSON.stringify(inbox?.rows)).toContain("备份探针");
    expect(inbox?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("恢复预览：未确认不写入；confirm 后数据一致且 FTS 可重建", async () => {
    const source = makeConnection();
    await source.ensureReady();
    const sourceDb = source.getDatabase();
    sourceDb
      .prepare(`INSERT INTO pb_notes (id, title, body, created_at, updated_at)
      VALUES ('note-1', '恢复验证', 'restore probe 恢复探针', 1, 1)`)
      .run();
    sourceDb
      .prepare(`INSERT INTO tasks (
        workspace_key, workspace_path, task_id, title, mode, created_at, updated_at, searchable_text
      ) VALUES ('ws', '/tmp/ws', 'task-keep', '保留任务', 'default', 1, 1, '正文')`)
      .run();
    const file = await createBackupExport(source);

    // 目标库为全新空库（已迁移）：先写一条会被恢复覆盖清理的行。
    const target = makeConnection();
    await target.ensureReady();
    const targetDb = target.getDatabase();
    targetDb
      .prepare(`INSERT INTO pb_notes (id, title, body, created_at, updated_at)
      VALUES ('note-stale', '将被清除', 'stale', 1, 1)`)
      .run();

    const preview = await previewBackupImport(file, target);
    expect(preview.valid).toBe(true);
    expect(preview.issues).toEqual([]);
    expect(preview.manifest.tables.find((t) => t.table === "pb_notes")?.rowCount).toBe(1);
    expect(preview.targetSchemaVersion).toBe("0008_playablebench_workflow");

    // 未确认必须拒绝（spec 06 §5）。
    await expect(restoreBackup(file, target, { confirm: false })).rejects.toMatchObject({
      kind: "restore_not_confirmed",
    });
    // 预览后目标库未被改动。
    const untouched = targetDb.prepare(`SELECT id FROM pb_notes`).all() as Array<{ id: string }>;
    expect(untouched.map((r) => r.id)).toEqual(["note-stale"]);

    const result = await restoreBackup(file, target, { confirm: true });
    expect(result.restoredTables).toContain("pb_notes");
    const notes = targetDb.prepare(`SELECT id FROM pb_notes`).all() as Array<{ id: string }>;
    expect(notes.map((r) => r.id)).toEqual(["note-1"]);
    const tasks = targetDb.prepare(`SELECT task_id FROM tasks`).all() as Array<{ task_id: string }>;
    expect(tasks.map((r) => r.task_id)).toEqual(["task-keep"]);
    // FTS 影子表未随备份走：恢复后 rebuild 建索引且可检索。
    const domain = await import("#src/session/tasksDatabase/playablebench-domain-v4.js");
    targetDb.exec(domain.PLAYABLEBENCH_FTS_REBUILD_SQL);
    const hit = targetDb
      .prepare(`SELECT pb_notes.id FROM fts_pb_notes JOIN pb_notes ON pb_notes.rowid = fts_pb_notes.rowid
        WHERE fts_pb_notes MATCH 'restore'`)
      .all() as Array<{ id: string }>;
    expect(hit.map((r) => r.id)).toEqual(["note-1"]);
  });

  it("Feed/摘要/模板域表随备份导出并恢复；恢复后 feed FTS 可检索", async () => {
    const source = makeConnection();
    await source.ensureReady();
    const sourceDb = source.getDatabase();
    sourceDb
      .prepare(
        `INSERT INTO pb_feed_sources (id, connector_type, name, url, created_at, updated_at)
       VALUES ('src-1', 'rss_atom', '源一', 'https://example.com/feed.xml', 1, 1)`,
      )
      .run();
    sourceDb
      .prepare(
        `INSERT INTO pb_feed_items (id, source_id, canonical_url, original_url, title,
         first_seen_at, last_seen_at, content_hash, created_at, updated_at)
       VALUES ('item-1', 'src-1', 'https://example.com/a', 'https://example.com/a?utm=1',
         '恢复探针文章', 1, 1, 'hash-1', 1, 1)`,
      )
      .run();
    sourceDb
      .prepare(
        `INSERT INTO pb_workflow_templates (id, version, name, created_at)
       VALUES ('research_article', 'v1', '研究一篇文章', 1)`,
      )
      .run();
    const file = await createBackupExport(source);
    expect(file.contents.find((c) => c.table === "pb_feed_items")?.rowCount).toBe(1);

    const target = makeConnection();
    await target.ensureReady();
    const targetDb = target.getDatabase();
    const result = await restoreBackup(file, target, { confirm: true });
    expect(result.restoredTables).toContain("pb_feed_sources");
    expect(result.restoredTables).toContain("pb_feed_items");
    expect(result.restoredTables).toContain("pb_workflow_templates");
    const items = targetDb.prepare(`SELECT title FROM pb_feed_items`).all() as Array<{
      title: string;
    }>;
    expect(items.map((r) => r.title)).toEqual(["恢复探针文章"]);
    // 恢复内置 feed FTS 重建：restore 后无需手动 rebuild 即可检索。
    const hit = targetDb
      .prepare(`SELECT pb_feed_items.id FROM fts_pb_feed_items
        JOIN pb_feed_items ON pb_feed_items.rowid = fts_pb_feed_items.rowid
        WHERE fts_pb_feed_items MATCH '探针文'`)
      .all() as Array<{ id: string }>;
    expect(hit.map((r) => r.id)).toEqual(["item-1"]);
  });

  it("篡改行内容后预览判定无效并拒绝恢复", async () => {
    const source = makeConnection();
    await source.ensureReady();
    const file = await createBackupExport(source);
    const tampered = JSON.parse(JSON.stringify(file)) as typeof file;
    const tasks = tampered.contents.find((c) => c.table === "tasks");
    if (tasks && tasks.rows.length > 0) {
      (tasks.rows[0] as Record<string, unknown>).title = "被篡改";
    } else {
      tasks?.rows.push({ fake: true });
    }
    const target = makeConnection();
    await target.ensureReady();
    const preview = await previewBackupImport(tampered, target);
    expect(preview.valid).toBe(false);
    expect(preview.issues.some((issue) => issue.includes("哈希校验失败"))).toBe(true);
    await expect(restoreBackup(tampered, target, { confirm: true })).rejects.toMatchObject({
      kind: "backup_validation_failed",
    });
  });
});
