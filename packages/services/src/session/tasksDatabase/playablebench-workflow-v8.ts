// 信息到工作流闭环域迁移（PlayableBench）：WorkflowTemplate 存储 + FeedItem
// AI 摘要（spec 06 §2、spec 08 §9、spec 05 §8、docs/audit/12-信息到工作流闭环-开发计划.md S1）。
// 全部为纯增量 DDL；pb_runs 的 template_id/template_version 已在 0005 预埋，
// 本迁移不再改动冻结面。模板以 (id, version) 复合主键保存：版本发布后不可
// 静默改变旧 run 的执行定义，新版本另存一行（spec 05 §8）。
// 摘要缓存键： (feed_item_id, model, model_version) 与
// (content_hash, model, model_version) 唯一（同内容同模型跨源镜像命中缓存；
// model_version 用 NOT NULL DEFAULT '' 表达"无版本"，避免 UNIQUE 索引 NULL
// 不相等导致重复行）。

export const PB_WORKFLOW_TEMPLATES_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_workflow_templates (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  input_schema TEXT,
  definition TEXT,
  permissions TEXT,
  approval_policy TEXT,
  output_schema TEXT,
  verification_rules TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);
`;

export const PB_FEED_SUMMARIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_feed_summaries (
  id TEXT PRIMARY KEY,
  feed_item_id TEXT NOT NULL,
  content_hash TEXT,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL DEFAULT '',
  summary_text TEXT NOT NULL,
  citations_json TEXT,
  run_id TEXT,
  note_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_feed_summaries_item_model
  ON pb_feed_summaries(feed_item_id, model, model_version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_feed_summaries_hash_model
  ON pb_feed_summaries(content_hash, model, model_version) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pb_feed_summaries_item ON pb_feed_summaries(feed_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pb_feed_summaries_run ON pb_feed_summaries(run_id)
  WHERE run_id IS NOT NULL;
`;

export const PLAYABLEBENCH_WORKFLOW_V8_SQL = [
  PB_WORKFLOW_TEMPLATES_SCHEMA,
  PB_FEED_SUMMARIES_SCHEMA,
].join("\n");

export function applyPlayableBenchWorkflowV8(db: { exec: (sql: string) => void }): void {
  db.exec(PLAYABLEBENCH_WORKFLOW_V8_SQL);
}
