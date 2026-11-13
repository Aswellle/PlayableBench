// PlayableBench Inbox 存储（spec 01 §4.2、PRD-02）：原始输入逐字保留，
// 处理失败不改写不丢弃；状态流转 unprocessed → processed/archived/failed。
// 与 TaskIndexRepo/AutomationRepo 同一 tasks-index.sqlite；打开时若未迁移
// 会走同一幂等迁移 runner（0004 建表），与既有 repo 行为一致。
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  InboxCaptureInput,
  InboxItem,
  InboxItemStatus,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { isTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface InboxRow {
  id: string;
  kind: string;
  raw_input: string;
  title: string | null;
  source_url: string | null;
  status: string;
  processing_error: string | null;
  task_id: string | null;
  created_at: number;
  updated_at: number;
  processed_at: number | null;
}

function rowToItem(row: InboxRow): InboxItem {
  return {
    id: row.id,
    kind: row.kind as InboxItem["kind"],
    rawInput: row.raw_input,
    title: row.title ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    status: row.status as InboxItemStatus,
    processingError: row.processing_error ?? undefined,
    taskId: row.task_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    processedAt: row.processed_at ?? undefined,
  };
}

// db 路径与 AutomationRepo 同款策略：构造期固定，测试注入临时路径，
// 生产不传则回退进程默认（getTasksIndexDatabasePath）。
export class InboxRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath ?? null;
  }

  async ensureReady(): Promise<void> {
    const path = this.resolvedDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // 与 AutomationRepo 一致：Worker 迁移已完成则不重复；独立打开时在此自愈迁移。
    if (!isTasksStoragePrepared(path, this.db)) {
      runTasksDatabaseMigrations(this.db);
    }
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("InboxRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* 关闭失败不影响调用方（WAL 由连接生命周期收尾）。 */
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
  }

  /** 捕获原始输入：逐字落库，永不改写（PRD-02）。 */
  async capture(input: InboxCaptureInput): Promise<InboxItem> {
    await this.ensureReady();
    const now = Date.now();
    const id = `inbox-${randomUUID()}`;
    this.getDatabase()
      .prepare(
        `INSERT INTO pb_inbox_items (
          id, kind, raw_input, title, source_url, status,
          task_id, created_at, updated_at, processed_at
        ) VALUES (?, ?, ?, ?, ?, 'unprocessed', NULL, ?, ?, NULL)`,
      )
      .run(id, input.kind, input.rawInput, input.title ?? null, input.sourceUrl ?? null, now, now);
    const item = await this.get(id);
    if (!item) {
      throw new Error(`inbox capture 写入后缺少条目: ${id}`);
    }
    return item;
  }

  async list(params?: { status?: InboxItemStatus; limit?: number }): Promise<InboxItem[]> {
    await this.ensureReady();
    const limit = Math.max(1, Math.min(params?.limit ?? 100, 500));
    const rows = params?.status
      ? (this.getDatabase()
          .prepare(`SELECT * FROM pb_inbox_items WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
          .all(params.status, limit) as unknown as InboxRow[])
      : (this.getDatabase()
          .prepare(`SELECT * FROM pb_inbox_items ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as unknown as InboxRow[]);
    return rows.map(rowToItem);
  }

  async get(id: string): Promise<InboxItem | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM pb_inbox_items WHERE id = ?`)
      .get(id) as InboxRow | undefined;
    return row ? rowToItem(row) : null;
  }

  /** 转任务成功后回填关联并结条（原始输入保留，processedAt 可追溯）。 */
  async markProcessed(id: string, taskId: string): Promise<InboxItem | null> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `UPDATE pb_inbox_items
         SET status = 'processed', task_id = ?, processed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(taskId, now, now, id);
    return this.get(id);
  }

  /** 处理失败：保留原始输入并记录失败原因，可重试。 */
  async markFailed(id: string, processingError: string): Promise<InboxItem | null> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `UPDATE pb_inbox_items
         SET status = 'failed', processing_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(processingError, now, id);
    return this.get(id);
  }

  async archive(id: string): Promise<InboxItem | null> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(`UPDATE pb_inbox_items SET status = 'archived', updated_at = ? WHERE id = ?`)
      .run(now, id);
    return this.get(id);
  }
}
