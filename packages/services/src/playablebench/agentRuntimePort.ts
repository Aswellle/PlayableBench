// PlayableBench AgentRuntimePort（spec 05 §2 逻辑接口，纯类型文件）。
// 端口是工作台业务访问运行时的稳定契约：上层只依赖本文件，不触碰
// IZCodeAgentService/V4 细节；V4↔Port 映射见 docs/audit/V4-Port映射表.md（TD-06）。
// 与实现文件（agentRuntimePortAdapter.ts）分离：实现携带 zcode-agent 服务链，
// 本文件可被上层（含未来 renderer）安全引入。
import type { PbApproval, PbRun, PbRunStatus, PbToolExecution } from "@zcode/shared";

/** V4 ACK 六态直通（accepted/rejected/stale/duplicate/noop/failed），不二次发明。 */
export type AgentRuntimeCommandStatus = "accepted" | "rejected" | "stale" | "duplicate" | "noop" | "failed";

/**
 * 启动策略上下文（SR-02）：PB 新启动路径必须显式指定 mode；
 * 默认策略禁 yolo/auto（workspace 默认 yolo，端口层显式阻断）。
 */
export interface AgentRuntimePolicyContext {
  permissionMode: "plan" | "build" | "edit" | "guarded";
  workspacePath: string;
  workspaceIdentity?: string;
}

/** RunDescriptor：accepted 表示已建档/已受理，不代表执行完成（spec 05 §2）。 */
export interface AgentRunDescriptor {
  runId: string;
  sessionId?: string;
  status: PbRunStatus;
  acceptedAt: number;
}

/** CommandReceipt：同步确认"已接受/已否决"，ACK 语义原样透传。 */
export interface AgentCommandReceipt {
  runId: string;
  commandId?: string;
  status: AgentRuntimeCommandStatus;
  reasonCode?: string;
}

/** RunSnapshot：持久化事实（RunRepo）+ 未决审批/未完成工具执行的聚合。 */
export interface AgentRunSnapshot {
  run: PbRun;
  pendingApprovals: PbApproval[];
  unfinishedToolExecutions: PbToolExecution[];
  /** 已持久化事件的最大 sequence（订阅补发 cursor，spec 05 §6）。 */
  eventsCursor: number;
}

/** ToolDescriptor（spec 05 §4）：风险等级与能力由产品策略侧声明，模型不可改。 */
export type AgentToolRiskLevel = "low" | "medium" | "high" | "critical";

export type AgentToolCapability =
  | "read_local"
  | "write_local"
  | "delete_local"
  | "execute_process"
  | "network_read"
  | "network_write"
  | "send_external"
  | "credential_use";

export interface AgentToolDescriptor {
  toolId: string;
  version?: string;
  displayName?: string;
  description?: string;
  capabilities: AgentToolCapability[];
  riskLevel: AgentToolRiskLevel;
  /** 高风险行为必须审批（spec 05 §5）；策略测试全量枚举断言（spec 16 门禁）。 */
  requiresApproval: boolean;
}

export interface RuntimeHealth {
  healthy: boolean;
  detail?: string;
}

export interface IAgentRuntimePort {
  /**
   * 建档并创建运行时会话：同步返回 RunDescriptor（status=queued/planning）。
   * 运行时会话创建失败时 run 落 failed 并抛出（不把"已发出"当成功）。
   */
  createRun(
    input: { goal: string; templateId?: string; templateVersion?: string; inputRef?: string },
    policyContext: AgentRuntimePolicyContext,
  ): Promise<AgentRunDescriptor>;
  /** 用户输入追加；requestId 幂等（同 requestId 重试回放同 receipt）。 */
  sendInput(runId: string, message: string, requestId?: string): Promise<AgentCommandReceipt>;
  /** 持久化快照读取；不推断运行时状态（spec 10 §6 同源纪律）。 */
  getRun(runId: string): Promise<AgentRunSnapshot | null>;
  /**
   * 暂停映射 V4 pauseGoal（goal 级 CAS 命令）：需已观察到快照 revision；
   * 未观察到时返回 rejected（reasonCode=pause_requires_snapshot），不假装已暂停。
   */
  requestPause(runId: string): Promise<AgentCommandReceipt>;
  /** 恢复映射 V4 resumeGoal；同 requestPause 的快照前置条件。 */
  resume(runId: string): Promise<AgentCommandReceipt>;
  /** 取消映射 V4 stop；ACK accepted 后由事件映射收敛终态（不在命令层抢跳）。 */
  cancel(runId: string, reason?: string): Promise<AgentCommandReceipt>;
  /**
   * 审批应答映射 V4 resolveInteraction：先校验审批 digest 绑定
   * （spec 05 §3：参数或目标变化需重新审批），再转发决策。
   */
  submitApproval(approvalId: string, decision: "approved" | "denied"): Promise<AgentCommandReceipt>;
  /** 产品策略侧工具投影（spec 05 §4）；实现见 toolPolicy.ts。 */
  listAvailableTools(runId: string): Promise<AgentToolDescriptor[]>;
  health(): Promise<RuntimeHealth>;
}
