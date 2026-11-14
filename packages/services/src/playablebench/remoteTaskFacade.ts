// 手机任务面（spec 09 §2 P0）：任务列表/run 摘要与事件——纯只读，desktop
// main 直读 tasks-index（与 Run 域共享同一库文件）。追加指令由既有
// web-remote-replayable 链路覆盖（手机输入→sendText）；审批决定与暂停/取消
// 需要 host 侧执行面（IAgentRuntimePort 在 host 进程），随审批 UI 批次接入，
// 不在本层制造第二条命令写入路径。
import type { PbApproval, PbRunEvent, PbRunStatus } from "@zcode/shared";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

export interface RemoteTaskReaderOptions {
  connection?: RunStoreConnection;
  dbPath?: string;
}

export interface RemoteTaskListItem {
  id: string;
  title: string;
  status: PbRunStatus;
  templateId?: string;
  workspaceKey?: string;
  startedAt?: number;
  finishedAt?: number;
  errorCode?: string;
}

export class RemoteTaskFacade {
  private readonly runRepo: RunRepo;
  private readonly approvals: ApprovalRepo;

  constructor(options: RemoteTaskReaderOptions) {
    const connection = options.connection ?? new RunStoreConnection(options.dbPath);
    this.runRepo = new RunRepo(connection);
    this.approvals = new ApprovalRepo(connection);
  }

  /** 任务列表：pb_runs 最近运行（手机是控制面板，不重复桌面任务索引全量）。 */
  async taskList(limit?: number): Promise<RemoteTaskListItem[]> {
    const runs = await this.runRepo.listRuns({ limit: Math.min(limit ?? 50, 200) });
    return runs.map((run) => ({
      id: run.id,
      title: run.goal.slice(0, 120),
      status: run.status,
      ...(run.templateId ? { templateId: run.templateId } : {}),
      ...(run.workspaceKey ? { workspaceKey: run.workspaceKey } : {}),
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    }));
  }

  async runSummary(runId: string): Promise<{
    run: Awaited<ReturnType<RunRepo["getRun"]>>;
    pendingApprovals: Array<Pick<PbApproval, "id" | "riskLevel" | "riskSummary" | "createdAt">>;
  } | null> {
    const run = await this.runRepo.getRun(runId);
    if (!run) return null;
    const pending = await this.approvals.list(runId, { decision: "pending" });
    return {
      run,
      pendingApprovals: pending.map((approval) => ({
        id: approval.id,
        riskLevel: approval.riskLevel,
        riskSummary: approval.riskSummary,
        createdAt: approval.createdAt,
      })),
    };
  }

  async runEvents(runId: string, afterSequence?: number, limit?: number): Promise<PbRunEvent[]> {
    const events = await this.runRepo.listRunEvents(runId, { limit: Math.min(limit ?? 100, 500) });
    if (afterSequence === undefined) return events;
    return events.filter((event) => event.sequence > afterSequence);
  }
}
