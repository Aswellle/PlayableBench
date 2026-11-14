import { databaseMigrationIdSchema, type DatabaseMigrationFacts } from "@zcode/shared";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AUTOMATION_SCHEMA,
  OFF_PEAK_SCHEMA,
  TASK_INDEX_SCHEMA,
} from "#src/session/tasksDatabase/schema-v1.js";
import { importLegacyAutomationSelections } from "#src/session/tasksDatabase/provider-selection-v2.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "#src/session/tasksDatabase/official-glm-selection-v3.js";
import {
  applyPlayableBenchDomainV4,
  PLAYABLEBENCH_DOMAIN_V4_SQL,
  TASK_FIELDS_V4,
} from "#src/session/tasksDatabase/playablebench-domain-v4.js";
import { applyPlayableBenchRunsV5, PLAYABLEBENCH_RUNS_V5_SQL } from "#src/session/tasksDatabase/playablebench-runs-v5.js";
import {
  applyPlayableBenchFtsNotesFixV6,
  PB_NOTES_FTS_FIX_SQL,
} from "#src/session/tasksDatabase/playablebench-fts-notes-fix-v6.js";
import { applyPlayableBenchFeedV7, PLAYABLEBENCH_FEED_V7_SQL } from "#src/session/tasksDatabase/playablebench-feed-v7.js";
import {
  applyPlayableBenchWorkflowV8,
  PLAYABLEBENCH_WORKFLOW_V8_SQL,
} from "#src/session/tasksDatabase/playablebench-workflow-v8.js";

