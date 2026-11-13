// 审批 digest 绑定测试（spec 05 §3：waiting_approval 绑定操作 digest，
// 参数或目标变化需重新审批；spec 06 §2 Approval 操作摘要 digest）。
// 覆盖：规范化摘要稳定性/敏感性、端口 recordPendingApproval 创建侧绑定、
// 幂等键联动、参数变化 → 新 digest → 原审批不可复用。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope, ZCodeSessionStateSnapshot } from "@zcode/shared";
import { computeOperationDigest } from "#src/playablebench/approvalDigest.js";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { createAgentRuntimePort } from "#src/playablebench/agentRuntimePortAdapter.js";
import type { AgentRuntimeAgentService } from "#src/playablebench/agentRuntimePortAdapter.js";

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

function makeAgentService(): AgentRuntimeAgentService {
  return {
    createSession: vi.fn().mockImplementation(async () => {
      return { session: { sessionId: "sess-1" } } as unknown as ZCodeSessionStateSnapshot;
    }),
    sendConversationCommandV4: vi.fn().mockImplementation(async (params) => {
      return { status: "accepted", commandId: params.envelope.commandId } as CommandAck;
    }),
  };
}

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-approval-digest-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  const port = createAgentRuntimePort({
    agentService: makeAgentService(),
    runRepo: new RunRepo(connection),
    toolExecutions: new ToolExecutionRepo(connection),
    approvals: new ApprovalRepo(connection),
  });
  return port;
}

const policy = { permissionMode: "build" as const, workspacePath: "/tmp/ws-a" };

describe("computeOperationDigest", () => {
  it("键顺序不影响 digest；任一字段变化必变", () => {
    const a = computeOperationDigest({ toolId: "Bash", target: "/a.txt", input: { cmd: "rm", flags: ["-rf"] } });
    const b = computeOperationDigest({ input: { flags: ["-rf"], cmd: "rm" }, target: "/a.txt", toolId: "Bash" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const targetChanged = computeOperationDigest({ toolId: "Bash", target: "/b.txt", input: { cmd: "rm", flags: ["-rf"] } });
    expect(targetChanged).not.toBe(a);
    const inputChanged = computeOperationDigest({ toolId: "Bash", target: "/a.txt", input: { cmd: "rm", flags: ["-r"] } });
    expect(inputChanged).not.toBe(a);
    const toolChanged = computeOperationDigest({ toolId: "js", target: "/a.txt", input: { cmd: "rm", flags: ["-rf"] } });
    expect(toolChanged).not.toBe(a);
  });

  it("undefined 字段不参与摘要（可选字段缺省与显式 undefined 等价）", () => {
    const a = computeOperationDigest({ toolId: "Read", target: "/x" });
    const b = computeOperationDigest({ toolId: "Read", target: "/x", input: undefined });
    expect(a).toBe(b);
  });
});

describe("recordPendingApproval 创建侧绑定", () => {
  it("digest 落审批与工具执行双记录；toolCallId 作幂等键", async () => {
    const port = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    const approval = await port.recordPendingApproval({
      runId: descriptor.runId,
      toolId: "Bash",
      toolCallId: "tc-1",
      input: { cmd: "rm -rf build" },
      target: "D:/ws/build",
      interactionId: "ia-1",
    });
    const expected = computeOperationDigest({
      toolId: "Bash",
      toolCallId: "tc-1",
      input: { cmd: "rm -rf build" },
      target: "D:/ws/build",
    });
    expect(approval.operationDigest).toBe(expected);
    expect(approval.riskLevel).toBe("high");
    expect(approval.decision).toBe("pending");
    // 幂等键联动：同 toolCallId 再登记返回同一条工具执行。
    const replay = await port.recordPendingApproval({
      runId: descriptor.runId,
      toolId: "Bash",
      toolCallId: "tc-1",
      input: { cmd: "rm -rf build" },
      target: "D:/ws/build",
    });
    expect(replay.operationDigest).toBe(expected);
    const snapshot = await port.getRun(descriptor.runId);
    expect(snapshot?.pendingApprovals).toHaveLength(2);
  });

  it("参数变化产生新 digest：旧审批 decisionDigest 校验拒绝新操作", async () => {
    const port = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    const original = await port.recordPendingApproval({
      runId: descriptor.runId,
      toolId: "Bash",
      toolCallId: "tc-1",
      input: { cmd: "rm -rf build" },
      target: "D:/ws/build",
      interactionId: "ia-1",
    });
    // 同一 toolCallId 但入参/目标变化（运行时重发且参数被改）→ 新 digest。
    const mutated = await port.recordPendingApproval({
      runId: descriptor.runId,
      toolId: "Bash",
      toolCallId: "tc-1",
      input: { cmd: "rm -rf ." },
      target: "D:/ws/build",
      interactionId: "ia-2",
    });
    expect(mutated.operationDigest).not.toBe(original.operationDigest);
    // 用旧 digest 应答新审批 → 拒绝（参数或目标变化需重新审批）。
    const stale = await port.submitApproval(mutated.id, "approved", original.operationDigest);
    expect(stale).toMatchObject({ status: "rejected", reasonCode: "approval_digest_mismatch" });
    const fresh = await port.submitApproval(mutated.id, "approved", mutated.operationDigest);
    expect(fresh.status).toBe("accepted");
  });

  it("风险等级来自策略注册表而非调用方声明", async () => {
    const port = makeHarness();
    const descriptor = await port.createRun({ goal: "目标" }, policy);
    const approval = await port.recordPendingApproval({
      runId: descriptor.runId,
      toolId: "Read",
      target: "D:/ws/notes.txt",
    });
    expect(approval.riskLevel).toBe("low");
  });
});
