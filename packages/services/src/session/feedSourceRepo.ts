// PlayableBench Feed 来源仓库（spec 06 §2 FeedSource、spec 08 §3/§5/§10）。
// 健康字段（last_attempt/last_success/last_error）只随抓取尝试更新；
// 抓取失败不清空旧内容也不清空 last_success_at（spec 16 Phase 4 门禁）。
// 与 Run 域仓库共享同一 tasks-index 连接（runStoreConnection 的打开纪律）。
import { randomUUID } from "node:crypto";
import type { FeedSource, FeedSourceCapabilities, FeedSourceInput } from "@zcode/shared";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

interface SourceRow {
  id: string;
  connector_type: string;
  name: string;
  url: string;
  enabled: number;
  paused: number;
  poll_interval_sec: number;
  etag: string | null;
  last_modified: string | null;
  config_json: string | null;
  capabilities_json: string | null;
  terms_url: string | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error_code: string | null;
  last_error_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToSource(row: SourceRow): FeedSource {
  let capabilities: FeedSourceCapabilities | undefined;
  if (row.capabilities_json) {
    try {
      capabilities = JSON.parse(row.capabilities_json) as FeedSourceCapabilities;
    } catch {
      capabilities = undefined;
    }
  }
  return {
    id: row.id,
    connectorType: row.connector_type as FeedSource["connectorType"],
    name: row.name,
    url: row.url,
    enabled: row.enabled === 1,
    paused: row.paused === 1,
    pollIntervalSec: row.poll_interval_sec,
    etag: row.etag ?? undefined,
    lastModified: row.last_modified ?? undefined,
    configJson: row.config_json ?? undefined,
    capabilities,
    termsUrl: row.terms_url ?? undefined,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    lastSuccessAt: row.last_success_at ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorAt: row.last_error_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FeedSourceRepo {
  constructor(private readonly connection: RunStoreConnection) {}

  private getDatabase() {
    return this.connection.getDatabase();
  }

  /** 添加来源：同 URL 视为同一来源（库内唯一），重复添加抛结构化错误。 */
  async add(input: FeedSourceInput): Promise<FeedSource> {
    await this.connection.ensureReady();
    const now = Date.now();
    const id = `src-${randomUUID()}`;
    try {
      this.getDatabase()
        .prepare(
          `INSERT INTO pb_feed_sources (
            id, connector_type, name, url, enabled, paused, poll_interval_sec,
            config_json, capabilities_json, terms_url, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.connectorType,
          input.name,
          input.url,
          input.pollIntervalSec ?? 900,
          input.configJson ?? null,
          input.capabilities ? JSON.stringify(input.capabilities) : null,
          input.termsUrl ?? null,
          now,
          now,
        );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        String((error as { message?: string }).message ?? "").includes("pb_feed_sources.url")
      ) {
        throw Object.assign(new Error(`来源 URL 已存在: ${input.url}`), {
          kind: "source_url_exists",
        });
      }
      throw error;
    }
    const created = await this.get(id);
    if (!created) throw new Error(`feed source 写入后缺少记录: ${id}`);
    return created;
  }

  async get(id: string): Promise<FeedSource | null> {
    await this.connection.ensureReady();
    const row = this.getDatabase().prepare(`SELECT * FROM pb_feed_sources WHERE id = ?`).get(id) as
      | SourceRow
      | undefined;
    return row ? rowToSource(row) : null;
  }

  async getByUrl(url: string): Promise<FeedSource | null> {
    await this.connection.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM pb_feed_sources WHERE url = ?`)
      .get(url) as SourceRow | undefined;
    return row ? rowToSource(row) : null;
  }

  async list(params?: { enabled?: boolean; paused?: boolean; limit?: number }): Promise<FeedSource[]> {
    await this.connection.ensureReady();
    const limit = Math.max(1, Math.min(params?.limit ?? 200, 1000));
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (params?.enabled !== undefined) {
      conditions.push("enabled = ?");
      values.push(params.enabled ? 1 : 0);
    }
    if (params?.paused !== undefined) {
      conditions.push("paused = ?");
      values.push(params.paused ? 1 : 0);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.getDatabase()
      .prepare(`SELECT * FROM pb_feed_sources${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...values, limit) as unknown as SourceRow[];
    return rows.map(rowToSource);
  }

  async update(
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      pollIntervalSec?: number;
      configJson?: string | null;
      capabilities?: FeedSourceCapabilities;
      termsUrl?: string | null;
    },
  ): Promise<FeedSource | null> {
    await this.connection.ensureReady();
    const updates: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.name !== undefined) {
      updates.push("name = ?");
      values.push(patch.name);
    }
    if (patch.enabled !== undefined) {
      updates.push("enabled = ?");
      values.push(patch.enabled ? 1 : 0);
    }
    if (patch.pollIntervalSec !== undefined) {
      updates.push("poll_interval_sec = ?");
      values.push(patch.pollIntervalSec);
    }
    if (patch.configJson !== undefined) {
      updates.push("config_json = ?");
      values.push(patch.configJson);
    }
    if (patch.capabilities !== undefined) {
      updates.push("capabilities_json = ?");
      values.push(JSON.stringify(patch.capabilities));
    }
    if (patch.termsUrl !== undefined) {
      updates.push("terms_url = ?");
      values.push(patch.termsUrl);
    }
    if (updates.length === 0) return this.get(id);
    updates.push("updated_at = ?");
    values.push(Date.now(), id);
    this.getDatabase()
      .prepare(`UPDATE pb_feed_sources SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.get(id);
  }

  async setPaused(id: string, paused: boolean): Promise<FeedSource | null> {
    await this.connection.ensureReady();
    this.getDatabase()
      .prepare(`UPDATE pb_feed_sources SET paused = ?, updated_at = ? WHERE id = ?`)
      .run(paused ? 1 : 0, Date.now(), id);
    return this.get(id);
  }

  /** 全局暂停采集（spec 08 §5）：作用于全部来源。 */
  async setAllPaused(paused: boolean): Promise<number> {
    await this.connection.ensureReady();
    const result = this.getDatabase()
      .prepare(`UPDATE pb_feed_sources SET paused = ?, updated_at = ?`)
      .run(paused ? 1 : 0, Date.now());
    return Number(result.changes ?? 0);
  }

  /**
   * 记录一次抓取尝试的健康结果：last_attempt_at 总是更新；成功推进
   * last_success_at 并清错误、更新条件请求游标；失败只记错误码不清成功时间。
   */
  async recordAttempt(
    id: string,
    result: { ok: boolean; errorCode?: string; etag?: string; lastModified?: string },
  ): Promise<FeedSource | null> {
    await this.connection.ensureReady();
    const now = Date.now();
    if (result.ok) {
      this.getDatabase()
        .prepare(
          `UPDATE pb_feed_sources SET
             last_attempt_at = ?, last_success_at = ?, last_error_code = NULL, last_error_at = NULL,
             etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, result.etag ?? null, result.lastModified ?? null, now, id);
    } else {
      this.getDatabase()
        .prepare(
          `UPDATE pb_feed_sources SET
             last_attempt_at = ?, last_error_code = ?, last_error_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, result.errorCode ?? "fetch_failed", now, now, id);
    }
    return this.get(id);
  }

  /** 删除来源及其全部条目与采样（spec 06 §1 明确删除策略；级联由仓库显式执行）。 */
  async remove(id: string): Promise<boolean> {
    await this.connection.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `DELETE FROM pb_feed_metric_snapshots WHERE source_id = ?`,
      ).run(id);
      db.prepare(`DELETE FROM pb_feed_items WHERE source_id = ?`).run(id);
      const result = db.prepare(`DELETE FROM pb_feed_sources WHERE id = ?`).run(id);
      db.exec("COMMIT");
      return Number(result.changes ?? 0) > 0;
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* 回滚失败不覆盖原始异常。 */
      }
      throw error;
    }
  }
}
