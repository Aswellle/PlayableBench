// 远程设备域迁移测试：0008→0009 保数据、设备注册表/命令账本/安全事件可用、
// request_id 全局唯一（命令幂等键）、账本完整。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-remote-"));
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

describe("tasks-index migration 0009 (remote devices)", () => {
  it("0008 库升级到 0009 后既有数据保留且三张新表可用；账本完整", async () => {
    const { runTasksDatabaseMigrations, areTasksDatabaseMigrationsApplied } =
      await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    db.exec("PRAGMA journal_mode = WAL");
    try {
      // 建 0008 时代库并写入升级前数据，模拟旧库升级。
      runTasksDatabaseMigrations(db);
      db.prepare(
        `INSERT INTO pb_notes (id, title, body, created_at, updated_at)
         VALUES ('note-keep', '升级前笔记', 'legacy', 1, 1)`,
      ).run();
      db.exec(`DELETE FROM tasks_schema_migration WHERE id = '0009_playablebench_remote'`);
      db.exec(`DROP TABLE IF EXISTS pb_remote_security_events`);
      db.exec(`DROP TABLE IF EXISTS pb_remote_command_ledger`);
      db.exec(`DROP TABLE IF EXISTS pb_remote_devices`);

      runTasksDatabaseMigrations(db);
      expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
      const kept = db.prepare(`SELECT title FROM pb_notes WHERE id = 'note-keep'`).get() as {
        title: string;
      };
      expect(kept.title).toBe("升级前笔记");
      // 设备注册表可写可查；scope 默认只读档。
      db.prepare(
        `INSERT INTO pb_remote_devices (id, name, status, created_at, updated_at)
         VALUES ('dev-1', '测试手机', 'pending', 1, 1)`,
      ).run();
      const device = db
        .prepare(`SELECT name, scope FROM pb_remote_devices WHERE id='dev-1'`)
        .get() as { name: string; scope: string };
      expect(device.name).toBe("测试手机");
      expect(device.scope).toBe("read_only");
      // 命令账本 request_id 全局唯一。
      const insertCommand = db.prepare(
        `INSERT INTO pb_remote_command_ledger
           (request_id, device_id, command_type, payload_digest, status, received_at)
         VALUES (?, ?, ?, ?, 'received', ?)`,
      );
      insertCommand.run("req-1", "dev-1", "send_instruction", "digest-1", 1);
      expect(() =>
        insertCommand.run("req-1", "dev-1", "send_instruction", "digest-1", 2),
      ).toThrow();
      // 安全事件可写可查。
      db.prepare(
        `INSERT INTO pb_remote_security_events (id, event_type, device_id, occurred_at)
         VALUES ('evt-1', 'device_revoked', 'dev-1', 1)`,
      ).run();
      const event = db
        .prepare(`SELECT event_type FROM pb_remote_security_events WHERE id='evt-1'`)
        .get() as { event_type: string };
      expect(event.event_type).toBe("device_revoked");
    } finally {
      db.close();
    }
  });
});
