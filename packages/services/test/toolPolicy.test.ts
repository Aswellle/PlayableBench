// 工具策略投影测试（spec 05 §4/§5、spec 16 Phase 3 门禁"所有高风险工具有策略测试"）。
// 全量枚举断言注册表分类不变量 + 未收录工具保守默认 + 端口投影出口。
import { describe, expect, it } from "vitest";
import { getToolPolicyEntry, listToolDescriptors, TOOL_POLICY_REGISTRY, UNKNOWN_TOOL_POLICY } from "#src/playablebench/toolPolicy.js";

const HIGH_RISK_CAPABILITIES = ["delete_local", "send_external", "credential_use", "execute_process"] as const;

describe("工具策略注册表不变量", () => {
  it("携带高风险能力的工具必须 requiresApproval 且风险 high/critical", () => {
    for (const entry of Object.values(TOOL_POLICY_REGISTRY)) {
      const carries = entry.capabilities.some((c) =>
        (HIGH_RISK_CAPABILITIES as readonly string[]).includes(c),
      );
      if (carries) {
        expect(
          entry.requiresApproval,
          `${entry.toolId} 携带高风险能力但未要求审批`,
        ).toBe(true);
        expect(
          ["high", "critical"].includes(entry.riskLevel),
          `${entry.toolId} 携带高风险能力但风险等级为 ${entry.riskLevel}`,
        ).toBe(true);
      }
    }
  });

  it("requiresApproval=false 的工具不得携带高风险能力", () => {
    for (const entry of Object.values(TOOL_POLICY_REGISTRY)) {
      if (!entry.requiresApproval) {
        const offending = entry.capabilities.filter((c) =>
          (HIGH_RISK_CAPABILITIES as readonly string[]).includes(c),
        );
        expect(offending, `${entry.toolId} 免审批却携带 ${offending}`).toEqual([]);
      }
    }
  });

  it("spec 05 §5 高风险清单全部落册且必须审批", () => {
    // 运行任意命令 / 任意代码执行 / 发送消息 / 删除类。
    for (const toolId of ["Bash", "js", "SendMessage", "ReplyToChannel", "CronDelete"]) {
      const entry = TOOL_POLICY_REGISTRY[toolId];
      expect(entry, `${toolId} 缺少策略登记`).toBeDefined();
      expect(entry?.requiresApproval).toBe(true);
    }
  });

  it("未收录工具按保守默认处理（不允许登记遗漏变静默放行）", () => {
    const unknown = getToolPolicyEntry("SomeUnregisteredTool");
    expect(unknown.riskLevel).toBe("high");
    expect(unknown.requiresApproval).toBe(true);
    expect(unknown.rationale).toBe(UNKNOWN_TOOL_POLICY.rationale);
  });

  it("端口 listAvailableTools 投影与注册表一致", async () => {
    // 直接对投影函数断言；适配器接线在 agentRuntimePort.test.ts 覆盖。
    const descriptors = listToolDescriptors();
    expect(descriptors.length).toBe(Object.keys(TOOL_POLICY_REGISTRY).length);
    const byId = new Map(descriptors.map((d) => [d.toolId, d]));
    for (const [toolId, entry] of Object.entries(TOOL_POLICY_REGISTRY)) {
      expect(byId.get(toolId)).toMatchObject({
        toolId,
        riskLevel: entry.riskLevel,
        requiresApproval: entry.requiresApproval,
        capabilities: [...entry.capabilities],
      });
    }
  });
});
