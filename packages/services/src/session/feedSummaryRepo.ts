// FeedItem AI 摘要存储（spec 08 §9、spec 16 门禁"摘要可追溯"）。
// 缓存键：(feed_item_id, model, model_version) 与 (content_hash, model,
// model_version)（同内容同模型跨源镜像命中，迁移 0008 唯一索引）。
// 写入幂等：INSERT OR IGNORE 后回读；reused=true 表示缓存命中不重复生成。
import { randomUUID } from "node:crypto";
import type { PbFeedSummary, PbSummaryCitation } from "@zcode/shared";
import type { RunStoreConnection } from "#src/session/runStoreConnection.js";

interface SummaryRow {
  id: string;
  feed_item_id: string;
  content_hash: string | null;
  source_url: string;
  title: string;
  model: string;
  model_version: string;
  summary_text: string;
  citations_json: string | null;
  run_id: string | null;
  note_id: string | null;
  created_at: number;
}

function rowToSummary(row: SummaryRow): PbFeedSummary {
  let citations: PbSummaryCitation[] = [];
  if (row.citations_json) {
    try {
      const parsed = JSON.parse(row.citations_json) as unknown;
      if (Array.isArray(parsed)) citations = parsed as PbSummaryCitation[];
    } catch {
      /* 损坏引用按空处理，不掩盖摘要正文。 */
    }
  }
  return {
    id: row.id,
    feedItemId: row.feed_item_id,
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
    sourceUrl: row.source_url,
    title: row.title,
    model: row.model,
    modelVersion: row.model_version,
    summaryText: row.summary_text,
    citations,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.note_id !== null ? { noteId: row.note_id } : {}),
    createdAt: row.created_at,
  };
}

export interface CreateSummaryInput {
  feedItemId: string;
  contentHash?: string;
  sourceUrl: string;
  title: string;
  model: string;
  modelVersion: string;
  summaryText: string;
  citations: PbSummaryCitation[];
  runId?: string;
}

export class FeedSummaryRepo {
  constructor(private readonly connection: RunStoreConnection) {}

  async ensureReady(): Promise<void> {
    await this.connection.ensureReady();
  }

  /** 同卡同模型缓存查找；contentHash 提供时同内容同模型跨卡也命中。 */
  async findForCard(params: {
    feedItemId: string;
    contentHash?: string;
    model: string;
    modelVersion: string;
  }): Promise<PbFeedSummary | null> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const direct = db
      .prepare(
        `SELECT * FROM pb_feed_summaries WHERE feed_item_id = ? AND model = ? AND model_version = ?`,
      )
      .get(params.feedItemId, params.model, params.modelVersion) as unknown as SummaryRow | undefined;
    if (direct) return rowToSummary(direct);
    if (!params.contentHash) return null;
    const byHash = db
      .prepare(
        `SELECT * FROM pb_feed_summaries WHERE content_hash = ? AND model = ? AND model_version = ?`,
      )
      .get(params.contentHash, params.model, params.modelVersion) as unknown as SummaryRow | undefined;
    return byHash ? rowToSummary(byHash) : null;
  }

  /** 写入（幂等）：唯一键冲突按已存在行回读，reused=true 表示缓存命中。 */
  async create(input: CreateSummaryInput): Promise<{ summary: PbFeedSummary; reused: boolean }> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const existing = await this.findForCard({
      feedItemId: input.feedItemId,
      ...(input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
      model: input.model,
      modelVersion: input.modelVersion,
    });
    if (existing) return { summary: existing, reused: true };
    const id = `sum-${randomUUID()}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO pb_feed_summaries
         (id, feed_item_id, content_hash, source_url, title, model, model_version,
          summary_text, citations_json, run_id, note_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      id,
      input.feedItemId,
      input.contentHash ?? null,
      input.sourceUrl,
      input.title,
      input.model,
      input.modelVersion,
      input.summaryText,
      input.citations.length > 0 ? JSON.stringify(input.citations) : null,
      input.runId ?? null,
      now,
    );
    const row = db.prepare(`SELECT * FROM pb_feed_summaries WHERE id = ?`).get(id) as unknown as SummaryRow;
    return { summary: rowToSummary(row), reused: false };
  }

  /** 卡片全部摘要（含同内容跨卡缓存行），最新在前。 */
  async listForCard(params: { feedItemId: string; contentHash?: string }): Promise<PbFeedSummary[]> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const rows = params.contentHash
      ? (db
          .prepare(
            `SELECT * FROM pb_feed_summaries
             WHERE feed_item_id = ? OR (content_hash = ? AND content_hash IS NOT NULL)
             ORDER BY created_at DESC`,
          )
          .all(params.feedItemId, params.contentHash) as unknown as SummaryRow[])
      : (db
          .prepare(`SELECT * FROM pb_feed_summaries WHERE feed_item_id = ? ORDER BY created_at DESC`)
          .all(params.feedItemId) as unknown as SummaryRow[]);
    return rows.map(rowToSummary);
  }
}
