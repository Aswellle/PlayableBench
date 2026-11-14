// 手机任务面（只读）测试（spec 09 §2 P0）：任务列表/run 摘要（含 pending
// 审批）/事件读取。追加指令由 replayable 链路覆盖；审批决定/控制命令的
// host 执行面随审批 UI 批次（不做第二条命令写入路径）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { RemoteTaskFacade } from "#src/playablebench/remoteTaskFacade.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows 句柄释放延迟交给系统清理。
      }
    }
  }
});

async function makeFacade() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-remote-task-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  const runRepo = new RunRepo(connection);
  const approvals = new ApprovalRepo(connection);
  const facade = new RemoteTaskFacade({ connection });
  const run = await runRepo.createRun({ goal: "研究测试文章", templateId: "research_article" });
  await runRepo.setRuntimeSession(run.id, "sess-1");
  await runRepo.transitionRun(run.id, {
    from: "queued",
    to: "planning",
    eventId: `evt:${run.id}:t-planning`,
    reason: "test",
  });
  await runRepo.appendRunEvent(run.id, {
    eventId: `evt:${run.id}:progress`,
    eventType: "run.status.planning",
  });
  const approval = await approvals.create({
    runId: run.id,
    interactionId: "ia-1",
    operationDigest: "digest-abc",
    requestJson: '{"toolId":"Bash"}',
    riskLevel: "high",
    riskSummary: "运行删除脚本",
  });
  return { facade, runId: run.id, approvals, approval };
}

describe("手机任务面", () => {
  it("任务列表/run 摘要（含 pending 审批）/事件读取", async () => {
    const { facade, runId } = await makeFacade();
    const list = await facade.taskList();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("planning");

    const summary = await facade.runSummary(runId);
    expect(summary?.run.id).toBe(runId);
    expect(summary?.pendingApprovals).toHaveLength(1);
    expect(summary?.pendingApprovals[0]?.riskSummary).toBe("运行删除脚本");

    await facade.runEvents(runId);
    const events = await facade.runEvents(runId);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("事件游标补齐（afterSequence）", async () => {
    const { facade, runId } = await makeFacade();
    const all = await facade.runEvents(runId);
    expect(all.length).toBeGreaterThanOrEqual(1);
    const tail = await facade.runEvents(runId, all[0]?.sequence);
    expect(tail.every((event) => event.sequence > (all[0]?.sequence ?? 0))).toBe(true);
  });
});
