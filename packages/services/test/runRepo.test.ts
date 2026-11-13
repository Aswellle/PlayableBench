// RunRepo 状态机与持久化测试：合法迁移落库、非法迁移拒绝、重复事件去重、
// stale 观测不落库、终态收敛、幂等键防重复副作用、崩溃恢复扫描、审批过期。
// 门禁对应 spec 16 Phase 3（状态迁移持久化校验、重复事件不产生重复副作用）
// 与 spec 05 §3/§6/§9。测试强制注入临时库路径（禁止写真实用户库）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunRepo } from "#src/session/runRepo.js";
import { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

const tempDirs: string[] = [];

function makeStore(): {
  runs: RunRepo;
  tools: ToolExecutionRepo;
  approvals: ApprovalRepo;
  connection: RunStoreConnection;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "zcode-run-repo-"));
  tempDirs.push(dir);
  // 强制注入：本测试不得触碰真实 ~/.zcode/v2 库（Phase 2 事故登记在案）。
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  return {
    runs: new RunRepo(connection),
    tools: new ToolExecutionRepo(connection),
    approvals: new ApprovalRepo(connection),
    connection,
    dir,
  };
}

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

describe("RunRepo 状态机", () => {
  it("建档即 queued；合法迁移落库并生成事件", async () => {
    const { runs: repo } = makeStore();
    const run = await repo.createRun({ goal: "整理周报", permissionMode: "build" });
    expect(run.status).toBe("queued");
    expect(run.permissionMode).toBe("build");

    const first = await repo.transitionRun(run.id, {
      from: "queued",
      to: "running",
      eventId: "evt-start",
      reason: "v4 control.phase=running",
    });
    expect(first.disposition).toBe("applied");
    expect(first.run.status).toBe("running");
    expect(first.run.startedAt).toBeGreaterThan(0);
    expect(first.event?.sequence).toBe(1);

    const events = await repo.listRunEvents(run.id);
    expect(events.map((e) => e.eventId)).toEqual(["evt-start"]);
  });

  it("非法迁移抛出，不落库不改状态", async () => {
    const { runs: repo } = makeStore();
    const run = await repo.createRun({ goal: "目标" });
    await expect(
      repo.transitionRun(run.id, { from: "queued", to: "verifying", eventId: "evt-bad" }),
    ).rejects.toMatchObject({ kind: "illegal_run_transition", from: "queued", to: "verifying" });
    const unchanged = await repo.getRun(run.id);
    expect(unchanged?.status).toBe("queued");
    expect(await repo.listRunEvents(run.id)).toHaveLength(0);
  });

  it("重复 eventId 去重：同一事件重放不重复应用迁移", async () => {
    const { runs: repo } = makeStore();
    const run = await repo.createRun({ goal: "目标" });
    await repo.transitionRun(run.id, { from: "queued", to: "running", eventId: "evt-dup" });
    // V4 增量重放同一事件（同 eventId、不同 occurredAt）不产生第二次迁移。
    const replay = await repo.transitionRun(run.id, {
      from: "running",
      to: "verifying",
      eventId: "evt-dup",
    });
    expect(replay.disposition).toBe("deduplicated");
    expect(replay.run.status).toBe("running");
    expect((await repo.listRunEvents(run.id)).length).toBe(1);
  });

  it("from 与当前状态不一致按 stale 处理，不落库", async () => {
    const { runs: repo } = makeStore();
    const run = await repo.createRun({ goal: "目标" });
    await repo.transitionRun(run.id, { from: "queued", to: "running", eventId: "evt-1" });
    const stale = await repo.transitionRun(run.id, {
      from: "queued",
      to: "failed",
      eventId: "evt-2",
    });
    expect(stale.disposition).toBe("stale");
    expect(stale.run.status).toBe("running");
    expect(await repo.listRunEvents(run.id)).toHaveLength(1);
  });

  it("终态收敛：finished_at 落库且终态后拒绝再迁移", async () => {
    const { runs: repo } = makeStore();
    const run = await repo.createRun({ goal: "目标" });
    await repo.transitionRun(run.id, { from: "queued", to: "running", eventId: "evt-1" });
    await repo.transitionRun(run.id, { from: "running", to: "completed", eventId: "evt-2" });
    const finished = await repo.getRun(run.id);
    expect(finished?.status).toBe("completed");
    expect(finished?.finishedAt).toBeGreaterThan(0);

    await expect(
      repo.transitionRun(run.id, { from: "completed", to: "running", eventId: "evt-3" }),
    ).rejects.toMatchObject({ kind: "illegal_run_transition" });
  });

  it("needs_reconciliation 仅允许人工决策流向收尾", async () => {
    const { runs: repo } = makeStore();
    const run = await repo.createRun({ goal: "目标" });
    await repo.transitionRun(run.id, { from: "queued", to: "running", eventId: "evt-1" });
    await repo.transitionRun(run.id, { from: "running", to: "needs_reconciliation", eventId: "evt-2" });
    // 禁止直接重跑：needs_reconciliation → running 非法（spec 05 §3 语义）。
    await expect(
      repo.transitionRun(run.id, { from: "needs_reconciliation", to: "running", eventId: "evt-3" }),
    ).rejects.toMatchObject({ kind: "illegal_run_transition" });
    const decided = await repo.transitionRun(run.id, {
      from: "needs_reconciliation",
      to: "cancelled",
      eventId: "evt-4",
      reason: "人工决策放弃",
    });
    expect(decided.run.status).toBe("cancelled");
  });

  it("重启（重开连接）后 run 与事件保持", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-run-repo-restart-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "tasks-index.sqlite");
    const firstConnection = new RunStoreConnection(dbPath);
    const first = new RunRepo(firstConnection);
    const run = await first.createRun({ goal: "跨重启目标", workspaceKey: "ws-a" });
    await first.transitionRun(run.id, { from: "queued", to: "planning", eventId: "evt-1" });
    firstConnection.close();

    const secondConnection = new RunStoreConnection(dbPath);
    const second = new RunRepo(secondConnection);
    const reloaded = await second.getRun(run.id);
    expect(reloaded?.status).toBe("planning");
    expect((await second.listRunEvents(run.id)).map((e) => e.eventId)).toEqual(["evt-1"]);
    const byWorkspace = await second.listRuns({ workspaceKey: "ws-a" });
    expect(byWorkspace).toHaveLength(1);
    secondConnection.close();
  });
});

