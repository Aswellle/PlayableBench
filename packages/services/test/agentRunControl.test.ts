// PB 运行控制与审批服务测试（PRD-07 审批 UI 数据面）：
// 列表未决审批置顶、详情审批卡（digest/风险/参数预览）、决定走端口 digest
// 校验（mismatch 拒绝）、控制命令映射端口（无快照诚实拒绝）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope, ZCodeSessionStateSnapshot } from "@zcode/shared";
import { ApprovalRepo } from "#src/session/approvalRepo.js";
import { RunRepo } from "#src/session/runRepo.js";
import { ToolExecutionRepo } from "#src/session/toolExecutionRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";
import { createAgentRuntimePort } from "#src/playablebench/agentRuntimePortAdapter.js";
import type { AgentRuntimeAgentService } from "#src/playablebench/agentRuntimePortAdapter.js";
import { createAgentRunControlService } from "#src/playablebench/agentRunControlHost.js";

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

async function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-run-control-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  const runRepo = new RunRepo(connection);
  const approvals = new ApprovalRepo(connection);
  const toolExecutions = new ToolExecutionRepo(connection);
  const sentCommands: CommandEnvelope[] = [];
  const agentService: AgentRuntimeAgentService = {
    createSession: vi.fn().mockImplementation(async () => {
      return {
        session: { sessionId: `sess-${Math.random()}` },
      } as unknown as ZCodeSessionStateSnapshot;
    }),
    sendConversationCommandV4: vi
      .fn()
      .mockImplementation(async (params: { envelope: CommandEnvelope }) => {
        sentCommands.push(params.envelope);
        return { status: "accepted", commandId: params.envelope.commandId } as CommandAck;
      }),
  };
  const port = createAgentRuntimePort({
    agentService,
    runRepo,
    toolExecutions: new ToolExecutionRepo(connection),
    approvals,
  });
  const service = createAgentRunControlService({ port, connection });
  // 预置两个 run（一个带 pending 审批）+ 一条未完成工具执行。
  const first = await port.createRun(
    { goal: "待审批研究" },
    { permissionMode: "build", workspacePath: "/tmp/ws" },
  );
  const second = await port.createRun(
    { goal: "无审批运行" },
    { permissionMode: "build", workspacePath: "/tmp/ws" },
  );
  await toolExecutions.create({ runId: first.runId, toolId: "Bash", riskLevel: "high" });
  const approval = await approvals.create({
    runId: first.runId,
    interactionId: "ia-1",
    operationDigest: "digest-xyz",
    requestJson: '{"toolId":"Bash","summary":"删除构建产物","target":"build/"}',
    riskLevel: "high",
    riskSummary: "删除构建产物",
  });
  return {
    service,
    runRepo,
    approvals,
    firstRunId: first.runId,
    secondRunId: second.runId,
    approval,
    sentCommands,
  };
}

describe("PB 运行控制与审批服务", () => {
  it("列表：未决审批行置顶；详情审批卡含 digest/风险/参数预览", async () => {
    const { service, firstRunId } = await makeService();
    const list = await service.listRuns();
    expect(list[0]?.id).toBe(firstRunId);
    expect(list[0]?.pendingApprovals).toBe(1);

    const detail = await service.getRunDetail(firstRunId);
    expect(detail?.pendingApprovals).toHaveLength(1);
    const card = detail?.pendingApprovals[0];
    expect(card?.operationDigest).toBe("digest-xyz");
    expect(card?.toolId).toBe("Bash");
    expect(card?.requestPreview).toContain("删除构建产物");
    expect(detail?.unfinishedToolExecutions).toHaveLength(1);
    expect(await service.getRunDetail("missing")).toBeNull();
  });

  it("决定走端口 digest 校验：mismatch 拒绝；一致后收敛", async () => {
    const { service, approval } = await makeService();
    const mismatch = await service.decideApproval(approval.id, "approved", "wrong-digest");
    expect(mismatch.decided).toBe(false);
    expect(mismatch.error).toBe("approval_digest_mismatch");

    const decided = await service.decideApproval(approval.id, "approved", "digest-xyz");
    expect(decided.decided).toBe(true);
    expect(decided.decision).toBe("approved");
    // 审批已收敛：再次决定返回拒绝语义。
    const again = await service.decideApproval(approval.id, "denied", "digest-xyz");
    expect(again.decided).toBe(false);
    expect(again.error).toBe("approval_already_decided");
  });

  it("事件流脱敏透出（只含时序与类型）；游标补齐", async () => {
    const { service, firstRunId, runRepo } = await makeService();
    await runRepo.appendRunEvent(firstRunId, {
      eventId: `evt:${firstRunId}:extra`,
      eventType: "message.final",
      payloadJson: JSON.stringify({ text: "机密正文", model: "m" }),
    });
    const events = await service.listRunEvents(firstRunId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    // 脱敏：不透出 payload 原文。
    expect(JSON.stringify(events)).not.toContain("机密正文");
    const tail = await service.listRunEvents(firstRunId, events[0]?.sequence);
    expect(tail.every((event) => event.sequence > (events[0]?.sequence ?? 0))).toBe(true);
  });

  it("控制命令映射端口：取消 accepted；暂停无快照诚实拒绝", async () => {
    const { service, firstRunId, sentCommands } = await makeService();
    const pause = await service.controlRun(firstRunId, "pause");
    expect(pause.status).toBe("rejected");
    expect(pause.reasonCode).toBe("pause_requires_snapshot");
    const cancel = await service.controlRun(firstRunId, "cancel");
    expect(cancel.status).toBe("accepted");
    expect(sentCommands.some((envelope) => envelope.type === "stop")).toBe(true);
  });
});
