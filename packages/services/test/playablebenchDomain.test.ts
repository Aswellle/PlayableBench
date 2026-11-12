// Phase 2 存储层测试：0003→0004 迁移保数据、FTS5 同步/重建、Inbox/Projects repos。
// 门禁对应 spec 16 Phase 2（重启数据保持、迁移成功）与 spec 06 §3（FTS 删除同步/重建）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-phase2-domain-"));
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

describe("tasks-index migration 0004 (playablebench domain)", () => {
  it("0003 库升级到 0004 后既有任务数据保留且新表可用", async () => {
    const { runTasksDatabaseMigrations, areTasksDatabaseMigrationsApplied } = await import(
      "#src/session/tasksDatabase/migrations.js"
    );
    const dbPath = makeDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    try {
      // 先建全量库，再移除 0004 的账本与对象，模拟"0003 时代的旧库"。
      runTasksDatabaseMigrations(db);
      db.exec(`DELETE FROM tasks_schema_migration WHERE id = '0004_playablebench_domain'`);
      db.exec(`
        DROP TRIGGER IF EXISTS tasks_fts_ai; DROP TRIGGER IF EXISTS tasks_fts_ad; DROP TRIGGER IF EXISTS tasks_fts_au;
        DROP TRIGGER IF EXISTS inbox_items_fts_ai; DROP TRIGGER IF EXISTS inbox_items_fts_ad; DROP TRIGGER IF EXISTS inbox_items_fts_au;
        DROP TRIGGER IF EXISTS notes_fts_ai; DROP TRIGGER IF EXISTS notes_fts_ad; DROP TRIGGER IF EXISTS notes_fts_au;
        DROP TABLE IF EXISTS fts_tasks; DROP TABLE IF EXISTS fts_inbox; DROP TABLE IF EXISTS fts_notes;
        DROP TABLE IF EXISTS project_links; DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS projects; DROP TABLE IF EXISTS inbox_items;
        DROP INDEX IF EXISTS idx_tasks_due_at; DROP INDEX IF EXISTS idx_tasks_priority;
        DROP INDEX IF EXISTS idx_inbox_items_status; DROP INDEX IF EXISTS idx_notes_project; DROP INDEX IF EXISTS idx_project_links_link;
        ALTER TABLE tasks DROP COLUMN priority;
        ALTER TABLE tasks DROP COLUMN due_at;
      `);

      db.prepare(
        `INSERT INTO tasks (
          workspace_key, workspace_path, task_id, title, mode, created_at, updated_at, searchable_text
        ) VALUES ('ws', '/tmp/ws', 'task-legacy', '遗留任务', 'default', 1, 1, '遗留正文')`,
      ).run();

      // 升级到 0004。
      runTasksDatabaseMigrations(db);
      expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
      const legacy = db
        .prepare(`SELECT title FROM tasks WHERE task_id = 'task-legacy'`)
        .get() as { title: string };
      expect(legacy.title).toBe("遗留任务");
      db.prepare(
        `INSERT INTO pb_inbox_items (id, kind, raw_input, status, created_at, updated_at)
         VALUES ('inbox-1', 'text', '原始输入', 'unprocessed', 1, 1)`,
      ).run();
      const priorityRow = db
        .prepare(`SELECT priority, due_at FROM tasks WHERE task_id = 'task-legacy'`)
        .get() as { priority: string | null; due_at: number | null };
      expect(priorityRow.priority).toBeNull();
    } finally {
      db.close();
    }
  });

  it("FTS 触发器同步插入/更新/删除，rebuild 可重建", async () => {
    const { runTasksDatabaseMigrations } = await import("#src/session/tasksDatabase/migrations.js");
    const dbPath = makeDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    runTasksDatabaseMigrations(db);

    db.prepare(
      `INSERT INTO tasks (
        workspace_key, workspace_path, task_id, title, mode, created_at, updated_at, searchable_text
      ) VALUES ('ws', '/tmp/ws', 'task-1', '错误边界重构', 'default', 1, 1, '处理 error boundary retry 的讨论')`,
    ).run();
    const matchAfterInsert = db
      .prepare(`SELECT tasks.task_id FROM fts_tasks JOIN tasks ON tasks.rowid = fts_tasks.rowid WHERE fts_tasks MATCH 'boundary'`)
      .all() as Array<{ task_id: string }>;
    expect(matchAfterInsert.length).toBe(1);

    db.prepare(
      `UPDATE tasks SET searchable_text = '改写后的正文内容' WHERE task_id = 'task-1'`,
    ).run();
    const matchAfterUpdate = db
      .prepare(`SELECT tasks.task_id FROM fts_tasks JOIN tasks ON tasks.rowid = fts_tasks.rowid WHERE fts_tasks MATCH 'boundary'`)
      .all() as Array<{ task_id: string }>;
    const matchRewritten = db
      .prepare(`SELECT tasks.task_id FROM fts_tasks JOIN tasks ON tasks.rowid = fts_tasks.rowid WHERE fts_tasks MATCH '改写后的正文'`)
      .all() as Array<{ task_id: string }>;
    expect(matchAfterUpdate.length).toBe(0);
    expect(matchRewritten.length).toBe(1);

    db.prepare(`DELETE FROM tasks WHERE task_id = 'task-1'`).run();
    const matchAfterDelete = db
      .prepare(`SELECT tasks.task_id FROM fts_tasks JOIN tasks ON tasks.rowid = fts_tasks.rowid WHERE fts_tasks MATCH '改写后的正文'`)
      .all() as Array<{ task_id: string }>;
    expect(matchAfterDelete.length).toBe(0);

    // rebuild：external-content 表不能直接 DELETE 索引行；用"幽灵行"模拟漂移
    // （索引指向不存在的内容行），rebuild 重扫内容表后应收敛一致。
    db.prepare(
      `INSERT INTO tasks (
        workspace_key, workspace_path, task_id, title, mode, created_at, updated_at, searchable_text
      ) VALUES ('ws', '/tmp/ws', 'task-2', '重建验证', 'default', 2, 2, 'rebuild probe content')`,
    ).run();
    db.prepare(
      `INSERT INTO fts_tasks(rowid, title, searchable_text) VALUES (999999, 'ghost', 'ghost drift')`,
    ).run();
    db.exec(`INSERT INTO fts_tasks(fts_tasks) VALUES('rebuild')`);
    const ghost = db
      .prepare(`SELECT tasks.task_id FROM fts_tasks JOIN tasks ON tasks.rowid = fts_tasks.rowid WHERE fts_tasks MATCH 'ghost'`)
      .all() as Array<{ task_id: string }>;
    expect(ghost.length).toBe(0);
    const rebuilt = db
      .prepare(`SELECT tasks.task_id FROM fts_tasks JOIN tasks ON tasks.rowid = fts_tasks.rowid WHERE fts_tasks MATCH 'rebuild probe'`)
      .all() as Array<{ task_id: string }>;
    expect(rebuilt.length).toBe(1);
    db.close();
  });
});

