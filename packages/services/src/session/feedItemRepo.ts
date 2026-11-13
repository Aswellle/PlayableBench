// PlayableBench Feed 条目仓库（spec 06 §2/§3、spec 08 §7）。
// 去重三级键：同源 (source_item_id) → 同源 (content_hash) → canonical_url 查找；
// 命中即合并（保留 first_seen_at、推进 last_seen_at、追加多来源 attribution），
// 失败/重复投递不产生重复行（upsert 语义即"失败不清空旧内容"的一半，
// 另一半是抓取失败不删旧行——本仓库无任何按失败删除的路径）。
import { randomUUID } from "node:crypto";
import type { FeedItem, FeedItemUpsertInput, FeedMetricSnapshot, FeedMetricOrigin } from "@zcode/shared";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

interface ItemRow {
  id: string;
  source_id: string;
  source_item_id: string | null;
  canonical_url: string;
  original_url: string;
  title: string;
  author: string | null;
  published_at: number | null;
  first_seen_at: number;
  last_seen_at: number;
  summary: string | null;
  content_hash: string | null;
  language: string | null;
  media_refs_json: string | null;
  tags_json: string | null;
  attribution_json: string | null;
  read_at: number | null;
  favorite_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToItem(row: ItemRow): FeedItem {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceItemId: row.source_item_id ?? undefined,
    canonicalUrl: row.canonical_url,
    originalUrl: row.original_url,
    title: row.title,
    author: row.author ?? undefined,
    publishedAt: row.published_at ?? undefined,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    summary: row.summary ?? undefined,
    contentHash: row.content_hash ?? undefined,
    language: row.language ?? undefined,
    mediaRefsJson: row.media_refs_json ?? undefined,
    tagsJson: row.tags_json ?? undefined,
    attributionJson: row.attribution_json ?? undefined,
    readAt: row.read_at ?? undefined,
    favoriteAt: row.favorite_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface MetricRow {
  id: string;
  feed_item_id: string;
  source_id: string;
  sampled_at: number;
  metric_name: string;
  metric_value: string | null;
  metric_unit: string | null;
  metric_origin: string;
  source_rank: number | null;
}

function rowToMetric(row: MetricRow): FeedMetricSnapshot {
  return {
    id: row.id,
    feedItemId: row.feed_item_id,
    sourceId: row.source_id,
    sampledAt: row.sampled_at,
    metricName: row.metric_name,
    metricValue: row.metric_value ?? undefined,
    metricUnit: row.metric_unit ?? undefined,
    metricOrigin: row.metric_origin as FeedMetricOrigin,
    sourceRank: row.source_rank ?? undefined,
  };
}

export interface FeedUpsertResult {
  item: FeedItem;
  created: boolean;
  /** 命中的去重键（source_item_id | content_hash | none）。 */
  deduplicatedBy: "source_item_id" | "content_hash" | "none";
}

export interface FeedCardQuery {
  sourceId?: string;
  favoritesOnly?: boolean;
  unreadOnly?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export class FeedItemRepo {
  constructor(private readonly connection: RunStoreConnection) {}

  private getDatabase() {
    return this.connection.getDatabase();
  }

  private insertRow(input: FeedItemUpsertInput, attributionJson: string | null, now: number): string {
    const id = `item-${randomUUID()}`;
    this.getDatabase()
      .prepare(
        `INSERT INTO pb_feed_items (
          id, source_id, source_item_id, canonical_url, original_url, title, author,
          published_at, first_seen_at, last_seen_at, summary, content_hash, language,
          media_refs_json, tags_json, attribution_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceId,
        input.sourceItemId ?? null,
        input.canonicalUrl,
        input.originalUrl,
        input.title,
        input.author ?? null,
        input.publishedAt ?? null,
        input.seenAt ?? now,
        input.seenAt ?? now,
        input.summary ?? null,
        input.contentHash ?? null,
        input.language ?? null,
        input.mediaRefsJson ?? null,
        input.tagsJson ?? null,
        attributionJson,
        now,
        now,
      );
    return id;
  }

  /**
   * 采集入库：三级去重（spec 08 §7）。命中时保留 first_seen_at、推进
   * last_seen_at、合并 attribution（URL 不同才追加）；标题/摘要以最新为准。
   */
  async upsertFromFetch(input: FeedItemUpsertInput): Promise<FeedUpsertResult> {
    await this.connection.ensureReady();
    const db = this.getDatabase();
    const now = input.seenAt ?? Date.now();
    const attributionUrl = input.originalUrl;
    const mergeAttribution = (existing: string | null): string => {
      let entries: Array<{ sourceId: string; url: string }> = [];
      if (existing) {
        try {
          entries = JSON.parse(existing) as Array<{ sourceId: string; url: string }>;
        } catch {
          entries = [];
        }
      }
      if (!entries.some((e) => e.url === attributionUrl)) {
        entries.push({ sourceId: input.sourceId, url: attributionUrl });
      }
      return JSON.stringify(entries);
    };

    const byItemId = input.sourceItemId
      ? (db
          .prepare(`SELECT * FROM pb_feed_items WHERE source_id = ? AND source_item_id = ?`)
          .get(input.sourceId, input.sourceItemId) as ItemRow | undefined)
      : undefined;
    const byHash =
      byItemId ?? (input.contentHash
        ? (db
            .prepare(`SELECT * FROM pb_feed_items WHERE source_id = ? AND content_hash = ?`)
            .get(input.sourceId, input.contentHash) as ItemRow | undefined)
        : undefined);
    const existing = byItemId ?? byHash;

    if (existing) {
      db.prepare(
        `UPDATE pb_feed_items SET
           last_seen_at = MAX(last_seen_at, ?),
           title = ?,
           summary = COALESCE(?, summary),
           author = COALESCE(?, author),
           published_at = COALESCE(published_at, ?),
           attribution_json = ?,
           updated_at = ?
         WHERE id = ?`,
      ).run(
        now,
        input.title,
        input.summary ?? null,
        input.author ?? null,
        input.publishedAt ?? null,
        mergeAttribution(existing.attribution_json),
        now,
        existing.id,
      );
      const updated = db.prepare(`SELECT * FROM pb_feed_items WHERE id = ?`).get(existing.id) as unknown as ItemRow;
      return {
        item: rowToItem(updated),
        created: false,
        deduplicatedBy: byItemId ? "source_item_id" : "content_hash",
      };
    }

    const id = this.insertRow(input, JSON.stringify([{ sourceId: input.sourceId, url: attributionUrl }]), now);
    const created = db.prepare(`SELECT * FROM pb_feed_items WHERE id = ?`).get(id) as unknown as ItemRow;
    return { item: rowToItem(created), created: true, deduplicatedBy: "none" };
  }

  async get(id: string): Promise<FeedItem | null> {
    await this.connection.ensureReady();
    const row = this.getDatabase().prepare(`SELECT * FROM pb_feed_items WHERE id = ?`).get(id) as
      | ItemRow
      | undefined;
    return row ? rowToItem(row) : null;
  }

  /** 统一卡片列表（spec 08 §4 字段契约在 FeedItem 内）；FTS ∪ LIKE 搜索。 */
  async listCards(query: FeedCardQuery = {}): Promise<FeedItem[]> {
    await this.connection.ensureReady();
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    const offset = Math.max(0, query.offset ?? 0);
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (query.sourceId) {
      conditions.push("source_id = ?");
      values.push(query.sourceId);
    }
    if (query.favoritesOnly) conditions.push("favorite_at IS NOT NULL");
    if (query.unreadOnly) conditions.push("read_at IS NULL");
    const like = query.search?.trim();
    if (like) {
      const likePattern = `%${like.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const fts = this.getDatabase()
        .prepare(
          `SELECT pb_feed_items.id FROM fts_pb_feed_items
           JOIN pb_feed_items ON pb_feed_items.rowid = fts_pb_feed_items.rowid
           WHERE fts_pb_feed_items MATCH ?`,
        )
        .all(`"${like.replace(/"/g, '""')}"`) as Array<{ id: string }>;
      conditions.push(`(id IN (${fts.map(() => "?").join(",") || "''"}) OR title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')`);
      values.push(...fts.map((r) => r.id), likePattern, likePattern);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM pb_feed_items${where}
         ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as unknown as ItemRow[];
    return rows.map(rowToItem);
  }

  async setFavorite(id: string, favorite: boolean): Promise<FeedItem | null> {
    await this.connection.ensureReady();
    this.getDatabase()
      .prepare(`UPDATE pb_feed_items SET favorite_at = ?, updated_at = ? WHERE id = ?`)
      .run(favorite ? Date.now() : null, Date.now(), id);
    return this.get(id);
  }

  async markRead(id: string, read = true): Promise<FeedItem | null> {
    await this.connection.ensureReady();
    this.getDatabase()
      .prepare(`UPDATE pb_feed_items SET read_at = ?, updated_at = ? WHERE id = ?`)
      .run(read ? Date.now() : null, Date.now(), id);
    return this.get(id);
  }

  async countCards(params?: { sourceId?: string }): Promise<{ unread: number; favorites: number; total: number }> {
    await this.connection.ensureReady();
    const where = params?.sourceId ? ` WHERE source_id = ?` : "";
    const values = params?.sourceId ? [params.sourceId] : [];
    const row = this.getDatabase()
      .prepare(
        `SELECT
           SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,
           SUM(CASE WHEN favorite_at IS NOT NULL THEN 1 ELSE 0 END) AS favorites,
           COUNT(*) AS total
         FROM pb_feed_items${where}`,
      )
      .get(...values) as { unread: number | null; favorites: number | null; total: number };
    return { unread: row.unread ?? 0, favorites: row.favorites ?? 0, total: row.total };
  }

  /** 指标采样入库：同 (item, metric, sampledAt) 重复采样幂等忽略（spec 08 §7 保留采样点）。 */
  async addMetric(input: {
    feedItemId: string;
    sourceId: string;
    sampledAt?: number;
    metricName: string;
    metricValue?: string;
    metricUnit?: string;
    metricOrigin: FeedMetricOrigin;
    sourceRank?: number;
  }): Promise<FeedMetricSnapshot> {
    await this.connection.ensureReady();
    const db = this.getDatabase();
    const sampledAt = input.sampledAt ?? Date.now();
    const existing = db
      .prepare(
        `SELECT * FROM pb_feed_metric_snapshots WHERE feed_item_id = ? AND metric_name = ? AND sampled_at = ?`,
      )
      .get(input.feedItemId, input.metricName, sampledAt) as MetricRow | undefined;
    if (existing) return rowToMetric(existing);
    const id = `metric-${randomUUID()}`;
    db.prepare(
      `INSERT INTO pb_feed_metric_snapshots (
        id, feed_item_id, source_id, sampled_at, metric_name, metric_value, metric_unit, metric_origin, source_rank
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.feedItemId,
      input.sourceId,
      sampledAt,
      input.metricName,
      input.metricValue ?? null,
      input.metricUnit ?? null,
      input.metricOrigin,
      input.sourceRank ?? null,
    );
    const created = db
      .prepare(`SELECT * FROM pb_feed_metric_snapshots WHERE id = ?`)
      .get(id) as unknown as MetricRow;
    return rowToMetric(created);
  }

  async listMetrics(feedItemId: string): Promise<FeedMetricSnapshot[]> {
    await this.connection.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM pb_feed_metric_snapshots WHERE feed_item_id = ? ORDER BY sampled_at DESC, metric_name ASC`,
      )
      .all(feedItemId) as unknown as MetricRow[];
    return rows.map(rowToMetric);
  }
}
