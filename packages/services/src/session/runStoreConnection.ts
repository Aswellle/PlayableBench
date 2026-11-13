// Run 域三个仓库（RunRepo/ToolExecutionRepo/ApprovalRepo）共享的 tasks-index
// 连接生命周期；与 InboxRepo/AutomationRepo 同一打开纪律（WAL + 幂等迁移自愈）。
// 拆分动机：架构治理 max-lines 单文件上限，按实体分文件、按连接共享打开逻辑。
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { isTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type RunStoreDatabase = InstanceType<typeof DatabaseSync>;

export class RunStoreConnection {
  private db: RunStoreDatabase | null = null;
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
    // 与 InboxRepo 一致：Worker 迁移已完成则不重复；独立打开时在此自愈迁移。
    if (!isTasksStoragePrepared(path, this.db)) {
      runTasksDatabaseMigrations(this.db);
    }
  }

  getDatabase(): RunStoreDatabase {
    if (!this.db) {
      throw new Error("RunStoreConnection 未初始化：请先 await ensureReady()");
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
}