describe("TaskIndexRepo PlayableBench fields + today summary", () => {
  it("priority/dueAt 经 meta 与列双写，clearTaskScheduleFields 可清空", async () => {
    const { TaskIndexRepo } = await import("#src/session/taskIndexRepo.js");
    const repo = new TaskIndexRepo(makeDbPath());
    await repo.ensureReady();
    const base = Date.now();
    const meta = await repo.seedTaskMetaIfMissing({
      taskId: "task-p1",
      traceId: "trace-p1",
      title: "带优先级任务",
      workspacePath: "/tmp/ws-p",
      createdAt: base,
      updatedAt: base,
      mode: "default",
      priority: "high",
      dueAt: base + 86_400_000,
      tags: ["infra"],
    });
    expect(meta.priority).toBe("high");
    expect(meta.dueAt).toBe(base + 86_400_000);

    // 同步一个不带 priority 的 meta：列保留现有值（CASE 保留策略）。
    await repo.syncTaskMeta({
      meta: { ...meta, title: "带优先级任务（更新）" },
    });
    const still = await repo.seedTaskMetaIfMissing({
      taskId: "task-p1",
      traceId: "trace-p1",
      title: "带优先级任务（更新）",
      workspacePath: "/tmp/ws-p",
      createdAt: base,
      updatedAt: base + 1,
      mode: "default",
    });
    expect(still.priority).toBe("high");
    expect(still.dueAt).toBe(base + 86_400_000);

    await repo.clearTaskScheduleFields({ workspacePath: "/tmp/ws-p", taskId: "task-p1" });
    const cleared = await repo.queryTaskList({
      kind: "timeline",
      sortBy: "updated",
      workspaceScopes: [{ workspacePath: "/tmp/ws-p" }],
      search: "带优先级任务",
    });
    expect(cleared.items[0]?.priority).toBeUndefined();
    await repo.close();
  });

  it("queryTaskList 搜索经 FTS 命中正文（含 CJK 子串）", async () => {
    const { TaskIndexRepo } = await import("#src/session/taskIndexRepo.js");
    const dbPath = makeDbPath();
    const repo = new TaskIndexRepo(dbPath);
    await repo.ensureReady();
    const base = Date.now();
    await repo.seedTaskMetaIfMissing({
      taskId: "task-cjk",
      traceId: "trace-cjk",
      title: "循环依赖治理",
      workspacePath: "/tmp/ws-cjk",
      createdAt: base,
      updatedAt: base,
      mode: "default",
    });

    // seedTaskMetaIfMissing 不写 searchable_text；用独立连接回填正文（模拟已索引会话摘要）。
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE tasks SET searchable_text = ? WHERE task_id = ?").run(
      "处理 error boundary retry 时发现循环依赖，正文长度模拟真实会话摘要",
      "task-cjk",
    );
    db.close();

    // FTS trigram：拉丁与 CJK 子串都应命中。
    const latin = await repo.queryTaskList({
      kind: "timeline",
      sortBy: "updated",
      workspaceScopes: [{ workspacePath: "/tmp/ws-cjk" }],
      search: "boundary",
    });
    expect(latin.items).toHaveLength(1);
    const cjk = await repo.queryTaskList({
      kind: "timeline",
      sortBy: "updated",
      workspaceScopes: [{ workspacePath: "/tmp/ws-cjk" }],
      search: "循环依赖",
    });
    expect(cjk.items).toHaveLength(1);
    // LIKE 兜底路径（title 命中）也不回归。
    const titleHit = await repo.queryTaskList({
      kind: "timeline",
      sortBy: "updated",
      workspaceScopes: [{ workspacePath: "/tmp/ws-cjk" }],
      search: "循环依赖治理",
    });
    expect(titleHit.items).toHaveLength(1);
    await repo.close();
  });

  it("queryTodaySummary 聚合逾期/今日/高优与未处理 Inbox", async () => {
    const { TaskIndexRepo } = await import("#src/session/taskIndexRepo.js");
    const dbPath = makeDbPath();
    const repo = new TaskIndexRepo(dbPath);
    await repo.ensureReady();
    const now = Date.now();
    const day = 86_400_000;
    const seed = async (taskId: string, extra: Record<string, unknown>) => {
      await repo.seedTaskMetaIfMissing({
        taskId,
        traceId: `trace-${taskId}`,
        title: `任务 ${taskId}`,
        workspacePath: "/tmp/ws-today",
        createdAt: now - day,
        updatedAt: now - day,
        mode: "default",
        ...extra,
      });
    };
    await seed("task-overdue", { dueAt: now - day });
    await seed("task-due-today", { dueAt: now + 3_600_000 });
    await seed("task-high", { priority: "urgent" });
    await seed("task-normal", {});

    // Inbox 一条未处理。
    const { InboxRepo } = await import("#src/session/inboxRepo.js");
    const inbox = new InboxRepo(dbPath);
    await inbox.ensureReady();
    await inbox.capture({ kind: "text", rawInput: "今日待整理的输入" });

    const summary = await repo.queryTodaySummary({ nowMs: now });
    expect(summary.overdueTasks.map((entry) => entry.taskId)).toEqual(["task-overdue"]);
    expect(summary.dueTodayTasks.map((entry) => entry.taskId)).toEqual(["task-due-today"]);
    expect(summary.highPriorityTasks.map((entry) => entry.taskId)).toEqual(["task-high"]);
    expect(summary.counts.unprocessedInbox).toBe(1);
    expect(summary.recentInboxItems[0]?.rawInput).toBe("今日待整理的输入");
    await inbox.close();
    await repo.close();
  });
});

