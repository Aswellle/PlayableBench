// 信息雷达卡片组件（spec 08 §4 契约展示 + spec 16 闭环操作面）。
// 操作：收藏/已读/原文（Phase 4 已有）+ 加入项目/转任务/交给 Agent 研究/
// 研究摘要查看（信息到工作流闭环）。memo 组件：函数 props 由父级
// useCallback 保证引用稳定；摘要展示含可追溯徽标（模型/时间/runId/引用数）。
import { memo, useState } from "react";
import { Bot, ClipboardList, FolderPlus, Heart, ScrollText } from "lucide-react";
import type { FeedItem, PbFeedSummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface RadarCardProps {
  item: FeedItem;
  sourceName: string;
  projects: Array<{ id: string; name: string }>;
  /** 卡片级忙碌态（任一闭环动作进行中）。 */
  busy: boolean;
  /** 动作反馈文本（成功/幂等提示），空串无反馈。 */
  feedback: string;
  /** 研究运行状态文本（如 running/completed），空串未启动。 */
  researchStatus: string;
  onToggleFavorite: (item: FeedItem) => void;
  onToggleRead: (item: FeedItem) => void;
  onConvertToTask: (item: FeedItem) => void;
  onStartResearch: (item: FeedItem) => void;
  onLinkProject: (item: FeedItem, projectId: string) => void;
  onLoadSummaries: (cardId: string) => Promise<PbFeedSummary[]>;
}

function formatCardTime(value: number): string {
  return new Date(value).toLocaleString();
}

export const RadarCard = memo(function RadarCard({
  item,
  sourceName,
  projects,
  busy,
  feedback,
  researchStatus,
  onToggleFavorite,
  onToggleRead,
  onConvertToTask,
  onStartResearch,
  onLinkProject,
  onLoadSummaries,
}: RadarCardProps) {
  const { intl } = useZCodeIntl();
  const [summaries, setSummaries] = useState<PbFeedSummary[] | null>(null);
  const [summariesLoading, setSummariesLoading] = useState(false);
  const hasProjects = projects.length > 0;

  const handleLoadSummaries = () => {
    if (summariesLoading) return;
    setSummariesLoading(true);
    void onLoadSummaries(item.id)
      .then((next) => setSummaries(next))
      .catch(() => setSummaries([]))
      .finally(() => setSummariesLoading(false));
  };

  const latest = summaries?.[0];

  return (
    <li className="rounded-xl border border-border bg-surface p-4" data-testid="playablebench-radar-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-ui-base/relaxed font-medium text-foreground">{item.title}</span>
          <span className="truncate text-ui-base/relaxed text-foreground-subtle">
            {sourceName}
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
            onClick={() => onToggleFavorite(item)}
          >
            <Heart className={item.favoriteAt !== undefined ? "size-3.5 fill-current" : "size-3.5"} />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="default"
            aria-pressed={item.readAt !== undefined}
            onClick={() => onToggleRead(item)}
          >
            {intl.formatMessage({ id: item.readAt !== undefined ? "playablebench.radar.read" : "playablebench.radar.unread" })}
          </Button>
          <a
            href={item.originalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-ui-base/relaxed text-foreground hover:bg-surface-hover"
          >
            {intl.formatMessage({ id: "playablebench.radar.openOriginal" })}
          </a>
        </div>
      </div>
      {item.summary ? (
        <p className="mt-2 line-clamp-3 text-ui-base/relaxed text-foreground-subtle">{item.summary}</p>
      ) : null}
      <p className="mt-2 text-ui-base/relaxed text-foreground-subtle">
        {item.publishedAt
          ? intl.formatMessage({ id: "playablebench.radar.publishedAt" }, { time: formatCardTime(item.publishedAt) })
          : ""}
        {` · `}
        {intl.formatMessage({ id: "playablebench.radar.firstSeenAt" }, { time: formatCardTime(item.firstSeenAt) })}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="default"
          className="gap-1.5"
          disabled={busy}
          onClick={() => onConvertToTask(item)}
        >
          <ClipboardList className="size-3.5" />
          {intl.formatMessage({ id: "playablebench.radar.toTask" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="default"
          className="gap-1.5"
          disabled={busy}
          onClick={() => onStartResearch(item)}
        >
          <Bot className="size-3.5" />
          {intl.formatMessage({ id: "playablebench.radar.research" })}
        </Button>
        {hasProjects ? (
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 text-ui-base/relaxed text-foreground-subtle">
            <FolderPlus className="size-3.5" />
            <span className="sr-only">{intl.formatMessage({ id: "playablebench.radar.addToProject" })}</span>
            <select
              className="bg-transparent py-1.5 text-ui-base/relaxed text-foreground outline-none"
              value=""
              disabled={busy}
              onChange={(event) => {
                if (event.target.value) onLinkProject(item, event.target.value);
              }}
            >
              <option value="">{intl.formatMessage({ id: "playablebench.radar.addToProjectPlaceholder" })}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="gap-1.5"
          disabled={summariesLoading}
          onClick={handleLoadSummaries}
        >
          <ScrollText className="size-3.5" />
          {intl.formatMessage({ id: summaries ? "playablebench.radar.summary" : "playablebench.radar.summaryLoad" })}
        </Button>
      </div>

      {feedback || researchStatus ? (
        <p className="mt-2 text-ui-base/relaxed text-foreground-subtle" role="status">
          {researchStatus ? `${researchStatus} ` : ""}
          {feedback}
        </p>
      ) : null}

      {latest ? (
        <div className="mt-3 rounded-lg border border-border/60 bg-background/50 p-3" data-testid="playablebench-radar-summary">
          <p className="text-ui-base/relaxed text-foreground">{latest.summaryText}</p>
          <p className="mt-2 text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage(
              { id: "playablebench.radar.summaryTrace" },
              { model: `${latest.model}${latest.modelVersion ? `/${latest.modelVersion}` : ""}`, time: formatCardTime(latest.createdAt) },
            )}
            {` · ${latest.runId ? `run:${latest.runId.slice(0, 8)} · ` : ""}`}
            {intl.formatMessage(
              { id: "playablebench.radar.summaryCitations" },
              { count: latest.citations.length },
            )}
          </p>
        </div>
      ) : summaries !== null && summaries.length === 0 ? (
        <p className="mt-2 text-ui-base/relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "playablebench.radar.summaryEmpty" })}
        </p>
      ) : null}
    </li>
  );
});
