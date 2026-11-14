// PlayableBench 核心数据导出/备份最小版（spec 06 §5、spec 15 §5；Phase 2 S5 顺延补课）。
// 导出：tasks + PlayableBench 域表（runs 家族 + inbox/projects/notes/links）+
// 迁移账本；manifest 记录 format 版本、app/schema 版本、生成时间、每表行数与
// 行内容 sha256。密钥与凭据文件一律不在导出清单（spec 06 §5：密钥不随普通备份导出）。
// 恢复：先校验格式与哈希并产出预览（不写入）；restore 必须显式 confirm，
// 否则拒绝。FTS 影子表不导出（导入后由 rebuild 重建，见 playablebench-domain-v4）。
import { createHash } from "node:crypto";
import type { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { PLAYABLEBENCH_FTS_REBUILD_SQL } from "#src/session/tasksDatabase/playablebench-domain-v4.js";
import { PB_FEED_FTS_REBUILD_SQL } from "#src/session/tasksDatabase/playablebench-feed-v7.js";

export const BACKUP_FORMAT = "playablebench-backup-v1" as const;

/** 导出表清单（冻结顺序）：核心结构化数据；不含凭据/密钥/FTS 影子表。 */
export const BACKUP_TABLES = [
  "tasks",
  "pb_runs",
  "pb_run_events",
  "pb_tool_executions",
  "pb_approvals",
  "pb_inbox_items",
  "pb_projects",
  "pb_notes",
  "pb_project_links",
  "pb_feed_sources",
  "pb_feed_items",
  "pb_feed_metric_snapshots",
  "pb_workflow_templates",
  "pb_feed_summaries",
  "tasks_schema_migration",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

export interface BackupTableContent {
  table: BackupTable;
  rowCount: number;
  rows: Array<Record<string, unknown>>;
  sha256: string;
}

export interface PbBackupFile {
  format: typeof BACKUP_FORMAT;
  appVersion: string;
  generatedAt: number;
  schemaVersion: string | null;
  contents: BackupTableContent[];
}

export interface BackupImportPreview {
  valid: boolean;
  issues: string[];
  manifest: {
    format: string;
    appVersion: string;
    generatedAt: number;
    schemaVersion: string | null;
    tables: Array<{ table: string; rowCount: number }>;
  };
  /** 恢复目标当前 schema 账本末位；早于备份 schema 时提示但允许（纯增量迁移面）。 */
  targetSchemaVersion: string | null;
}

type DatabaseRow = Record<string, unknown>;

function hashRows(rows: Array<DatabaseRow>): string {
  // 行内容规范化哈希：键排序剔除 undefined，导出方与校验方共用同一函数。
  const canonical = JSON.stringify(rows, (_key, value) =>
    value === undefined ? null : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export async function createBackupExport(
  connection: RunStoreConnection,
  options?: { appVersion?: string },
): Promise<PbBackupFile> {
  await connection.ensureReady();
  const db = connection.getDatabase();
  const contents: BackupTableContent[] = [];
  for (const table of BACKUP_TABLES) {
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table);
    if (!exists) {
      // 0005 前的旧库：runs 家族缺失按空表导出，保持 manifest 结构稳定。
      contents.push({ table, rowCount: 0, rows: [], sha256: hashRows([]) });
      continue;
    }
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as unknown as DatabaseRow[];
    contents.push({ table, rowCount: rows.length, rows, sha256: hashRows(rows) });
  }
  const ledger = db
    .prepare(`SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1`)
    .get() as { id: string } | undefined;
  return {
    format: BACKUP_FORMAT,
    appVersion: options?.appVersion ?? "unknown",
    generatedAt: Date.now(),
    schemaVersion: ledger?.id ?? null,
    contents,
  };
}

export function validateBackupFile(value: unknown): { issues: string[]; file?: PbBackupFile } {
  const issues: string[] = [];
  if (!value || typeof value !== "object") {
    return { issues: ["备份文件不是 JSON 对象"] };
  }
  const file = value as PbBackupFile;
  if (file.format !== BACKUP_FORMAT) {
    issues.push(`格式不支持: ${String(file.format)}`);
    return { issues };
  }
  if (!Array.isArray(file.contents) || file.contents.length === 0) {
    issues.push("contents 缺失或为空");
    return { issues, file };
  }
  for (const content of file.contents) {
    if (!BACKUP_TABLES.includes(content.table as BackupTable)) {
      issues.push(`未知数据表: ${String(content.table)}`);
      continue;
    }
    if (typeof content.rowCount !== "number" || !Array.isArray(content.rows)) {
      issues.push(`${content.table}: 行数据缺失`);
      continue;
    }
    if (content.rowCount !== content.rows.length) {
      issues.push(`${content.table}: rowCount 与行数不一致`);
    }
    if (hashRows(content.rows) !== content.sha256) {
      issues.push(`${content.table}: 内容哈希校验失败（文件损坏或被篡改）`);
    }
  }
  return { issues, file };
}

/** 恢复预览（spec 15 §5：恢复先验证格式/哈希并展示目标，不覆盖无确认）。 */
export async function previewBackupImport(
  fileValue: unknown,
  connection: RunStoreConnection,
): Promise<BackupImportPreview> {
  await connection.ensureReady();
  const db = connection.getDatabase();
  const { issues, file } = validateBackupFile(fileValue);
  const targetLedger = db
    .prepare(`SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1`)
    .get() as { id: string } | undefined;
  const preview: BackupImportPreview = {
    valid: issues.length === 0 && file !== undefined,
    issues,
    manifest: {
      format: file?.format ?? "unknown",
      appVersion: file?.appVersion ?? "unknown",
      generatedAt: file?.generatedAt ?? 0,
      schemaVersion: file?.schemaVersion ?? null,
      tables: (file?.contents ?? []).map((c) => ({ table: c.table, rowCount: c.rowCount })),
    },
    targetSchemaVersion: targetLedger?.id ?? null,
  };
  return preview;
}

/**
 * 恢复执行：必须显式 confirm=true（spec 06 §5：不覆盖用户数据而无明确确认）。
 * 单事务内按清单逐表 REPLACE 写入（表内容以备份为准）；完成后重建 FTS 影子表。
 */
export async function restoreBackup(
  fileValue: unknown,
  connection: RunStoreConnection,
  options: { confirm: boolean },
): Promise<{ restoredTables: string[]; restoredRows: number }> {
  if (options.confirm !== true) {
    throw Object.assign(new Error("恢复必须显式 confirm=true"), { kind: "restore_not_confirmed" });
  }
  await connection.ensureReady();
  const db = connection.getDatabase();
  const { issues, file } = validateBackupFile(fileValue);
  if (issues.length > 0 || !file) {
    throw Object.assign(new Error(`备份文件校验失败: ${issues.join("; ")}`), {
      kind: "backup_validation_failed",
      issues,
    });
  }
  const restoredTables: string[] = [];
  let restoredRows = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const content of file.contents) {
      db.prepare(`DELETE FROM ${content.table}`).run();
      if (content.rows.length > 0) {
        const columns = Object.keys(content.rows[0] as DatabaseRow);
        const insert = db.prepare(
          `INSERT OR REPLACE INTO ${content.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        );
        for (const row of content.rows as DatabaseRow[]) {
          insert.run(
            ...columns.map((column) =>
              row[column] === undefined ? null : (row[column] as string | number | bigint | Buffer | null),
            ),
          );
        }
      }
      restoredTables.push(content.table);
      restoredRows += content.rows.length;
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      /* 回滚失败不覆盖原始异常。 */
    }
    throw error;
  }
  // FTS 影子表未随备份导出；恢复后重建（幂等）。Feed 域有自己的 FTS 影子表，
  // 恢复了 pb_feed_items 后同样需要重建，否则全文检索结果漂移。
  db.exec(PLAYABLEBENCH_FTS_REBUILD_SQL);
  db.exec(PB_FEED_FTS_REBUILD_SQL);
  return { restoredTables, restoredRows };
}
