// 并发审批 CAS 测试（spec 09 §7、spec 16 门禁）：手机与桌面审批同一
// approval id，并发决定只能有一个成功；第二方得到冲突信号而非静默改写。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

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

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-approval-cas-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  return new ApprovalRepo(connection);
}

describe("并发审批 compare-and-set", () => {
  it("同一审批两方决定：只有一方成功；第二方得到冲突信号", async () => {
    const repo = makeRepo();
    const approval = await repo.create({
      runId: "run-1",
      interactionId: "ia-1",
      operationDigest: "digest-1",
      requestJson: '{"toolId":"Bash"}',
      riskLevel: "high",
    });

    const desktop = await repo.decideOnce(approval.id, "approved", { decidedBy: "desktop" });
    expect(desktop.decided).toBe(true);
    expect(desktop.approval?.decision).toBe("approved");

    // 手机并发决定同一 id：抢占失败（decision 已非 pending），不改写结果。
    const mobile = await repo.decideOnce(approval.id, "denied", { decidedBy: "mobile" });
    expect(mobile.decided).toBe(false);
    expect(mobile.approval?.decision).toBe("approved");
    expect(mobile.approval?.decidedBy).toBe("desktop");
  });

  it("手机先拒绝成功后，桌面决定同样被拒绝", async () => {
    const repo = makeRepo();
    const approval = await repo.create({
      runId: "run-2",
      interactionId: "ia-2",
      operationDigest: "digest-2",
      requestJson: '{"toolId":"Bash"}',
    });
    const mobile = await repo.decideOnce(approval.id, "denied", { decidedBy: "mobile" });
    expect(mobile.decided).toBe(true);
    const desktop = await repo.decideOnce(approval.id, "approved", { decidedBy: "desktop" });
    expect(desktop.decided).toBe(false);
    expect(desktop.approval?.decision).toBe("denied");
  });

  it("过期后决定失败（与并发互斥共用 pending 前置）", async () => {
    const repo = makeRepo();
    const approval = await repo.create({
      runId: "run-3",
      interactionId: "ia-3",
      operationDigest: "digest-3",
      requestJson: "{}",
      expiresAt: Date.now() - 1_000,
    });
    await repo.expireDue();
    const late = await repo.decideOnce(approval.id, "approved", { decidedBy: "desktop" });
    expect(late.decided).toBe(false);
    expect(late.approval?.decision).toBe("expired");
  });
});
