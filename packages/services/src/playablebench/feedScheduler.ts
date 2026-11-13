// Feed 调度器（spec 08 §5）：source 级 single-flight、条件请求游标、
// 429 Retry-After 遵守、失败指数退避 + jitter、4xx 不加速重试、
// 分批补采（恢复时不在同一时刻对全部源发请求）。全局/单源暂停由
// source.paused 承载，调度前检查。失败不清空旧内容（upsert 只增改）。
import type { FeedFetchOutcome, FeedConnector } from "#src/playablebench/feedConnector.js";
import { canonicalizeUrl, computeContentHash } from "#src/playablebench/feedConnector.js";
import type { FeedSourceRepo } from "#src/session/feedSourceRepo.js";
import type { FeedItemRepo } from "#src/session/feedItemRepo.js";

export interface FeedSchedulerOptions {
  sources: FeedSourceRepo;
  items: FeedItemRepo;
  connector: FeedConnector;
  now?: () => number;
  /** 分批补采批大小（spec 08 §5：应用恢复时分批，不同时打满全部源）。 */
  batchSize?: number;
  /** 失败退避基数（毫秒）；实际等待 = base * 2^连续失败 + jitter。 */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface FeedRefreshResult {
  sourceId: string;
  status: "fetched" | "not_modified" | "failed" | "skipped_paused" | "skipped_in_flight" | "skipped_disabled";
  outcome?: FeedFetchOutcome;
  newItems?: number;
  /** 下次允许抓取的时间（退避/429 后被推迟；正常轮询由 pollIntervalSec 决定）。 */
  nextEligibleAt?: number;
}

export interface FeedSweepResult {
  attempted: number;
  skippedDueToConcurrency: number;
  results: FeedRefreshResult[];
}

const DEFAULT_BATCH_SIZE = 3;
const DEFAULT_BACKOFF_BASE_MS = 30_000;
const DEFAULT_BACKOFF_MAX_MS = 60 * 60 * 1000;

export class FeedScheduler {
  private readonly inFlight = new Set<string>();
  private readonly failureCounts = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(private readonly options: FeedSchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  }

  /** source 级 single-flight：同一 source 同时仅允许一个更新任务（spec 08 §5）。 */
  isRunning(sourceId: string): boolean {
    return this.inFlight.has(sourceId);
  }

  async refreshSource(sourceId: string): Promise<FeedRefreshResult> {
    // single-flight 占位必须在首个 await 前同步完成（check-then-act 跨 await 会
    // 让并发调用全部通过检查——single-flight 的关键竞态边界）。
    if (this.inFlight.has(sourceId)) {
      return { sourceId, status: "skipped_in_flight" };
    }
    this.inFlight.add(sourceId);
    const source = await this.options.sources.get(sourceId);
    if (!source) {
      return { sourceId, status: "skipped_disabled" };
    }
    if (!source.enabled) {
      return { sourceId, status: "skipped_disabled" };
    }
    if (source.paused) {
      return { sourceId, status: "skipped_paused" };
    }
    this.inFlight.add(sourceId);
    try {
      const nowMs = this.now();
      const backoffUntil = this.backoffUntil.get(sourceId);
      if (backoffUntil !== undefined && nowMs < backoffUntil) {
        return { sourceId, status: "skipped_in_flight", nextEligibleAt: backoffUntil };
      }
      const outcome = await this.options.connector.fetch(source);
      if (outcome.status === "fetched" && outcome.items) {
        let newItems = 0;
        for (const item of outcome.items) {
          if (!item.title && !item.linkUrl) continue;
          const canonicalUrl = canonicalizeUrl(item.linkUrl ?? source.url);
          const upsert = await this.options.items.upsertFromFetch({
            sourceId,
            sourceItemId: item.sourceItemId,
            originalUrl: item.linkUrl ?? source.url,
            canonicalUrl,
            title: item.title ?? canonicalUrl,
            author: item.author,
            publishedAt: item.publishedAt,
            summary: item.summaryText,
            contentHash: computeContentHash(item.title ?? canonicalUrl, item.summaryText),
            seenAt: nowMs,
          });
          if (upsert.created) newItems += 1;
        }
        await this.options.sources.recordAttempt(sourceId, {
          ok: true,
          etag: outcome.etag,
          lastModified: outcome.lastModified,
        });
        this.failureCounts.delete(sourceId);
        this.backoffUntil.delete(sourceId);
        return { sourceId, status: "fetched", outcome, newItems };
      }
      if (outcome.status === "not_modified") {
        await this.options.sources.recordAttempt(sourceId, {
          ok: true,
          etag: outcome.etag,
          lastModified: outcome.lastModified,
        });
        this.failureCounts.delete(sourceId);
        this.backoffUntil.delete(sourceId);
        return { sourceId, status: "not_modified", outcome };
      }
      // 失败：记录健康错误；指数退避 + jitter（429 优先遵守 Retry-After）。
      const failures = (this.failureCounts.get(sourceId) ?? 0) + 1;
      this.failureCounts.set(sourceId, failures);
      const backoff = Math.min(
        this.backoffBaseMs * 2 ** Math.min(failures, 10) + Math.floor(Math.random() * 1_000),
        this.backoffMaxMs,
      );
      const retryAfter = outcome.retryAfterSeconds ? outcome.retryAfterSeconds * 1000 : 0;
      const nextEligibleAt = this.now() + Math.max(backoff, retryAfter);
      this.backoffUntil.set(sourceId, nextEligibleAt);
      await this.options.sources.recordAttempt(sourceId, {
        ok: false,
        errorCode: outcome.errorCode ?? `http_${outcome.httpStatus ?? 0}`,
      });
      return { sourceId, status: "failed", outcome, nextEligibleAt };
    } finally {
      this.inFlight.delete(sourceId);
    }
  }

  /** 扫描到期来源并分批补采（并发上限 batchSize）；暂停/停用源输出跳过原因。 */
  async refreshDueSources(): Promise<FeedSweepResult> {
    const nowMs = this.now();
    const all = await this.options.sources.list();
    const results: FeedRefreshResult[] = [];
    const due: string[] = [];
    let skippedDueToConcurrency = 0;
    for (const source of all) {
      if (!source.enabled) {
        results.push({ sourceId: source.id, status: "skipped_disabled" });
        continue;
      }
      if (source.paused) {
        results.push({ sourceId: source.id, status: "skipped_paused" });
        continue;
      }
      if (this.inFlight.has(source.id)) {
        skippedDueToConcurrency += 1;
        continue;
      }
      const backoffUntil = this.backoffUntil.get(source.id);
      if (backoffUntil !== undefined && nowMs < backoffUntil) continue;
      const intervalMs = Math.max(60, source.pollIntervalSec) * 1000;
      if (source.lastAttemptAt !== undefined && nowMs - source.lastAttemptAt < intervalMs) continue;
      due.push(source.id);
    }
    let attempted = 0;
    for (let index = 0; index < due.length; index += this.batchSize) {
      const batch = due.slice(index, index + this.batchSize);
      const batchResults = await Promise.all(batch.map((id) => this.refreshSource(id)));
      for (const result of batchResults) {
        if (result.status === "skipped_in_flight") skippedDueToConcurrency += 1;
        else attempted += 1;
        results.push(result);
      }
    }
    return { attempted, skippedDueToConcurrency, results };
  }
}