describe("InboxRepo", () => {
  it("捕获→列表→转任务→失败→归档 全链路，原始输入逐字保留", async () => {
    const { InboxRepo } = await import("#src/session/inboxRepo.js");
    const repo = new InboxRepo(makeDbPath());
    await repo.ensureReady();

    const rawInput = "  保留原始空白与特殊字符 'quote' \"double\" 中文 🎉 ";
    const captured = await repo.capture({
      kind: "url",
      rawInput,
      title: "带标题的条目",
      sourceUrl: "https://example.com/post",
    });
    expect(captured.status).toBe("unprocessed");
    expect(captured.rawInput).toBe(rawInput);

    const processed = await repo.markProcessed(captured.id, "task-converted");
    expect(processed?.status).toBe("processed");
    expect(processed?.taskId).toBe("task-converted");
    expect(processed?.processedAt).toBeDefined();

    const failed = await repo.capture({ kind: "text", rawInput: "会失败的条目" });
    await repo.markFailed(failed.id, "解析超时");
    const failedItem = await repo.get(failed.id);
    expect(failedItem?.status).toBe("failed");
    expect(failedItem?.processingError).toBe("解析超时");
    expect(failedItem?.rawInput).toBe("会失败的条目");

    const archived = await repo.archive(failed.id);
    expect(archived?.status).toBe("archived");

    const unprocessed = await repo.list({ status: "unprocessed" });
    expect(unprocessed.find((item) => item.id === captured.id)).toBeUndefined();
    await repo.close();
  });

  it("重启（关闭重开连接）后数据保持", async () => {
    const dbPath = makeDbPath();
    const { InboxRepo } = await import("#src/session/inboxRepo.js");
    const first = new InboxRepo(dbPath);
    await first.ensureReady();
    const captured = await first.capture({ kind: "text", rawInput: "重启保持验证" });
    first.close();

    const second = new InboxRepo(dbPath);
    const item = await second.get(captured.id);
    expect(item?.rawInput).toBe("重启保持验证");
    await second.close();
  });
});