// 冻结历史列声明，不能以实时 Repo/schema 代替，否则新版构建会改变已应用 checksum。
const columns = [
  ["tasks", "title_overridden", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "last_unread_at", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"],
  ["tasks", "cron_automation_id", "TEXT"],
  ["tasks", "off_peak_task_id", "TEXT"],
  ["automations", "target_task_id", "TEXT"],
  ["automations", "bot_delivery_target", "TEXT"],
  ["automations", "mode", "TEXT"],
  ["automations", "end_at", "INTEGER"],
  ["automations", "schedule_rule", "TEXT"],
  ["automations", "schedule_edited_by_user", "INTEGER NOT NULL DEFAULT 0"],
  ["automations", "thought_level", "TEXT"],
  ["automations", "model_selection", "TEXT"],
  ["automations", "scheduled_run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["automation_runs", "model_selection", "TEXT"],
  ["off_peak_tasks", "thought_level", "TEXT"],
  ["off_peak_tasks", "model_selection", "TEXT"],
  ["off_peak_tasks", "history_deleted_at", "INTEGER"],
] as const;
const indexes = `
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
`;
const terminalStatuses = "'completed','failed','cancelled'";
const activePredicate = `session_id IS NOT NULL AND status NOT IN (${terminalStatuses})`;
const boundIndex = `CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE ${activePredicate}`;

// 与 Agent 同样是库级串行事务，但不跨域依赖其具体 adapter。TS 转换使用冻结语义版本，
// 禁用 function.toString 哈希：Electron/SEA 打包会改变函数文本而非迁移语义。
const definitions = [
  {
    id: "0001_adopt_task_schema",
    checksumInput: [
      TASK_INDEX_SCHEMA,
      AUTOMATION_SCHEMA,
      OFF_PEAK_SCHEMA,
      columns,
      indexes,
      boundIndex,
      "scheduled-count-backfill-v1",
    ],
  },
  {
    id: "0002_provider_selection",
    checksumInput: ["legacy-automation-selection-v1", "no-provider-for-legacy-off-peak-v1"],
  },
  {
    id: "0003_official_glm_selection",
    checksumInput: [OFFICIAL_GLM_SELECTION_MIGRATION_SQL],
  },
  {
    id: "0004_playablebench_domain",
    checksumInput: [PLAYABLEBENCH_DOMAIN_V4_SQL, TASK_FIELDS_V4, "playablebench-domain-v1"],
  },
  {
    id: "0005_playablebench_runs",
    checksumInput: [PLAYABLEBENCH_RUNS_V5_SQL, "playablebench-runs-v1"],
  },
  {
    id: "0006_fts_pb_notes_repoint",
    checksumInput: [PB_NOTES_FTS_FIX_SQL, "playablebench-fts-notes-fix-v1"],
  },
  {
    id: "0007_playablebench_feed",
    checksumInput: [PLAYABLEBENCH_FEED_V7_SQL, "playablebench-feed-v1"],
  },
  {
    id: "0008_playablebench_workflow",
    checksumInput: [PLAYABLEBENCH_WORKFLOW_V8_SQL, "playablebench-workflow-v1"],
  },
] as const;

export function runTasksDatabaseMigrations(
  db: DatabaseSync,
  options: {
    transactionOpen?: boolean;
    migration?: DatabaseMigrationFacts;
    onProgress?: (phase: "migrating" | "committing", migration: DatabaseMigrationFacts) => void;
  } = {},
): void {
  if (!options.transactionOpen) db.exec("BEGIN IMMEDIATE");
  const migrationFacts: DatabaseMigrationFacts = options.migration ?? {
    kind: "none",
    executedCount: 0,
    committedCount: 0,
  };
  let currentMigrationId: string | undefined;
  try {
    if (!options.migration) migrationFacts.kind = inspectTasksMigrationKind(db);
    db.exec(`CREATE TABLE IF NOT EXISTS tasks_schema_migration (
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL
    )`);
    // 锁内、版本 SQL 之前采集；空账本是 none，异常编号不作为遥测原文发送。
    const baseline = db
      .prepare("SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1")
      .get();
    migrationFacts.lastAppliedMigrationId = baseline
      ? databaseMigrationIdSchema.safeParse(baseline.id).data
      : null;
    for (const migration of definitions) {
      currentMigrationId = migration.id;
      const checksum = createHash("sha256")
        .update(JSON.stringify(migration.checksumInput))
        .digest("hex");
      const applied = db
        .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
        .get(migration.id);
      if (applied) {
        if (applied.checksum !== checksum)
          throw Object.assign(
            new Error(`Task database migration checksum mismatch: ${migration.id}`),
            { kind: "checksum_mismatch" },
          );
        continue;
      }
      if (migrationFacts.kind === "none") migrationFacts.kind = "upgrade";
      options.onProgress?.("migrating", { ...migrationFacts });
      if (migration.id === "0001_adopt_task_schema") adoptSchema(db);
      else if (migration.id === "0002_provider_selection") importLegacyAutomationSelections(db);
      else if (migration.id === "0004_playablebench_domain") applyPlayableBenchDomainV4(db);
      else if (migration.id === "0005_playablebench_runs") applyPlayableBenchRunsV5(db);
      else if (migration.id === "0006_fts_pb_notes_repoint") applyPlayableBenchFtsNotesFixV6(db);
      else if (migration.id === "0007_playablebench_feed") applyPlayableBenchFeedV7(db);
      else if (migration.id === "0008_playablebench_workflow") applyPlayableBenchWorkflowV8(db);
      else db.exec(OFFICIAL_GLM_SELECTION_MIGRATION_SQL);
      migrationFacts.executedCount++;
      db.prepare("INSERT INTO tasks_schema_migration VALUES(?,?,?)").run(
        migration.id,
        checksum,
        Date.now(),
      );
    }
    options.onProgress?.("committing", { ...migrationFacts });
    db.exec("COMMIT");
    migrationFacts.committedCount = migrationFacts.executedCount;
  } catch (error) {
    // 回滚也可能因 IO 失败，不能覆盖真正导致迁移失败的异常。
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      /* 调用方关闭连接恢复。 */
    }
    if (error && typeof error === "object" && currentMigrationId)
      Object.assign(error, { migrationId: currentMigrationId });
    throw error;
  }
}

function adoptSchema(db: DatabaseSync): void {
  db.exec(TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA);
  for (const [table, column, definition] of columns) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((entry) => entry.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (table === "automations" && column === "scheduled_run_count") {
      db.exec("UPDATE automations SET scheduled_run_count=run_count");
    }
  }
  db.exec(indexes);
  // 沿用已裁决的旧重复绑定保留策略，但不再吞掉权限/语法/磁盘等真实 SQL 错误。
  const duplicate = db
    .prepare(`SELECT 1 FROM off_peak_tasks WHERE ${activePredicate}
    GROUP BY workspace_key, session_id HAVING count(*)>1 LIMIT 1`)
    .get();
  if (!duplicate) db.exec(boundIndex);
}

/** 交接只复用已完成初始化；每个新连接仍按冻结账本确认，替换/清空文件不能假 ready。 */
export function areTasksDatabaseMigrationsApplied(db: DatabaseSync): boolean {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
      .get()
  )
    return false;
  for (const migration of definitions) {
    const row = db
      .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
      .get(migration.id);
    if (!row) return false;
    const expected = createHash("sha256")
      .update(JSON.stringify(migration.checksumInput))
      .digest("hex");
    if (row.checksum !== expected)
      throw Object.assign(new Error(`Task database migration checksum mismatch: ${migration.id}`), {
        kind: "checksum_mismatch",
      });
  }
  return true;
}

/** 只读账本的展示预检，不授权执行；迁移 runner 拿锁后仍复查每一项。 */
export function inspectTasksMigrationKind(db: DatabaseSync): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
    .get();
  let pending = false;
  for (const migration of definitions) {
    const row = hasLedger
      ? db.prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?").get(migration.id)
      : undefined;
    if (!row) pending = true;
    else if (
      row.checksum !==
      createHash("sha256").update(JSON.stringify(migration.checksumInput)).digest("hex")
    )
      throw Object.assign(new Error(`Task database migration checksum mismatch: ${migration.id}`), {
        kind: "checksum_mismatch",
        migrationId: migration.id,
      });
  }
  if (!pending) return "none";
  return db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('tasks_schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get()
    ? "upgrade"
    : "initialize";
}
