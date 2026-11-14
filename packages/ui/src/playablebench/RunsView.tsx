// PB 运行与审批面板（PRD-07 审批 UI）：运行概览（未决审批置顶）+ 详情
// （审批卡：工具/风险/摘要/参数预览/操作 digest）+ 暂停·继续·取消。
// 决定与控制走 IAgentRunControlService（单一决策路径：digest 绑定校验 +
// 审批单向收敛 + V4 resolveInteraction）；列表轮询 + 操作后即时刷新。
import { memo, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  Square,
} from "lucide-react";
import type { AgentApprovalCard, AgentRunDetail, AgentRunListItem } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

const POLL_INTERVAL_MS = 8000;

function statusTone(status: string): string {
  if (status === "waiting_approval") return "text-destructive";
  if (status === "completed") return "text-foreground-subtle";
  if (status === "failed") return "text-destructive";
  return "text-foreground";
}

export function RunsView() {
  const { intl } = useZCodeIntl();
  const service = useServices().agentRunControlService;
  const [runs, setRuns] = useState<AgentRunListItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const refreshList = useCallback(async () => {
    if (!service) return;
    try {
      const next = await service.listRuns();
      setRuns(next);
      setSelectedId((current) => current ?? next[0]?.id ?? null);
    } catch (error) {
      logger.warn("[playablebench] 运行列表加载失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [service]);

  const refreshDetail = useCallback(
    async (runId: string | null) => {
      if (!service || !runId) {
        setDetail(null);
        return;
      }
      try {
        setDetail(await service.getRunDetail(runId));
      } catch (error) {
        logger.warn("[playablebench] 运行详情加载失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [service],
  );

  useEffect(() => {
    void refreshList();
    const timer = setInterval(() => void refreshList(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshList]);

  useEffect(() => {
    void refreshDetail(selectedId);
  }, [refreshDetail, selectedId]);

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      setActing(true);
      setActionError(null);
      try {
        await action();
        await refreshList();
        await refreshDetail(selectedId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        logger.warn("[playablebench] 运行操作失败", { error: message });
      } finally {
        setActing(false);
      }
    },
    [refreshDetail, refreshList, selectedId],
  );

  const handleDecide = useCallback(
    (card: AgentApprovalCard, decision: "approved" | "denied") => {
      if (!service) return;
      void runAction(async () => {
        const outcome = await service.decideApproval(card.id, decision, card.operationDigest);
        if (!outcome.decided && outcome.error) {
          setActionError(outcome.error);
        }
      });
    },
    [runAction, service],
  );

  const handleControl = useCallback(
    (runId: string, action: "pause" | "resume" | "cancel") => {
      if (!service) return;
      void runAction(async () => {
        const outcome = await service.controlRun(runId, action);
        if (outcome.status !== "accepted" && outcome.status !== "duplicate" && outcome.reasonCode) {
          setActionError(outcome.reasonCode);
        }
      });
    },
    [runAction, service],
  );

  if (!service) {
    return (
      <p className="text-ui-base/relaxed text-foreground-subtle">
        {intl.formatMessage({ id: "playablebench.unsupportedHost" })}
      </p>
    );
  }

  const selectedRun = runs?.find((run) => run.id === selectedId) ?? null;
  const detailRun = detail?.run ?? null;
  const status = detailRun?.status ?? selectedRun?.status ?? "";

  return (
    <div className="flex flex-col gap-4" data-testid="playablebench-runs-view">
      <section
        aria-label={intl.formatMessage({ id: "playablebench.runs.list" })}
        className="flex flex-col gap-2"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-ui-base/relaxed font-medium text-foreground">
            {intl.formatMessage({ id: "playablebench.runs.list" })}
          </h2>
          <Button type="button" variant="ghost" size="default" onClick={() => void refreshList()}>
            <RefreshCw className="size-3.5" />
            {intl.formatMessage({ id: "playablebench.refresh" })}
          </Button>
        </div>
        {runs === null ? (
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "playablebench.loading" })}
          </p>
        ) : runs.length === 0 ? (
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "playablebench.runs.empty" })}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className={cnButton(run.id === selectedId)}
                  onClick={() => setSelectedId(run.id)}
                  aria-pressed={run.id === selectedId}
                >
                  <span className="min-w-0 flex-1 truncate text-left text-ui-base/relaxed text-foreground">
                    {run.goal}
                    {run.pendingApprovals > 0 ? (
                      <span className="ml-2 inline-flex items-center gap-1 text-destructive">
                        <ShieldAlert className="size-3.5" />
                        {run.pendingApprovals}
                      </span>
                    ) : null}
                  </span>
                  <span className={`shrink-0 text-ui-base/relaxed ${statusTone(run.status)}`}>
                    {run.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detailRun !== null ? (
        <section
          aria-label={intl.formatMessage({ id: "playablebench.runs.detail" })}
          className="flex flex-col gap-3"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-ui-base/relaxed font-medium text-foreground">
              {intl.formatMessage({ id: "playablebench.runs.detail" })}
              <span className={`ml-2 ${statusTone(status)}`}>{status}</span>
            </h2>
            <div className="flex gap-1.5">
              {status === "running" || status === "planning" || status === "verifying" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  disabled={acting}
                  onClick={() => void handleControl(detailRun.id, "pause")}
                >
                  <PauseCircle className="size-3.5" />
                  {intl.formatMessage({ id: "playablebench.runs.pause" })}
                </Button>
              ) : null}
              {status === "interrupted" || status === "waiting_approval" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  disabled={acting}
                  onClick={() => void handleControl(detailRun.id, "resume")}
                >
                  <PlayCircle className="size-3.5" />
                  {intl.formatMessage({ id: "playablebench.runs.resume" })}
                </Button>
              ) : null}
              {status !== "completed" && status !== "cancelled" && status !== "failed" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="default"
                  className="text-destructive hover:text-destructive"
                  disabled={acting}
                  onClick={() => void handleControl(detailRun.id, "cancel")}
                >
                  <Square className="size-3.5" />
                  {intl.formatMessage({ id: "playablebench.runs.cancel" })}
                </Button>
              ) : null}
            </div>
          </div>

          {actionError !== null ? (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-destructive"
            >
              <AlertTriangle className="size-4 shrink-0" />
              <span className="text-ui-base/relaxed">{actionError}</span>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <h3 className="text-ui-base/relaxed font-medium text-foreground">
              {intl.formatMessage({ id: "playablebench.runs.pendingApprovals" })}
            </h3>
            {detail!.pendingApprovals.length === 0 ? (
              <p className="text-ui-base/relaxed text-foreground-subtle">
                {intl.formatMessage({ id: "playablebench.runs.noPendingApprovals" })}
              </p>
            ) : (
              detail!.pendingApprovals.map((card) => (
                <ApprovalCardRow
                  key={card.id}
                  card={card}
                  acting={acting}
                  onDecide={handleDecide}
                />
              ))
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function cnButton(active: boolean): string {
  return [
    "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left",
    active ? "border-primary bg-selected" : "border-border hover:bg-surface-hover",
  ].join(" ");
}

const ApprovalCardRow = memo(function ApprovalCardRow({
  card,
  acting,
  onDecide,
}: {
  card: AgentApprovalCard;
  acting: boolean;
  onDecide: (card: AgentApprovalCard, decision: "approved" | "denied") => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3"
      data-testid="playablebench-approval-card"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-ui-base/relaxed font-medium text-foreground">
          <ShieldAlert className="size-3.5 text-destructive" />
          {card.toolId}
          {card.riskLevel ? (
            <span className="text-foreground-subtle">· {card.riskLevel}</span>
          ) : null}
        </span>
        <span className="text-ui-base/relaxed text-foreground-subtle">
          {intl.formatMessage(
            { id: "playablebench.runs.digest" },
            { digest: card.operationDigest.slice(0, 8) },
          )}
        </span>
      </div>
      {card.riskSummary ? (
        <p className="text-ui-base/relaxed text-foreground">{card.riskSummary}</p>
      ) : null}
      {card.requestPreview ? (
        <p className="break-all rounded-lg border border-border/60 bg-background/50 p-2 text-ui-base/relaxed text-foreground-subtle">
          {card.requestPreview}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="default"
          className="text-destructive enabled:cursor-pointer hover:text-destructive"
          disabled={acting}
          onClick={() => onDecide(card, "denied")}
        >
          {intl.formatMessage({ id: "playablebench.runs.deny" })}
        </Button>
        <Button
          type="button"
          variant="default"
          size="default"
          className="gap-1.5"
          disabled={acting}
          onClick={() => onDecide(card, "approved")}
        >
          <CheckCircle2 className="size-3.5" />
          {intl.formatMessage({ id: "playablebench.runs.approve" })}
        </Button>
      </div>
    </div>
  );
});
