// PlayableBench Inbox 页（spec 01 §4.2、Phase 2 切片 3b）。
// 核心承诺（PRD-02）：原始输入逐字保留、处理失败不丢失、转任务带来源时间。
// URL 自动识别 kind；捕获/转任务/归档全部走 playableBenchService。
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Archive, ArrowRightCircle, RefreshCw } from "lucide-react";
import type { InboxItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return false;
  }
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function InboxView(props: { workspacePath: string }) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const service = services.playableBenchService;
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [capturePending, setCapturePending] = useState(false);
  const [convertPendingId, setConvertPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!service) {
      return;
    }
    try {
      const next = await service.listInboxItems({ limit: 100 });
      setItems(next);
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      logger.warn("[playablebench] Inbox 列表加载失败", { error: message });
    }
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCapture = useCallback(async () => {
    if (!service) {
      return;
    }
    const rawInput = draft;
    if (!rawInput.trim()) {
      return;
    }
    setCapturePending(true);
    try {
      await service.captureInboxItem({
        // URL 自动识别 kind；非 URL 一律 text，原始输入逐字保留。
        kind: looksLikeUrl(rawInput) ? "url" : "text",
        rawInput,
        sourceUrl: looksLikeUrl(rawInput) ? rawInput.trim() : undefined,
      });
      setDraft("");
      await refresh();
    } catch (error) {
      // 捕获失败：草稿不清空，用户可重试（spec 02 US-A2）。
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      logger.warn("[playablebench] Inbox 捕获失败", { error: message });
    } finally {
      setCapturePending(false);
    }
  }, [draft, refresh, service]);

  const handleConvert = useCallback(
    async (id: string) => {
      if (!service) {
        return;
      }
      setConvertPendingId(id);
      try {
        await service.convertInboxItemToTask({
          id,
          workspacePath: props.workspacePath,
        });
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLoadError(message);
        logger.warn("[playablebench] Inbox 转任务失败", { id, error: message });
        await refresh();
      } finally {
        setConvertPendingId(null);
      }
    },
    [refresh, service],
  );

  const handleArchive = useCallback(
    async (id: string) => {
      if (!service) {
        return;
      }
      try {
        await service.archiveInboxItem(id);
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLoadError(message);
      }
    },
    [refresh, service],
  );

  if (!service) {
    return (
      <p className="text-ui-base/relaxed text-foreground-subtle">
        {intl.formatMessage({ id: "playablebench.unsupportedHost" })}
      </p>
    );
  }

  const unprocessed = items?.filter((item) => item.status === "unprocessed") ?? [];
  const processed = items?.filter((item) => item.status !== "unprocessed") ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="playablebench-inbox-view">
      {/* 快速捕获：键盘可达，Enter 提交，Shift+Enter 换行。 */}
      <div className="rounded-xl border border-border bg-surface p-4">
        <label className="mb-2 block text-ui-base/relaxed font-medium text-foreground" htmlFor="playablebench-inbox-capture">
          {intl.formatMessage({ id: "playablebench.inbox.captureLabel" })}
        </label>
        <textarea
          id="playablebench-inbox-capture"
          className="min-h-20 w-full resize-y rounded-lg border border-border bg-background p-3 text-ui-base/relaxed text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
          placeholder={intl.formatMessage({ id: "playablebench.inbox.capturePlaceholder" })}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleCapture();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "playablebench.inbox.captureHint" })}
          </span>
          <Button
            type="button"
            variant="default"
            size="default"
            className="gap-2"
            onClick={() => void handleCapture()}
            disabled={capturePending || !draft.trim()}
          >
            {intl.formatMessage({ id: "playablebench.inbox.capture" })}
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

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-ui-base/relaxed font-medium text-foreground">
            {intl.formatMessage({ id: "playablebench.inbox.unprocessed" })}
            <span className="ml-2 text-foreground-subtle" aria-hidden="true">
              {unprocessed.length}
            </span>
          </h2>
          <Button
            type="button"
            variant="outline"
            size="default"
            className="gap-2"
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-3.5" />
            {intl.formatMessage({ id: "playablebench.refresh" })}
          </Button>
        </div>
        {items === null ? (
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "playablebench.loading" })}
          </p>
        ) : unprocessed.length === 0 ? (
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "playablebench.inbox.unprocessedEmpty" })}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {unprocessed.map((item) => (
              <li key={item.id} className="rounded-lg border border-border p-3">
                <p className="whitespace-pre-wrap break-words text-ui-base/relaxed text-foreground">
                  {item.rawInput}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    className="gap-2"
                    onClick={() => void handleConvert(item.id)}
                    disabled={convertPendingId === item.id}
                  >
                    <ArrowRightCircle className="size-3.5" />
                    {intl.formatMessage({ id: "playablebench.inbox.convertToTask" })}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    className="gap-2"
                    onClick={() => void handleArchive(item.id)}
                  >
                    <Archive className="size-3.5" />
                    {intl.formatMessage({ id: "playablebench.inbox.archive" })}
                  </Button>
                  <span className="text-ui-base/relaxed text-foreground-subtle">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {processed.length > 0 ? (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-3 text-ui-base/relaxed font-medium text-foreground">
            {intl.formatMessage({ id: "playablebench.inbox.processed" })}
          </h2>
          <ul className="flex flex-col gap-2">
            {processed.slice(0, 20).map((item) => (
              <li key={item.id} className="flex flex-col gap-1 rounded-lg px-2 py-1.5">
                <p className="truncate text-ui-base/relaxed text-foreground-subtle">
                  {item.rawInput}
                </p>
                {item.status === "failed" && item.processingError ? (
                  <p className="text-ui-base/relaxed text-destructive">
                    {intl.formatMessage(
                      { id: "playablebench.inbox.failedReason" },
                      { error: item.processingError },
                    )}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