describe("ProjectsRepo", () => {
  it("项目创建/更新/归档/恢复 + 笔记挂载 + 关联解绑不删除对象", async () => {
    const { ProjectsRepo } = await import("#src/session/projectsRepo.js");
    const repo = new ProjectsRepo(makeDbPath());
    await repo.ensureReady();

    const project = await repo.createProject({ name: " playablebench ", description: "底座改造" });
    expect(project.name).toBe("playablebench");

    const note = await repo.createNote({
      title: "架构笔记",
      body: "协议分层与 owner/lease 边界",
      projectId: project.id,
    });
    expect(note.projectId).toBe(project.id);

    const linked = await repo.link({ projectId: project.id, kind: "task", linkId: "task-x" });
    expect(linked.kind).toBe("task");

    const updated = await repo.updateProject(project.id, { color: "blue" });
    expect(updated?.color).toBe("blue");

    await repo.unlink({ projectId: project.id, kind: "task", linkId: "task-x" });
    expect(await repo.listLinks({ projectId: project.id })).toHaveLength(1); // 仅剩 note 关联
    expect(await repo.getNote(note.id)).not.toBeNull(); // 解绑不删除对象

    const archived = await repo.archiveProject(project.id);
    expect(archived?.status).toBe("archived");
    const restored = await repo.restoreProject(project.id);
    expect(restored?.status).toBe("active");

    await repo.deleteNote(note.id);
    expect(await repo.getNote(note.id)).toBeNull();
    await repo.close();
  });

  it("关联不存在的项目时报错", async () => {
    const { ProjectsRepo } = await import("#src/session/projectsRepo.js");
    const repo = new ProjectsRepo(makeDbPath());
    await repo.ensureReady();
    await expect(
      repo.createNote({ title: "孤立笔记", projectId: "project-missing" }),
    ).rejects.toThrow(/不存在/);
    await expect(
      repo.link({ projectId: "project-missing", kind: "note", linkId: "note-x" }),
    ).rejects.toThrow(/不存在/);
    await repo.close();
  });
});
