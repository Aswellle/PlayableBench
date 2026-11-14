// 信息雷达来源管理面板（spec 08 §3/§5 最小面）：添加 RSS/Atom 源 +
// 来源列表（手动刷新/暂停恢复/删除 + 健康状态可见）。memo 组件：函数 props
// 由父级 useCallback 保证引用稳定；状态行只透出 lastErrorCode/lastSuccessAt。
import { memo } from "react";
import { AlertTriangle, PauseCircle, PlayCircle, RefreshCw, Rss, Trash2 } from "lucide-react";
import type { FeedSource } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface RadarSourcesPanelProps {
  sources: FeedSource[] | null;
  draftUrl: string;
  adding: boolean;
  refreshingId: string | null;
  onDraftUrlChange: (value: string) => void;
  onAddSource: () => void;
  onRefreshSource: (id: string) => void;
  onTogglePause: (source: FeedSource) => void;
  onRemoveSource: (source: FeedSource) => void;
}

function formatSourceTime(value: number): string {
  return new Date(value).toLocaleString();
}

export const RadarSourcesPanel = memo(function RadarSourcesPanel({
  sources,
  draftUrl,
  adding,
  refreshingId,
  onDraftUrlChange,
  onAddSource,
  onRefreshSource,
  onTogglePause,
  onRemoveSource,
}: RadarSourcesPanelProps) {
  const { intl } = useZCodeIntl();

  return (
    <>
      <div
        className="rounded-xl border border-border bg-surface p-4"
        data-testid="playablebench-radar-add-source"
      >
        <label
          className="mb-2 block text-ui-base/relaxed font-medium text-foreground"
          htmlFor="playablebench-radar-url"
        >
          {intl.formatMessage({ id: "playablebench.radar.addSourceLabel" })}
        </label>
        <div className="flex gap-2">
          <input
            id="playablebench-radar-url"
            type="url"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background p-2.5 text-ui-base/relaxed text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
            placeholder={intl.formatMessage({ id: "playablebench.radar.addSourcePlaceholder" })}
            value={draftUrl}
            onChange={(event) => onDraftUrlChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onAddSource();
              }
            }}
          />
          <Button
            type="button"
            variant="default"
            size="default"
            className="gap-2"
            onClick={onAddSource}
            disabled={adding || !draftUrl.trim()}
          >
            <Rss className="size-3.5" />
            {intl.formatMessage({ id: "playablebench.radar.addSource" })}
          </Button>
        </div>
      </div>

      <section
        aria-label={intl.formatMessage({ id: "playablebench.radar.sources" })}
        className="flex flex-col gap-2"
      >
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
                  <span className="truncate text-ui-base/relaxed text-foreground">
                    {source.name}
                  </span>
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
                              { time: formatSourceTime(source.lastSuccessAt) },
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
                    onClick={() => onRefreshSource(source.id)}
                    disabled={refreshingId === source.id}
                  >
                    <RefreshCw
                      className={refreshingId === source.id ? "size-3.5 animate-spin" : "size-3.5"}
                    />
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
                    onClick={() => onTogglePause(source)}
                  >
                    {source.paused ? (
                      <PlayCircle className="size-3.5" />
                    ) : (
                      <PauseCircle className="size-3.5" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    aria-label={intl.formatMessage({ id: "playablebench.radar.removeSource" })}
                    onClick={() => onRemoveSource(source)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
});
