// Phase 3 存储层测试：0004→0005 迁移保数据、Run 域四表可用、
// 事件去重（(run_id, event_id) 唯一）、幂等键与 interaction_id 唯一约束。
// 门禁对应 spec 16 Phase 3（崩溃与重复事件不导致重复副作用）与 spec 06 §3。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-phase3-runs-"));
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
        // Windows 句柄释放延迟可能让临时目录暂时不可删；交给系统清理，不影响断言。
      }
    }
  }
});

async function importMigrations() {
  return import("#src/session/tasksDatabase/migrations.js");
}

describe("tasks-index migration 0005 (playablebench runs)", () => {
  it("0004 库升级到 0005 后既有域数据保留且 Run 四表可用", async () => {
    const { runTasksDatabaseMigrations, areTasksDatabaseMigrationsApplied } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    db.exec("PRAGMA journal_mode = WAL");
    try {
      // 先建全量库，再移除 0005 的账本与对象，模拟"0004 时代的旧库"。
      runTasksDatabaseMigrations(db);
      db.prepare(`INSERT INTO pb_inbox_items (id, kind, raw_input, status, created_at, updated_at)
        VALUES ('inbox-keep', 'text', '升级前捕获', 'unprocessed', 1, 1)`).run();
      db.prepare(`INSERT INTO tasks (
          workspace_key, workspace_path, task_id, title, mode, created_at, updated_at, searchable_text
        ) VALUES ('ws', '/tmp/ws', 'task-keep', '升级前任务', 'default', 1, 1, '正文')`).run();

      db.exec(`DELETE FROM tasks_schema_migration WHERE id = '0005_playablebench_runs'`);
      db.exec(`
        DROP INDEX IF EXISTS idx_pb_approvals_pending;
        DROP INDEX IF EXISTS idx_pb_approvals_run;
        DROP INDEX IF EXISTS idx_pb_approvals_interaction;
        DROP INDEX IF EXISTS idx_pb_tool_executions_run;
        DROP INDEX IF EXISTS idx_pb_tool_executions_idem;
        DROP INDEX IF EXISTS idx_pb_run_events_time;
        DROP INDEX IF EXISTS idx_pb_run_events_event_id;
        DROP INDEX IF EXISTS idx_pb_runs_workspace;
        DROP INDEX IF EXISTS idx_pb_runs_session;
        DROP INDEX IF EXISTS idx_pb_runs_status;
        DROP TABLE IF EXISTS pb_approvals;
        DROP TABLE IF EXISTS pb_tool_executions;
        DROP TABLE IF EXISTS pb_run_events;
        DROP TABLE IF EXISTS pb_runs;
      `);

      runTasksDatabaseMigrations(db);
      expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
      const keptInbox = db
        .prepare(`SELECT raw_input FROM pb_inbox_items WHERE id = 'inbox-keep'`)
        .get() as { raw_input: string };
      expect(keptInbox.raw_input).toBe("升级前捕获");
      const keptTask = db
        .prepare(`SELECT title FROM tasks WHERE task_id = 'task-keep'`)
        .get() as { title: string };
      expect(keptTask.title).toBe("升级前任务");

      db.prepare(`INSERT INTO pb_runs (id, status, goal, created_at, updated_at, permission_mode)
        VALUES ('run-1', 'queued', '目标', 1, 1, 'build')`).run();
      const runRow = db
        .prepare(`SELECT status, permission_mode FROM pb_runs WHERE id = 'run-1'`)
        .get() as { status: string; permission_mode: string };
      expect(runRow.status).toBe("queued");
      expect(runRow.permission_mode).toBe("build");
    } finally {
      db.close();
    }
  });

  it("事件表 (run_id, sequence) 主键与 (run_id, event_id) 唯一双键去重", async () => {
    const { runTasksDatabaseMigrations } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    try {
      runTasksDatabaseMigrations(db);
      const insert = db.prepare(`INSERT INTO pb_run_events
        (run_id, sequence, event_id, event_type, occurred_at, schema_version, created_at)
        VALUES ('run-1', ?, ?, 'state.updated', 1, 1, 1)`);
      insert.run(1, "evt-a");
      // 同 sequence 不同 event_id：主键拒绝。
      expect(() => insert.run(1, "evt-b")).toThrow();
      // 同 event_id 不同 sequence：唯一索引拒绝（重复投递的第二种形态）。
      expect(() => insert.run(2, "evt-a")).toThrow();
      // INSERT OR IGNORE 吸收重复投递，行数不变。
      const ignore = db.prepare(`INSERT OR IGNORE INTO pb_run_events
        (run_id, sequence, event_id, event_type, occurred_at, schema_version, created_at)
        VALUES ('run-1', 1, 'evt-a', 'state.updated', 1, 1, 1)`);
      ignore.run();
      const count = db
        .prepare(`SELECT count(*) AS n FROM pb_run_events WHERE run_id = 'run-1'`)
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("工具执行幂等键唯一、审批 interaction_id 唯一（部分索引仅在非空时生效）", async () => {
    const { runTasksDatabaseMigrations } = await importMigrations();
    const db = new DatabaseSync(makeDbPath());
    try {
      runTasksDatabaseMigrations(db);
      db.prepare(`INSERT INTO pb_tool_executions
        (id, run_id, tool_id, idempotency_key, created_at, updated_at)
        VALUES ('tx-1', 'run-1', 'bash', 'idem-1', 1, 1)`).run();
      expect(() =>
        db.prepare(`INSERT INTO pb_tool_executions
          (id, run_id, tool_id, idempotency_key, created_at, updated_at)
          VALUES ('tx-2', 'run-1', 'bash', 'idem-1', 2, 2)`).run(),
      ).toThrow();
      // 幂等键为空不受唯一索引约束。
      db.prepare(`INSERT INTO pb_tool_executions
        (id, run_id, tool_id, created_at, updated_at)
        VALUES ('tx-3', 'run-1', 'edit', 3, 3)`).run();

      db.prepare(`INSERT INTO pb_approvals
        (id, run_id, interaction_id, operation_digest, request_json, decision, created_at, updated_at)
        VALUES ('ap-1', 'run-1', 'ia-1', 'digest-1', '{}', 'pending', 1, 1)`).run();
      expect(() =>
        db.prepare(`INSERT INTO pb_approvals
          (id, run_id, interaction_id, operation_digest, request_json, decision, created_at, updated_at)
          VALUES ('ap-2', 'run-1', 'ia-1', 'digest-2', '{}', 'pending', 2, 2)`).run(),
      ).toThrow();
      // interaction_id 为空不受约束（历史审批可无 V4 interaction）。
      db.prepare(`INSERT INTO pb_approvals
        (id, run_id, operation_digest, request_json, decision, created_at, updated_at)
        VALUES ('ap-3', 'run-1', 'digest-3', '{}', 'pending', 3, 3)`).run();
    } finally {
      db.close();
    }
  });
});
