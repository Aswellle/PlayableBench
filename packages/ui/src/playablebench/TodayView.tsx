// PlayableBench Today 聚合页（spec 01 §4.1、Phase 2 切片 3b）。
// 数据全部来自 playableBenchService.getTodaySummary()（tasks-index 持久化事实），
// 不推断运行时状态；loading/empty/error/unsupported 十态齐备（spec 10 §6）。
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, Inbox as InboxIcon, RefreshCw, Zap } from "lucide-react";
import type { TodaySummary } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

function formatDue(value: number, timezoneOffsetMinutes: number): string {
  const shifted = new Date(value - timezoneOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 16).replace("T", " ");
}

function SectionBlock(props: {
  icon: React.ReactNode;
  title: string;
  entries: TodaySummary["overdueTasks"];
  emptyText: string;
  tone: "danger" | "normal" | "accent";
  timezoneOffsetMinutes: number;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-label={props.title}>
      <div className="mb-3 flex items-center gap-2">
        {props.icon}
        <h2 className="text-ui-base/relaxed font-medium text-foreground">{props.title}</h2>
        <span className="text-ui-base/relaxed text-foreground-subtle" aria-hidden="true">
          {props.entries.length}
        </span>
      </div>
      {props.entries.length === 0 ? (
        <p className="text-ui-base/relaxed text-foreground-subtle">{props.emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {props.entries.map((entry) => (
            <li
              key={`${entry.workspacePath}:${entry.workspaceIdentity ?? ""}:${entry.taskId}`}
              className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
            >
              <span
                className={
                  props.tone === "danger"
                    ? "text-ui-base/relaxed text-destructive"
                    : "text-ui-base/relaxed text-foreground"
                }
              >
                {entry.title}
              </span>
              <span className="shrink-0 text-ui-base/relaxed text-foreground-subtle">
                {entry.dueAt !== undefined
                  ? formatDue(entry.dueAt, props.timezoneOffsetMinutes)
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TodayView() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const service = services.playableBenchService;
  const [summary, setSummary] = useState<TodaySummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!service) {
      return;
    }
    setLoading(true);
    try {
      const next = await service.getTodaySummary();
      setSummary(next);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      logger.warn("[playablebench] Today 聚合加载失败", { error: message });
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!service) {
    return (
      <p className="text-ui-base/relaxed text-foreground-subtle">
        {intl.formatMessage({ id: "playablebench.unsupportedHost" })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="playablebench-today-view">
      <div className="flex items-center justify-between gap-3">
        <p className="text-ui-base/relaxed text-foreground-subtle">
          {summary
            ? intl.formatMessage(
                { id: "playablebench.today.generatedAt" },
                {
                  time: new Date(summary.generatedAt).toLocaleTimeString(),
                },
              )
            : ""}
        </p>
        <Button
          type="button"
          variant="outline"
          size="default"
          className="shrink-0 gap-2 enabled:cursor-pointer"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
          {intl.formatMessage({ id: "playablebench.refresh" })}
        </Button>
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

      {summary !== null ? (
        <>
          <SectionBlock
            icon={<CalendarClock className="size-4 text-destructive" aria-hidden="true" />}
            title={intl.formatMessage({ id: "playablebench.today.overdue" })}
            entries={summary.overdueTasks}
            emptyText={intl.formatMessage({ id: "playablebench.today.overdueEmpty" })}
            tone="danger"
            timezoneOffsetMinutes={summary.timezoneOffsetMinutes}
          />
          <SectionBlock
            icon={<CalendarClock className="size-4 text-foreground" aria-hidden="true" />}
            title={intl.formatMessage({ id: "playablebench.today.dueToday" })}
            entries={summary.dueTodayTasks}
            emptyText={intl.formatMessage({ id: "playablebench.today.dueTodayEmpty" })}
            tone="normal"
            timezoneOffsetMinutes={summary.timezoneOffsetMinutes}
          />
          <SectionBlock
            icon={<Zap className="size-4 text-foreground" aria-hidden="true" />}
            title={intl.formatMessage({ id: "playablebench.today.highPriority" })}
            entries={summary.highPriorityTasks}
            emptyText={intl.formatMessage({ id: "playablebench.today.highPriorityEmpty" })}
            tone="accent"
            timezoneOffsetMinutes={summary.timezoneOffsetMinutes}
          />
          <section
            className="rounded-xl border border-border bg-surface p-4"
            aria-label={intl.formatMessage({ id: "playablebench.today.recentInbox" })}
          >
            <div className="mb-3 flex items-center gap-2">
              <InboxIcon className="size-4 text-foreground" aria-hidden="true" />
              <h2 className="text-ui-base/relaxed font-medium text-foreground">
                {intl.formatMessage({ id: "playablebench.today.recentInbox" })}
              </h2>
              <span
                className="text-ui-base/relaxed text-foreground-subtle"
                aria-hidden="true"
              >
                {summary.counts.unprocessedInbox}
              </span>
            </div>
            {summary.recentInboxItems.length === 0 ? (
              <p className="text-ui-base/relaxed text-foreground-subtle">
                {intl.formatMessage({ id: "playablebench.today.recentInboxEmpty" })}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {summary.recentInboxItems.map((item) => (
                  <li key={item.id} className="truncate rounded-lg px-2 py-1.5 hover:bg-surface-hover">
                    <span className="text-ui-base/relaxed text-foreground">
                      {item.title ?? item.rawInput}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
