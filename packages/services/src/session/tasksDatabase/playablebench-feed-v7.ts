// Phase 4 信息雷达域迁移（PlayableBench）：FeedSource/FeedItem/MetricSnapshot
// 存储（spec 06 §2/§3、spec 08、docs/audit/11-Phase4-开发计划.md S1）。
// 全部为纯增量 DDL；去重键： (source_id, source_item_id) 部分唯一（值存在时）、
// (source_id, content_hash) 部分唯一（同源同内容）；canonical_url 只建查找索引
// 不做全局唯一（spec 06 §3：跨源镜像可能有不同授权/语义，合并归 repo 层）。
// FTS external-content 表吸取 0006 教训：content 表名逐字为 pb_feed_items，
// 迁移测试断言 sqlite_master.sql 含 content='pb_feed_items'。

export const PB_FEED_SOURCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_feed_sources (
  id TEXT PRIMARY KEY,
  connector_type TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  paused INTEGER NOT NULL DEFAULT 0,
  poll_interval_sec INTEGER NOT NULL DEFAULT 900,
  etag TEXT,
  last_modified TEXT,
  config_json TEXT,
  capabilities_json TEXT,
  terms_url TEXT,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error_code TEXT,
  last_error_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_feed_sources_url ON pb_feed_sources(url);
CREATE INDEX IF NOT EXISTS idx_pb_feed_sources_enabled ON pb_feed_sources(enabled, updated_at DESC);
`;

export const PB_FEED_ITEMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_feed_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_item_id TEXT,
  canonical_url TEXT NOT NULL,
  original_url TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  published_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  summary TEXT,
  content_hash TEXT,
  language TEXT,
  media_refs_json TEXT,
  tags_json TEXT,
  attribution_json TEXT,
  read_at INTEGER,
  favorite_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_feed_items_source_item
  ON pb_feed_items(source_id, source_item_id) WHERE source_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_feed_items_source_hash
  ON pb_feed_items(source_id, content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pb_feed_items_canonical ON pb_feed_items(canonical_url);
CREATE INDEX IF NOT EXISTS idx_pb_feed_items_source_published
  ON pb_feed_items(source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_pb_feed_items_seen ON pb_feed_items(first_seen_at DESC);
`;

export const PB_FEED_METRICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_feed_metric_snapshots (
  id TEXT PRIMARY KEY,
  feed_item_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value TEXT,
  metric_unit TEXT,
  metric_origin TEXT NOT NULL,
  source_rank INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_feed_metrics_sample
  ON pb_feed_metric_snapshots(feed_item_id, metric_name, sampled_at);
`;

export const PB_FEED_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_pb_feed_items USING fts5(
  title, summary, content='pb_feed_items', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS pb_feed_items_fts_ai AFTER INSERT ON pb_feed_items BEGIN
  INSERT INTO fts_pb_feed_items(rowid, title, summary)
  VALUES (new.rowid, new.title, COALESCE(new.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS pb_feed_items_fts_ad AFTER DELETE ON pb_feed_items BEGIN
  INSERT INTO fts_pb_feed_items(fts_pb_feed_items, rowid, title, summary)
  VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS pb_feed_items_fts_au AFTER UPDATE ON pb_feed_items BEGIN
  INSERT INTO fts_pb_feed_items(fts_pb_feed_items, rowid, title, summary)
  VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''));
  INSERT INTO fts_pb_feed_items(rowid, title, summary)
  VALUES (new.rowid, new.title, COALESCE(new.summary, ''));
END;
`;

export const PLAYABLEBENCH_FEED_V7_SQL = [
  PB_FEED_SOURCES_SCHEMA,
  PB_FEED_ITEMS_SCHEMA,
  PB_FEED_METRICS_SCHEMA,
  PB_FEED_FTS_SCHEMA,
].join("\n");

export function applyPlayableBenchFeedV7(db: { exec: (sql: string) => void }): void {
  db.exec(PLAYABLEBENCH_FEED_V7_SQL);
}

/** FTS 与内容表失漂时的重建入口（spec 06 §3）；幂等。 */
export const PB_FEED_FTS_REBUILD_SQL = `
INSERT INTO fts_pb_feed_items(fts_pb_feed_items) VALUES('rebuild');
`;
