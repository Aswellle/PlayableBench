// PlayableBench 工具策略投影（spec 05 §4/§5）：产品侧静态声明工具的能力、
// 风险等级与审批要求；模型不能更改本表（权限来自策略层，不来自工具输出）。
// 键为上游内置工具的真实注册名（apps/zcode-cli core tool handlers，2026-11 盘点）；
// 未收录工具按保守默认（high + 必须审批）处理，不允许静默放行。
import type {
  AgentToolCapability,
  AgentToolDescriptor,
  AgentToolRiskLevel,
} from "#src/playablebench/agentRuntimePort.js";

export interface ToolPolicyEntry {
  toolId: string;
  capabilities: AgentToolCapability[];
  riskLevel: AgentToolRiskLevel;
  requiresApproval: boolean;
  /** 高风险判定依据（spec 05 §5 条款），策略测试据此全量枚举断言。 */
  rationale: string;
}

export const TOOL_POLICY_REGISTRY: Readonly<Record<string, ToolPolicyEntry>> = {
  Read: { toolId: "Read", capabilities: ["read_local"], riskLevel: "low", requiresApproval: false, rationale: "只读本地文件" },
  Glob: { toolId: "Glob", capabilities: ["read_local"], riskLevel: "low", requiresApproval: false, rationale: "只读文件名匹配" },
  Grep: { toolId: "Grep", capabilities: ["read_local"], riskLevel: "low", requiresApproval: false, rationale: "只读内容搜索" },
  GoalRead: { toolId: "GoalRead", capabilities: ["read_local"], riskLevel: "low", requiresApproval: false, rationale: "只读目标状态" },
  TodoRead: { toolId: "TodoRead", capabilities: ["read_local"], riskLevel: "low", requiresApproval: false, rationale: "只读待办清单" },
  TodoWrite: { toolId: "TodoWrite", capabilities: ["write_local"], riskLevel: "low", requiresApproval: false, rationale: "会话内待办清单，非用户文件" },
  ReadSessionContext: { toolId: "ReadSessionContext", capabilities: ["read_local"], riskLevel: "low", requiresApproval: false, rationale: "只读会话上下文" },
  OffPeakList: { toolId: "OffPeakList", capabilities: ["read_local"], riskLevel: "low", requiresApproval: false, rationale: "只读闲时任务台账" },
  EnterPlanMode: { toolId: "EnterPlanMode", capabilities: [], riskLevel: "low", requiresApproval: false, rationale: "模式切换，无副作用" },
  ExitPlanMode: { toolId: "ExitPlanMode", capabilities: [], riskLevel: "low", requiresApproval: false, rationale: "模式切换，无副作用" },
  AskUserQuestion: { toolId: "AskUserQuestion", capabilities: [], riskLevel: "low", requiresApproval: false, rationale: "用户交互，无外发副作用" },
  Edit: { toolId: "Edit", capabilities: ["write_local"], riskLevel: "medium", requiresApproval: false, rationale: "文件写入需路径限制（上游权限模式 + 差异预览覆盖）" },
  Write: { toolId: "Write", capabilities: ["write_local"], riskLevel: "medium", requiresApproval: false, rationale: "文件写入需路径限制（上游权限模式覆盖）" },
  WebFetch: { toolId: "WebFetch", capabilities: ["network_read"], riskLevel: "medium", requiresApproval: false, rationale: "网络读取（上游含 provider 白名单与重定向处理）" },
  WebSearch: { toolId: "WebSearch", capabilities: ["network_read"], riskLevel: "low", requiresApproval: false, rationale: "网络搜索读取" },
  CronCreate: { toolId: "CronCreate", capabilities: ["write_local"], riskLevel: "medium", requiresApproval: false, rationale: "本地调度台账写入" },
  CronUpdate: { toolId: "CronUpdate", capabilities: ["write_local"], riskLevel: "medium", requiresApproval: false, rationale: "本地调度台账修改" },
  CronDelete: { toolId: "CronDelete", capabilities: ["delete_local"], riskLevel: "high", requiresApproval: true, rationale: "spec 05 §5：删除类高风险行为必须审批" },
  OffPeakCreate: { toolId: "OffPeakCreate", capabilities: ["write_local"], riskLevel: "medium", requiresApproval: false, rationale: "本地闲时任务写入" },
  Agent: { toolId: "Agent", capabilities: [], riskLevel: "medium", requiresApproval: false, rationale: "子代理编排；子工具各自经同一权限流" },
  Task: { toolId: "Task", capabilities: [], riskLevel: "medium", requiresApproval: false, rationale: "后台任务编排；子工具各自经同一权限流" },
  TaskOutput: { toolId: "TaskOutput", capabilities: ["read_local"], riskLevel: "low", requiresApproval: false, rationale: "只读后台任务输出" },
  TaskStop: { toolId: "TaskStop", capabilities: [], riskLevel: "medium", requiresApproval: false, rationale: "取消已启动任务；终态由上游任务注册表收敛" },
  RespondToCoordinator: { toolId: "RespondToCoordinator", capabilities: [], riskLevel: "low", requiresApproval: false, rationale: "内部协议回执" },
  SubmitResult: { toolId: "SubmitResult", capabilities: [], riskLevel: "low", requiresApproval: false, rationale: "内部协议回执" },
  Skill: { toolId: "Skill", capabilities: [], riskLevel: "medium", requiresApproval: false, rationale: "技能装载指令本身无副作用；技能内的工具调用各自经同一权限流" },
  // spec 05 §5 明示高风险清单：运行任意命令 / 任意代码执行 / 发送消息 / 删除。
  Bash: {
    toolId: "Bash",
    capabilities: ["execute_process", "write_local", "read_local"],
    riskLevel: "high",
    requiresApproval: true,
    rationale: "spec 05 §5：运行任意命令必须审批；只读 bash 由上游分类器放行，本投影表达策略裁决要求",
  },
  js: {
    toolId: "js",
    capabilities: ["execute_process", "write_local", "read_local"],
    riskLevel: "high",
    requiresApproval: true,
    rationale: "spec 05 §5：任意代码执行必须审批",
  },
  SendMessage: {
    toolId: "SendMessage",
    capabilities: ["send_external"],
    riskLevel: "high",
    requiresApproval: true,
    rationale: "spec 05 §5：发送消息必须审批",
  },
  ReplyToChannel: {
    toolId: "ReplyToChannel",
    capabilities: ["send_external"],
    riskLevel: "high",
    requiresApproval: true,
    rationale: "spec 05 §5：向频道发送内容必须审批",
  },
};