describe("工具执行与审批仓库", () => {
  it("幂等键重复创建返回既有记录，不产生重复副作用记录", async () => {
    const { runs, tools } = makeStore();
    const run = await runs.createRun({ goal: "目标" });
    const first = await tools.create({
      runId: run.id,
      toolId: "bash",
      idempotencyKey: "idem-1",
      riskLevel: "high",
    });
    const replay = await tools.create({
      runId: run.id,
      toolId: "bash",
      idempotencyKey: "idem-1",
    });
    expect(replay.id).toBe(first.id);
    expect((await tools.list(run.id)).length).toBe(1);
  });

  it("崩溃恢复扫描返回未完成且副作用未确认的执行", async () => {
    const { runs, tools } = makeStore();
    const run = await runs.createRun({ goal: "目标" });
    const pending = await tools.create({ runId: run.id, toolId: "bash", idempotencyKey: "k1" });
    const confirmed = await tools.create({ runId: run.id, toolId: "edit", idempotencyKey: "k2" });
    await tools.update(confirmed.id, { status: "success", sideEffectState: "confirmed" });

    const unfinished = await tools.listUnfinished(run.id);
    expect(unfinished.map((u) => u.execution.id)).toEqual([pending.id]);
    await tools.update(pending.id, {
      status: "needs_reconciliation",
      sideEffectState: "needs_reconciliation",
    });
    expect(await tools.listUnfinished(run.id)).toHaveLength(0);
  });

  it("审批决策单向收敛，过期扫描仅处理到期的 pending", async () => {
    const { runs, approvals } = makeStore();
    const run = await runs.createRun({ goal: "目标" });
    const approval = await approvals.create({
      runId: run.id,
      operationDigest: "digest-1",
      requestJson: '{"tool":"bash"}',
      riskLevel: "high",
      expiresAt: 1000,
    });
    expect(approval.decision).toBe("pending");

    const later = await approvals.create({
      runId: run.id,
      operationDigest: "digest-2",
      requestJson: '{"tool":"webfetch"}',
      expiresAt: Date.now() + 60_000,
    });
    const expiredNow = await approvals.expireDue(Date.now() + 2000);
    expect(expiredNow.map((a) => a.id)).toEqual([approval.id]);
    expect((await approvals.get(approval.id))?.decision).toBe("expired");

    const decided = await approvals.decide(later.id, "approved", { decidedBy: "desktop-main" });
    expect(decided?.decision).toBe("approved");
    // 已决策的审批不可再改（单向收敛）。
    const reDecide = await approvals.decide(later.id, "denied", { decidedBy: "desktop-main" });
    expect(reDecide?.decision).toBe("approved");

    // interaction_id 唯一：首个占用成功，重复插入被拒。
    const bound = await approvals.create({
      runId: run.id,
      interactionId: "ia-dup",
      operationDigest: "digest-3",
      requestJson: "{}",
    });
    expect(bound.interactionId).toBe("ia-dup");
    await expect(
      approvals.create({
        runId: run.id,
        interactionId: "ia-dup",
        operationDigest: "digest-4",
        requestJson: "{}",
      }),
    ).rejects.toThrow();
  });
});
