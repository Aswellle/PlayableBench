// V4 事件映射器（spec 16 Phase 3"事件映射"；docs/audit/V4-Port映射表.md 下半表）。
// 把对话快照/增量的 A-zone 事实（control.phase、pendingInteractions、toolCall 行）
// 映射为 Run 状态迁移与事件、工具执行与审批建档。单帧内逐项容错：单项失败记入
// outcome.errors，不中断帧泵（重复投递由 (run_id, event_id) 唯一约束幂等吸收）。
// 只处理已注册为 PB run 的会话（getRunBySessionId 未命中即跳过，不污染上游会话）。
import type {
  AssistantTextRow,
  ConversationDelta,
  ConversationSnapshot,
  SessionPhase,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { isRunTransitionLegal } from "@zcode/shared";
import type { PbRunStatus } from "@zcode/shared";
import { computeOperationDigest } from "#src/playablebench/approvalDigest.js";
import { getToolPolicyEntry } from "#src/playablebench/toolPolicy.js";
import type { ApprovalRepo } from "#src/session/approvalRepo.js";
import type { RunRepo } from "#src/session/runRepo.js";
import type { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";
import type { PbToolExecutionStatus } from "@zcode/shared";

/** V4 会话相位 → PB run 状态（spec 05 §3 语义映射；draft 纯内存态不落库）。 */
const PHASE_TO_RUN_STATUS: Readonly<Record<SessionPhase, PbRunStatus | null>> = {
  draft: null,
  prewarming: "running",
  running: "running",
  completedSuccess: "completed",
  completedInterrupted: "interrupted",
  error: "failed",
};

const TOOL_ROW_STATUS_TO_EXECUTION: Readonly<
  Record<ToolCallRow["status"], PbToolExecutionStatus | null>
> = {
  inputStreaming: null,
  pendingApproval: "pending",
  running: "running",
  success: "success",
  error: "failed",
  cancelled: "cancelled",
};

/** message.final 捕获的正文限长（摘要提取只取尾部结论段；防止事件表膨胀）。 */
const MESSAGE_FINAL_MAX_CHARS = 8000;

export interface RuntimeEventMapperDeps {
  runRepo: RunRepo;
  toolExecutions: ToolExecutionRepo;
  approvals: ApprovalRepo;
  /** 观察到快照 revision 后回调（适配器据此登记 pauseGoal/resumeGoal 的 CAS revision）。 */
  onSnapshotRevision?: (runId: string, sessionId: string, revision: number) => void;
}

export interface MapperOutcome {
  runId?: string;
  applied: Array<{ eventId: string; disposition: string }>;
  errors: string[];
}

function emptyOutcome(runId?: string): MapperOutcome {
  return { ...(runId ? { runId } : {}), applied: [], errors: [] };
}

export class RuntimeEventMapper {
  constructor(private readonly deps: RuntimeEventMapperDeps) {}

  private async findRun(sessionId: string): Promise<string | null> {
    const run = await this.deps.runRepo.getRunBySessionId(sessionId);
    return run?.id ?? null;
  }

  private async transition(
    runId: string,
    to: PbRunStatus,
    eventId: string,
    reason: string,
    outcome: MapperOutcome,
  ): Promise<void> {
    const run = await this.deps.runRepo.getRun(runId);
    if (!run) return;
    if (run.status === to) {
      // 帧重述当前相位（每帧都会带 control）是常态：幂等 no-op，不记错误不落库。
      return;
    }
    if (!isRunTransitionLegal(run.status, to)) {
      // 跳转非法（如 queued→completed）：记录不抛出，帧泵不能被单帧打死。
      outcome.errors.push(`illegal transition ${run.status}→${to} (${eventId})`);
      return;
    }
    const result = await this.deps.runRepo.transitionRun(runId, {
      from: run.status,
      to,
      eventId,
      reason,
      eventType: `run.status.${to}`,
    });
    outcome.applied.push({ eventId, disposition: result.disposition });
  }

  private async applyControlPhase(
    runId: string,
    phase: SessionPhase,
    eventId: string,
    outcome: MapperOutcome,
  ): Promise<void> {
    const target = PHASE_TO_RUN_STATUS[phase];
    if (!target) return;
    const run = await this.deps.runRepo.getRun(runId);
    if (!run) return;
    if (
      run.status === "waiting_approval" &&
      (target === "running" || target === "planning" || target === "verifying")
    ) {
      // waiting_approval 是 phase=running 的覆盖态：V4 在审批挂起时 phase 仍为
      // running，phase 驱动的迁移不得把覆盖态拉回运行态；离开覆盖态只有
      // 审批清空路径（applySnapshot 的 approval-cleared）与终态/异常相位。
      return;
    }
    await this.transition(runId, target, eventId, `v4 control.phase=${phase}`, outcome);
  }

  /** permission 交互 → 审批建档（幂等：interaction_id 唯一）+ waiting_approval。 */
  private async ensureApprovalForInteraction(
    runId: string,
    interaction: {
      interactionId: string;
      toolCallId?: string;
      toolName?: string;
      summary?: string;
    },
    toolRow: ToolCallRow | null,
    outcome: MapperOutcome,
  ): Promise<void> {
    const existing = await this.deps.approvals.findByInteractionId(interaction.interactionId);
    if (!existing) {
      const toolId = toolRow?.toolName ?? interaction.toolName ?? "unknown";
      const risk = getToolPolicyEntry(toolId);
      const digest = computeOperationDigest({
        toolId,
        ...(interaction.toolCallId ? { toolCallId: interaction.toolCallId } : {}),
        ...(toolRow?.input !== undefined ? { input: toolRow.input } : {}),
      });
      await this.deps.toolExecutions.create({
        runId,
        toolId,
        ...(interaction.toolCallId ? { idempotencyKey: interaction.toolCallId } : {}),
        inputDigest: digest,
        riskLevel: risk.riskLevel,
      });
      await this.deps.approvals.create({
        runId,
        interactionId: interaction.interactionId,
        operationDigest: digest,
        requestJson: JSON.stringify({
          toolId,
          summary: interaction.summary ?? "",
        }),
        riskLevel: risk.riskLevel,
        riskSummary: interaction.summary,
      });
    }
    // 覆盖态进入：按状态差执行（固定 eventId 在重放时会被去重吞掉迁移）。
    const current = await this.deps.runRepo.getRun(runId);
    if (current?.status === "waiting_approval") return;
    await this.transition(
      runId,
      "waiting_approval",
      `evt:${runId}:approval-waiting:${interaction.interactionId}`,
      "v4 permission interaction pending",
      outcome,
    );
  }

  /** 快照：revision 登记 + phase 迁移 + pendingInteractions + toolCall 行。 */
  async applySnapshot(sessionId: string, snapshot: ConversationSnapshot): Promise<MapperOutcome> {
    const runId = await this.findRun(sessionId);
    const outcome = emptyOutcome(runId ?? undefined);
    if (!runId) return outcome;
    this.deps.onSnapshotRevision?.(runId, sessionId, snapshot.revision);
    try {
      await this.applyControlPhase(
        runId,
        snapshot.control.phase,
        `evt:${runId}:phase:${snapshot.control.phase}:${snapshot.revision}`,
        outcome,
      );
    } catch (error) {
      outcome.errors.push(`phase: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rowsByIndex = new Map<number, ToolCallRow>();
    for (const row of snapshot.rows.window) {
      if (row.kind === "toolCall") rowsByIndex.set(row.rowId, row as ToolCallRow);
    }
    try {
      const pendingPermissions = snapshot.pendingInteractions.filter(
        (i) => i.kind === "permission",
      );
      for (const interaction of pendingPermissions) {
        const toolRow =
          interaction.anchorRowId !== null
            ? (rowsByIndex.get(interaction.anchorRowId) ?? null)
            : null;
        const payload = interaction.payload;
        await this.ensureApprovalForInteraction(
          runId,
          {
            interactionId: interaction.interactionId,
            toolCallId: payload.kind === "permission" ? payload.toolCallId : undefined,
            toolName: payload.kind === "permission" ? payload.toolName : undefined,
            summary: payload.kind === "permission" ? payload.summary : undefined,
          },
          toolRow,
          outcome,
        );
      }
      if (pendingPermissions.length === 0) {
        const run = await this.deps.runRepo.getRun(runId);
        if (run?.status === "waiting_approval") {
          await this.transition(
            runId,
            "running",
            `evt:${runId}:approval-cleared:${snapshot.revision}`,
            "v4 pending permission interactions cleared",
            outcome,
          );
        }
      }
    } catch (error) {
      outcome.errors.push(
        `interactions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const row of rowsByIndex.values()) {
      try {
        await this.applyToolRow(runId, row, outcome);
      } catch (error) {
        outcome.errors.push(
          `toolRow ${row.toolCallId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "assistantText") {
        try {
          await this.captureFinalMessage(runId, row as AssistantTextRow, outcome);
        } catch (error) {
          outcome.errors.push(
            `assistantText ${String(row.rowId)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return outcome;
  }

  /**
   * assistantText 行完成态捕获（限长、非流式逐 chunk）：事件确定性 eventId
   * （rowId 幂等），摘要提取从 pb_run_events 读最终回复（spec 08 §9 摘要可追溯）。
   */
  private async captureFinalMessage(
    runId: string,
    row: AssistantTextRow,
    outcome: MapperOutcome,
  ): Promise<void> {
    if (row.state !== "complete" || !row.text) return;
    const text =
      row.text.length > MESSAGE_FINAL_MAX_CHARS
        ? `${row.text.slice(0, MESSAGE_FINAL_MAX_CHARS)}…[截断]`
        : row.text;
    const eventId = `evt:${runId}:message-final:${row.rowId}`;
    const result = await this.deps.runRepo.appendRunEvent(runId, {
      eventId,
      eventType: "message.final",
      payloadJson: JSON.stringify({
        rowId: row.rowId,
        text,
        ...(row.model ? { model: row.model } : {}),
      }),
    });
    if (!result.deduplicated) {
      outcome.applied.push({ eventId, disposition: "applied" });
    }
  }

  private async applyToolRow(
    runId: string,
    row: ToolCallRow,
    outcome: MapperOutcome,
  ): Promise<void> {
    const status = TOOL_ROW_STATUS_TO_EXECUTION[row.status];
    if (!status) return;
    const existing = await this.deps.toolExecutions.findByIdempotencyKey(row.toolCallId);
    if (existing) {
      if (existing.status !== status) {
        await this.deps.toolExecutions.update(existing.id, {
          status,
          ...(status === "success" ? { sideEffectState: "confirmed" as const } : {}),
          ...(row.endedAt ? { finishedAt: row.endedAt } : {}),
          ...(row.error ? { errorSummary: `${row.error.code}: ${row.error.message}` } : {}),
        });
        outcome.applied.push({
          eventId: `evt:${runId}:tool:${row.toolCallId}:${row.status}`,
          disposition: "applied",
        });
      }
      return;
    }
    const digest = computeOperationDigest({
      toolId: row.toolName,
      toolCallId: row.toolCallId,
      ...(row.input !== undefined ? { input: row.input } : {}),
    });
    const created = await this.deps.toolExecutions.create({
      runId,
      toolId: row.toolName,
      idempotencyKey: row.toolCallId,
      inputDigest: digest,
    });
    await this.deps.toolExecutions.update(created.id, {
      status,
      ...(status === "success" ? { sideEffectState: "confirmed" as const } : {}),
      ...(row.startedAt ? { startedAt: row.startedAt } : {}),
      ...(row.endedAt ? { finishedAt: row.endedAt } : {}),
      ...(row.error ? { errorSummary: `${row.error.code}: ${row.error.message}` } : {}),
    });
    outcome.applied.push({
      eventId: `evt:${runId}:tool:${row.toolCallId}:${row.status}`,
      disposition: "applied",
    });
  }

  /** 增量帧：state.updated 的 control/pendingInteractions + toolCall 行 upsert。 */
  async applyDeltas(
    sessionId: string,
    deltas: readonly ConversationDelta[],
    options?: { frameSeq?: number },
  ): Promise<MapperOutcome> {
    const runId = await this.findRun(sessionId);
    const outcome = emptyOutcome(runId ?? undefined);
    if (!runId) return outcome;
    const frameSeq = options?.frameSeq ?? 0;
    for (const [index, delta] of deltas.entries()) {
      try {
        if (delta.op === "state.updated" && delta.patch.control) {
          await this.applyControlPhase(
            runId,
            delta.patch.control.phase,
            `evt:${runId}:phase:${delta.patch.control.phase}:d${frameSeq + index}`,
            outcome,
          );
          continue;
        }
        if (delta.op === "state.updated" && delta.patch.pendingInteractions !== undefined) {
          const pendingPermissions = delta.patch.pendingInteractions.filter(
            (i) => i.kind === "permission",
          );
          for (const interaction of pendingPermissions) {
            const payload = interaction.payload;
            await this.ensureApprovalForInteraction(
              runId,
              {
                interactionId: interaction.interactionId,
                toolCallId: payload.kind === "permission" ? payload.toolCallId : undefined,
                toolName: payload.kind === "permission" ? payload.toolName : undefined,
                summary: payload.kind === "permission" ? payload.summary : undefined,
              },
              null,
              outcome,
            );
          }
          continue;
        }
        if (
          (delta.op === "row.appended" || delta.op === "row.upserted") &&
          delta.row.kind === "toolCall"
        ) {
          await this.applyToolRow(runId, delta.row as ToolCallRow, outcome);
          continue;
        }
        if (
          (delta.op === "row.appended" || delta.op === "row.upserted") &&
          delta.row.kind === "assistantText"
        ) {
          await this.captureFinalMessage(runId, delta.row as AssistantTextRow, outcome);
        }
      } catch (error) {
        outcome.errors.push(
          `delta[${index}] ${delta.op}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return outcome;
  }
}
