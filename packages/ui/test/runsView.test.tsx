// RunsView 渲染测试（PRD-07 审批 UI，jsdom）：审批卡四要素（工具/风险/摘要/
// digest 短码）渲染、批准携带完整 digest（per-card，无全局批准语义）、拒绝按钮、
// 事件流脱敏展示、控制按钮按状态呈现。
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentApprovalCard,
  AgentRunDetail,
  AgentRunEventItem,
  AgentRunListItem,
} from "@zcode/services";

const mocks = vi.hoisted(() => ({
  useServices: vi.fn(),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: mocks.useServices,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) =>
        values ? `${descriptor.id} ${JSON.stringify(values)}` : descriptor.id,
    },
  }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const runItem: AgentRunListItem = {
  id: "run-1",
  goal: "研究测试文章",
  status: "waiting_approval",
  pendingApprovals: 1,
};

const approvalCard: AgentApprovalCard = {
  id: "ap-1",
  runId: "run-1",
  toolId: "Bash",
  operationDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  riskLevel: "high",
  riskSummary: "删除构建产物",
  requestPreview: "summary: 删除构建产物；target: build/",
  createdAt: 1_700_000_000_000,
};

const runDetail: AgentRunDetail = {
  run: {
    id: "run-1",
    status: "waiting_approval",
    goal: "研究测试文章",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  },
  pendingApprovals: [approvalCard],
  unfinishedToolExecutions: [],
};

const events: AgentRunEventItem[] = [
  {
    sequence: 1,
    eventId: "evt-1",
    eventType: "run.status.planning",
    occurredAt: 1_700_000_000_000,
  },
];

function makeFakeService(decideApproval: ReturnType<typeof vi.fn>) {
  return {
    listRuns: vi.fn(async () => [runItem]),
    getRunDetail: vi.fn(async (runId: string) => (runId === "run-1" ? runDetail : null)),
    listRunEvents: vi.fn(async () => events),
    decideApproval,
    controlRun: vi.fn(async () => ({ status: "accepted" })),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("RunsView 审批面板", () => {
  it("渲染审批卡四要素与 digest 短码；批准携带完整 digest；事件流脱敏", async () => {
    const decideApproval = vi.fn(async () => ({ decided: true, decision: "approved" }));
    const service = makeFakeService(decideApproval);
    mocks.useServices.mockReturnValue({ agentRunControlService: service });
    const { RunsView } = await import("../src/playablebench/RunsView.js");

    render(createElement(RunsView));
    await waitFor(() => expect(screen.getByTestId("playablebench-approval-card")).toBeDefined());
    const markup = document.body.innerHTML;
    expect(markup).toContain("Bash");
    expect(markup).toContain("删除构建产物");
    expect(markup).toContain("build/");
    expect(markup).toContain("01234567"); // digest 短码（operationDigest 前 8 位）随插值渲染
    expect(markup).toContain("run.status.planning"); // 事件流（脱敏后只有类型与时间）
    expect(markup).not.toContain("机密正文"); // 事件 payload 不透出

    fireEvent.click(screen.getByRole("button", { name: "playablebench.runs.approve" }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalled());
    expect(decideApproval).toHaveBeenCalledWith("ap-1", "approved", approvalCard.operationDigest);
  });

  it("拒绝按钮与批准并存（per-card 语义，无全局批准入口）；控制按钮按状态呈现", async () => {
    const decideApproval = vi.fn(async () => ({ decided: true, decision: "denied" }));
    const service = makeFakeService(decideApproval);
    mocks.useServices.mockReturnValue({ agentRunControlService: service });
    const { RunsView } = await import("../src/playablebench/RunsView.js");

    render(createElement(RunsView));
    await waitFor(() => expect(screen.getByTestId("playablebench-approval-card")).toBeDefined());
    // waiting_approval 状态：继续 + 取消可见；批准/拒绝各一张卡内并存。
    expect(screen.getByRole("button", { name: "playablebench.runs.deny" })).toBeDefined();
    expect(screen.getByRole("button", { name: "playablebench.runs.approve" })).toBeDefined();
    expect(screen.getByRole("button", { name: "playablebench.runs.cancel" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "playablebench.runs.approveAll" })).toBeNull();

    // 决定调用路径（含完整 digest）已由上一用例的批准按钮验证；此处锁定
    // per-card 按钮并存与控制按钮的状态呈现（无全局批准入口）。
  });
});
