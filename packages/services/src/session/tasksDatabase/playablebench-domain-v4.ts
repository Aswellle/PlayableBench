// Phase 2 领域域模型迁移（PlayableBench）：Inbox/Projects/Notes 关系存储 +
// 任务优先级/截止日投影列 + FTS5 全文索引（external-content + 触发器同步）。
// 修复依据：spec 06 §2/§3、docs/audit/09-Phase2-开发计划.md S1。
// 全部为纯增量 DDL；FTS5 采用 external-content 表，删除/更新同步由触发器保证，
// trigram 分词器提供 CJK 子串匹配（node:sqlite SQLite ≥3.53 实测可用）。

export const INBOX_ITEMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_inbox_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'text',
  raw_input TEXT NOT NULL,
  title TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'unprocessed',
  processing_error TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pb_inbox_items_status ON pb_inbox_items(status, created_at DESC);
`;

export const PROJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pb_notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pb_notes_project ON pb_notes(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pb_project_links (
  project_id TEXT NOT NULL,
  link_kind TEXT NOT NULL,
  link_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, link_kind, link_id)
);
CREATE INDEX IF NOT EXISTS idx_pb_project_links_link ON pb_project_links(link_kind, link_id);
`;

// tasks 表的查询投影列（meta_json 为单一来源，列用于 Today 聚合与筛选，见 taskIndexRepo）。
export const TASK_FIELDS_V4 = [
  ["tasks", "priority", "TEXT"],
  ["tasks", "due_at", "INTEGER"],
] as const;

export const TASK_FIELDS_V4_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at, deleted)
  WHERE due_at IS NOT NULL AND deleted=0;
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority, deleted)
  WHERE priority IS NOT NULL AND deleted=0;
`;

// FTS5 external-content：内容行变化由触发器写入索引，删除同步无需应用层参与。
// trigram 分词器支持拉丁与 CJK 子串匹配；rowid 与内容表隐式 rowid 一一对应。
export const PLAYABLEBENCH_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_tasks USING fts5(
  title, searchable_text, content='tasks', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO fts_tasks(rowid, title, searchable_text)
  VALUES (new.rowid, new.title, new.searchable_text);
END;
CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO fts_tasks(fts_tasks, rowid, title, searchable_text)
  VALUES ('delete', old.rowid, old.title, old.searchable_text);
END;
CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO fts_tasks(fts_tasks, rowid, title, searchable_text)
  VALUES ('delete', old.rowid, old.title, old.searchable_text);
  INSERT INTO fts_tasks(rowid, title, searchable_text)
  VALUES (new.rowid, new.title, new.searchable_text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS fts_pb_inbox USING fts5(
  raw_input, title, content='pb_inbox_items', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS pb_inbox_items_fts_ai AFTER INSERT ON pb_inbox_items BEGIN
  INSERT INTO fts_pb_inbox(rowid, raw_input, title)
  VALUES (new.rowid, new.raw_input, COALESCE(new.title, ''));
END;
CREATE TRIGGER IF NOT EXISTS pb_inbox_items_fts_ad AFTER DELETE ON pb_inbox_items BEGIN
  INSERT INTO fts_pb_inbox(fts_pb_inbox, rowid, raw_input, title)
  VALUES ('delete', old.rowid, old.raw_input, COALESCE(old.title, ''));
END;
CREATE TRIGGER IF NOT EXISTS pb_inbox_items_fts_au AFTER UPDATE ON pb_inbox_items BEGIN
  INSERT INTO fts_pb_inbox(fts_pb_inbox, rowid, raw_input, title)
  VALUES ('delete', old.rowid, old.raw_input, COALESCE(old.title, ''));
  INSERT INTO fts_pb_inbox(rowid, raw_input, title)
  VALUES (new.rowid, new.raw_input, COALESCE(new.title, ''));
END;

CREATE VIRTUAL TABLE IF NOT EXISTS fts_pb_notes USING fts5(
  title, body, content='notes', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS pb_notes_fts_ai AFTER INSERT ON pb_notes BEGIN
  INSERT INTO fts_pb_notes(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS pb_notes_fts_ad AFTER DELETE ON pb_notes BEGIN
  INSERT INTO fts_pb_notes(fts_pb_notes, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS pb_notes_fts_au AFTER UPDATE ON pb_notes BEGIN
  INSERT INTO fts_pb_notes(fts_pb_notes, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO fts_pb_notes(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`;

export const PLAYABLEBENCH_DOMAIN_V4_SQL = [
  INBOX_ITEMS_SCHEMA,
  PROJECTS_SCHEMA,
  PLAYABLEBENCH_FTS_SCHEMA,
].join("\n");

export function applyPlayableBenchDomainV4(db: {
  exec: (sql: string) => void;
  prepare: (sql: string) => { all: () => Array<Record<string, unknown>> };
}): void {
  // 顺序必须为：表/FTS → 加列 → 引用新列的索引（否则 CREATE INDEX 时列尚不存在）。
  db.exec(PLAYABLEBENCH_DOMAIN_V4_SQL);
  for (const [table, column, definition] of TASK_FIELDS_V4) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((entry) => entry.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec(TASK_FIELDS_V4_INDEXES);
}

/** FTS 与内容表失漂时的重建入口（spec 06 §3 要求）；幂等。 */
export const PLAYABLEBENCH_FTS_REBUILD_SQL = `
INSERT INTO fts_tasks(fts_tasks) VALUES('rebuild');
INSERT INTO fts_pb_inbox(fts_pb_inbox) VALUES('rebuild');
INSERT INTO fts_pb_notes(fts_pb_notes) VALUES('rebuild');
`;