/** 未收录工具的保守默认：不因登记遗漏而静默放行（spec 05 §5 精神）。 */
export const UNKNOWN_TOOL_POLICY: ToolPolicyEntry = {
  toolId: "*unknown*",
  capabilities: [],
  riskLevel: "high",
  requiresApproval: true,
  rationale: "未收录工具按保守默认：必须审批，不允许静默放行",
};

const HIGH_RISK_CAPABILITIES: readonly AgentToolCapability[] = [
  "delete_local",
  "send_external",
  "credential_use",
  "execute_process",
];

export function getToolPolicyEntry(toolId: string): ToolPolicyEntry {
  return TOOL_POLICY_REGISTRY[toolId] ?? { ...UNKNOWN_TOOL_POLICY, toolId };
}

function toDescriptor(entry: ToolPolicyEntry): AgentToolDescriptor {
  return {
    toolId: entry.toolId,
    capabilities: [...entry.capabilities],
    riskLevel: entry.riskLevel,
    requiresApproval: entry.requiresApproval,
  };
}

/** 产品侧工具投影（spec 05 §4）：listAvailableTools 的数据源。 */
export function listToolDescriptors(): AgentToolDescriptor[] {
  return Object.values(TOOL_POLICY_REGISTRY)
    .map(toDescriptor)
    .sort((a, b) => a.toolId.localeCompare(b.toolId));
}
