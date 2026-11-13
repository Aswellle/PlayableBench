# V4 ↔ AgentRuntimePort 映射表（TD-06 应用层端口映射）

> 依据：07 裁决 §3（"阶段 3 在 packages/services 新建应用层适配器（V4↔Port 映射表），不改 runtime 内部；映射表入 docs"）+ spec 05 §2。
> 实现：`packages/services/src/playablebench/agentRuntimePort.ts`（接口）与 `agentRuntimePortAdapter.ts`（映射）；本文是映射的事实记录，行为变化必须同步本表。
> 原则：ACK 六态（accepted/rejected/stale/duplicate/noop/failed）原样透传，不二次发明；"同步确认已接受"与"确认已完成"严格区分。

## 命令映射

| Port 调用 | V4 命令 | 前置条件 | ACK 处理 | Run 状态影响 |
|---|---|---|---|---|
| `createRun(input, policy)` | `createSession`（经 `IZCodeAgentService.createSession`） | policy.permissionMode ∈ {plan,build,edit,guarded}（SR-02 禁 yolo/auto） | 会话 id 回填 `pb_runs.runtime_session_id` | queued → planning（事件 `run.status.planning`）；失败 → failed（errorCode 记录） |
| `sendInput(runId, message, requestId)` | `sendText {text, requestedDelivery:"startNow"}` | run 已绑定会话 | accepted/duplicate → 追加 `input.sent` 事件；rejected/stale/failed → receipt 原样返回 | 不抢跳（running 由事件映射收敛） |
| `requestPause(runId)` | `pauseGoal`（CAS，需 baseRevision） | 已观察到该 run 会话快照 revision | accepted → 追加 `run.pauseRequested` | 不抢跳 |
| `resume(runId)` | `resumeGoal`（CAS，需 baseRevision） | 同上 | accepted → 追加 `run.resumeRequested` | 不抢跳 |
| `cancel(runId, reason)` | `stop` | run 已绑定会话 | accepted/duplicate → 追加 `run.cancelRequested` | 不抢跳；终态由事件映射收敛 |
| `submitApproval(approvalId, decision)` | `resolveInteraction {interactionId, answer:{action}}` | 审批 pending、未过期、绑定 interactionId | accepted/noop/duplicate → 审批单向落决策 | waiting_approval → running 由事件映射收敛 |
| `listAvailableTools(runId)` | 无 V4 对应（audit 确认） | — | 产品策略侧投影（toolPolicy，S4），不冒充运行时事实 | 无 |
| `health()` | 无直接对应 | — | 适配器与仓库就绪状态；进程活性由事件映射的 restart 观察承载 | 无 |
| `getRun(runId)` | 无（读持久化事实） | — | RunRepo + pending 审批 + 未完成工具执行 + eventsCursor | 无 |

## 明确语义边界

1. **accepted ≠ 完成**：命令层 receipt 仅表示运行时受理；run 状态推进只来自事件映射对 V4 快照/增量的观察（`control.phase`、`stopState`、`pendingInteractions`），单写路径在 RunRepo。
2. **pause/resume 的局限**：V4 无通用会话暂停，`pauseGoal/resumeGoal` 是 goal 级 CAS 命令；适配器在未观察到快照 revision 时返回 rejected（`pause_requires_snapshot`），不假装已暂停。此局限登记于 PHASE-03 报告。
3. **事件去重**：所有适配器落库事件使用确定性 eventId（`evt:<runId>:<kind>:<key>`），V4 重放由 `(run_id, event_id)` 唯一约束幂等吸收。
4. **重复命令**：resolveInteraction 先到先得；适配器收到 noop/duplicate 仍落审批决策（本地权威），但不会重复转发。
5. **needs_reconciliation**：非幂等工具副作用由 ToolExecutionRepo 幂等键 + 崩溃扫描承载（spec 05 §6）；扫描发现结果不可查的执行进入该状态，禁止直接重跑。

## 事件映射（V4 → Run 事件/状态）

| V4 观察 | 映射 | 说明 |
|---|---|---|
| `control.phase: prewarming/running` | running | queued/planning → running |
| `control.phase: completedSuccess` | completed | verifying 缺省跳过（上游无独立验证相位） |
| `control.phase: completedInterrupted` | interrupted | 进程/环境中断，可否续跑未定（spec 05 §3） |
| `control.phase: error` | failed | lastError.code 进 errorCode |
| `pendingInteractions[kind=permission]` 出现 | waiting_approval + 审批建档 | digest 绑定见 S5 |
| 交互应答后 permission 交互消失 | running（waiting_approval → running） | 由快照收敛 |
| toolCall 行 pendingApproval → success/error | ToolExecutionRepo 状态推进 | 幂等键 = toolCallId |
