// PlayableBench 信息雷达页（spec 01 §4、Phase 4 S7 最小版）。
// 卡片契约（spec 08 §4）：原始标题/来源名（归属不隐藏）/作者/发布时间/
// firstSeenAt/摘要/原文链接；来源管理最小面（添加/暂停/删除/手动刷新）。
// 密度切换与"交给 Agent 研究"等闭环动作随 Phase 5；HTML 不渲染，仅纯文本。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Heart,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Rss,
  Trash2,
} from "lucide-react";
import type { FeedItem, FeedSource } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

type CardFilter = "all" | "favorites" | "unread";

function formatTime(value: number): string {
  return new Date(value).toLocaleString();
}

export function RadarView() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const service = services.feedService;
  const [sources, setSources] = useState<FeedSource[] | null>(null);
  const [cards, setCards] = useState<FeedItem[] | null>(null);
  const [counts, setCounts] = useState<{ unread: number; favorites: number; total: number } | null>(null);
  const [filter, setFilter] = useState<CardFilter>("all");
  const [draftUrl, setDraftUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!service) return;
    try {
      const [nextSources, nextCards, nextCounts] = await Promise.all([
        service.listSources(),
        service.listCards(
          filter === "favorites"
            ? { favoritesOnly: true, limit: 100 }
            : filter === "unread"
              ? { unreadOnly: true, limit: 100 }
              : { limit: 100 },
        ),
        service.getCardCounts(),
      ]);
      setSources(nextSources);
      setCards(nextCards);
      setCounts(nextCounts);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      logger.warn("[playablebench] Radar 加载失败", { error: message });
    }
  }, [filter, service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sourceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const source of sources ?? []) map.set(source.id, source.name);
    return map;
  }, [sources]);

  const handleAddSource = useCallback(async () => {
    if (!service || !draftUrl.trim()) return;
    setAdding(true);
    try {
      await service.addSource({ url: draftUrl.trim() });
      setDraftUrl("");
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      logger.warn("[playablebench] Radar 添加来源失败", { error: message });
    } finally {
      setAdding(false);
    }
  }, [draftUrl, refresh, service]);

  const handleRefreshSource = useCallback(
    async (id: string) => {
      if (!service) return;
      setRefreshingId(id);
      try {
        await service.refreshSource(id);
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLoadError(message);
      } finally {
        setRefreshingId(null);
      }
    },
    [refresh, service],
  );

  const handleTogglePause = useCallback(
    async (source: FeedSource) => {
      if (!service) return;
      await service.pauseSource(source.id, !source.paused);
      await refresh();
    },
    [refresh, service],
  );

  const handleRemoveSource = useCallback(
    async (source: FeedSource) => {
      if (!service) return;
      await service.removeSource(source.id);
      await refresh();
    },
    [refresh, service],
  );

  const handleToggleFavorite = useCallback(
    async (item: FeedItem) => {
      if (!service) return;
      await service.setFavorite(item.id, item.favoriteAt === undefined);
      await refresh();
    },
    [refresh, service],
  );

  const handleToggleRead = useCallback(
    async (item: FeedItem) => {
      if (!service) return;
      await service.markRead(item.id, item.readAt === undefined);
      await refresh();
    },
    [refresh, service],
  );

  const filterButton = (value: CardFilter, label: string) => (
    <Button
      type="button"
      variant={filter === value ? "default" : "outline"}
      size="default"
      className="enabled:cursor-pointer"
      onClick={() => setFilter(value)}
      aria-pressed={filter === value}
    >
      {label}
    </Button>
  );

  if (!service) {
    return (
      <p className="text-ui-base/relaxed text-foreground-subtle">
        {intl.formatMessage({ id: "playablebench.unsupportedHost" })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="playablebench-radar-view">
      <div
        className="rounded-xl border border-border bg-surface p-4"
        data-testid="playablebench-radar-add-source"
      >
        <label className="mb-2 block text-ui-base/relaxed font-medium text-foreground" htmlFor="playablebench-radar-url">
          {intl.formatMessage({ id: "playablebench.radar.addSourceLabel" })}
        </label>
        <div className="flex gap-2">
          <input
            id="playablebench-radar-url"
            type="url"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background p-2.5 text-ui-base/relaxed text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
            placeholder={intl.formatMessage({ id: "playablebench.radar.addSourcePlaceholder" })}
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleAddSource();
              }
            }}
          />
          <Button
            type="button"
            variant="default"
            size="default"
            className="gap-2"
            onClick={() => void handleAddSource()}
            disabled={adding || !draftUrl.trim()}
          >
            <Rss className="size-3.5" />
            {intl.formatMessage({ id: "playablebench.radar.addSource" })}
          </Button>
        </div>
      </div>

      {loadError !== null ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0" />
          <span className="text-ui-base/relaxed">{loadError}</span>
        </div>
      ) : null}

      <section aria-label={intl.formatMessage({ id: "playablebench.radar.sources" })} className="flex flex-col gap-2">
        <h2 className="text-ui-base/relaxed font-medium text-foreground">
          {intl.formatMessage({ id: "playablebench.radar.sources" })}
        </h2>
        {sources === null ? null : sources.length === 0 ? (
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "playablebench.radar.sourcesEmpty" })}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sources.map((source) => (
              <li
                key={source.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-ui-base/relaxed text-foreground">{source.name}</span>
                  <span className="truncate text-ui-base/relaxed text-foreground-subtle">
                    {source.paused
                      ? intl.formatMessage({ id: "playablebench.radar.sourcePaused" })
                      : source.lastErrorCode
                        ? intl.formatMessage(
                            { id: "playablebench.radar.sourceError" },
                            { code: source.lastErrorCode },
                          )
                        : source.lastSuccessAt
                          ? intl.formatMessage(
                              { id: "playablebench.radar.sourceLastSuccess" },
                              { time: formatTime(source.lastSuccessAt) },
                            )
                          : ""}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    className="gap-1.5"
                    onClick={() => void handleRefreshSource(source.id)}
                    disabled={refreshingId === source.id}
                  >
                    <RefreshCw className={refreshingId === source.id ? "size-3.5 animate-spin" : "size-3.5"} />
                    {intl.formatMessage({ id: "playablebench.radar.refresh" })}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    aria-label={
                      source.paused
                        ? intl.formatMessage({ id: "playablebench.radar.resumeSource" })
                        : intl.formatMessage({ id: "playablebench.radar.pauseSource" })
                    }
                    onClick={() => void handleTogglePause(source)}
                  >
                    {source.paused ? <PlayCircle className="size-3.5" /> : <PauseCircle className="size-3.5" />}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    aria-label={intl.formatMessage({ id: "playablebench.radar.removeSource" })}
                    onClick={() => void handleRemoveSource(source)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={intl.formatMessage({ id: "playablebench.radar.cards" })} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-ui-base/relaxed font-medium text-foreground">
            {intl.formatMessage({ id: "playablebench.radar.cards" })}
            {counts ? (
              <span className="ml-2 text-foreground-subtle" aria-hidden="true">
                {counts.unread}
              </span>
            ) : null}
          </h2>
          <div className="flex gap-1.5">
            {filterButton("all", intl.formatMessage({ id: "playablebench.radar.filterAll" }))}
            {filterButton("favorites", intl.formatMessage({ id: "playablebench.radar.filterFavorites" }))}
            {filterButton("unread", intl.formatMessage({ id: "playablebench.radar.filterUnread" }))}
          </div>
        </div>
        {cards === null ? (
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "playablebench.loading" })}
          </p>
        ) : cards.length === 0 ? (
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "playablebench.radar.cardsEmpty" })}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {cards.map((item) => (
              <li key={item.id} className="rounded-xl border border-border bg-surface p-4" data-testid="playablebench-radar-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-ui-base/relaxed font-medium text-foreground">{item.title}</span>
                    <span className="truncate text-ui-base/relaxed text-foreground-subtle">
                      {sourceNameById.get(item.sourceId) ?? item.sourceId}
                      {item.author ? ` · ${item.author}` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      aria-pressed={item.favoriteAt !== undefined}
                      aria-label={intl.formatMessage({ id: "playablebench.radar.favorite" })}
                      onClick={() => void handleToggleFavorite(item)}
                    >
                      <Heart className={item.favoriteAt !== undefined ? "size-3.5 fill-current" : "size-3.5"} />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      aria-pressed={item.readAt !== undefined}
                      aria-label={intl.formatMessage({ id: "playablebench.radar.markRead" })}
                      onClick={() => void handleToggleRead(item)}
                    >
                      {intl.formatMessage({ id: item.readAt !== undefined ? "playablebench.radar.unread" : "playablebench.radar.read" })}
                    </Button>
                    <a
                      href={item.originalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-ui-base/relaxed text-foreground hover:bg-surface-hover"
                    >
                      <ExternalLink className="size-3.5" />
                      {intl.formatMessage({ id: "playablebench.radar.openOriginal" })}
                    </a>
                  </div>
                </div>
                {item.summary ? (
                  <p className="mt-2 line-clamp-3 text-ui-base/relaxed text-foreground-subtle">{item.summary}</p>
                ) : null}
                <p className="mt-2 text-ui-base/relaxed text-foreground-subtle">
                  {item.publishedAt
                    ? intl.formatMessage(
                        { id: "playablebench.radar.publishedAt" },
                        { time: formatTime(item.publishedAt) },
                      )
                    : ""}
                  {` · `}
                  {intl.formatMessage(
                    { id: "playablebench.radar.firstSeenAt" },
                    { time: formatTime(item.firstSeenAt) },
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
