# PRD07-审批 UI 批完成报告

> 依据：PRD-07（审批绑定 operation digest）+ spec 05 §3/§4（审批绑定/单向收敛）+ spec 09 §4/§7（手机审批 digest/CAS）+ Phase 6 报告 §7.3 顺延项。
> 分支自 main（PR #8 合并后 `708e5fde`）切出。
> 结论：**PASS**（CI 结论见 §6）。

## 1. 交付内容

| 项 | 实际 | 状态 |
|---|---|---|
| 审批执行面（服务） | `IAgentRunControlService`（新 ServiceChannel `agent-run-control`）：listRuns（未决审批置顶）/getRunDetail（审批卡全量）/decideApproval（经端口 submitApproval：decisionDigest 绑定校验→CAS 单次收敛→V4 resolveInteraction）/controlRun（pause/resume/cancel 端口映射）；研究服务共享同一 `pbAgentRuntimePort` 实例与 Run 域连接 | ✅ |
| 桌面审批 UI | `RunsView`（新 WorkspaceMainView "runs"，侧栏入口）：运行列表（状态徽标/未决审批数置顶）+ 审批卡（工具/风险等级/风险摘要/参数预览/操作 digest 短码）+ 批准·拒绝（digest 绑定）+ 暂停·继续·取消；8s 轮询 + 操作后即时刷新 | ✅ |
| 手机审批执行面 | main→host 消息桥：`HostMessageTypes.RemoteApprovalCommand` → host 服务注册表 `IAgentRunControlService` → `HostResponseTypes.RemoteApprovalCommandResult` → manager 按 requestId 回手机（approval-decision-response / run-control-response）；manager 执行类 case 从 unsupported 改真处理；desktopHostProcess pump 转发 | ✅ |
| 数据层（Phase 6 已就绪） | ApprovalRepo.decideOnce CAS + operationDigest 绑定 + 过期收敛 | ✅ 复用 |

单一决策路径保证：桌面与手机的审批决定都收敛到同一服务（digest 校验语义一致，第二方决定得到 already_decided/digest_mismatch 显式拒绝）。

## 2. 测试

- `agentRunControl.test.ts`（3）：列表置顶/审批卡字段/digest mismatch 拒绝/重复决定拒绝/控制命令映射（无快照诚实拒绝）。
- 既有回归：remoteDeviceGate/agentRuntimePort/managerExternalRelay(+2)/desktopWebRemoteControlIpc 全绿。
- 全量回归（services+desktop+shared+ui+client）：见 §4。

## 3. 变更文件摘要（提交链）

- `agentRunControl.ts`（descriptor）+ `agentRunControlHost.ts`（实现）+ node.ts 注册（port 提取共享）。
- accessor/index/client（remoteServiceAccess）三处接线。
- `RunsView.tsx`（新）+ WorkspaceSidebar（runs 入口）+ WorkspaceShellLayout（view 分支/back 导航/chatContent 容器）+ types.ts（"runs"）+ i18n 双语。
- shared channels/validation（RemoteApprovalCommand 收发 schema）+ host/index.ts（消息分支）+ desktopHostProcess（pump 分支）+ webRemoteControlManager（deliver 依赖 + pending 映射 + handleRemoteApprovalCommandResult）+ desktop main（deliver 注入 + 结果转发）。

## 4. 命令与结果（本机实测）

| 检查 | 结果 |
|---|---|
| 全量回归（unit project：services/desktop/shared/ui/client，1800 文件 16791 用例） | 16748 过/8 败：7 例已登记豁免/环境项（NSIS/盘符代理/代码页/POSIX×3）+ 1 例 rootUpdateReadyOverlay 并发 flake（单文件复跑 7/7 全绿，与本批改动无关域） |
| tsc -b 全仓 | 0 错误 |
| oxlint（逐提交改动文件） | 0 错误 |
| `architecture:check --changed` | OK，violations 0 |

## 5. 门禁对照（PRD-07/spec 05 §3）

| 要求 | 状态 |
|---|---|
| 高风险批准展示摘要 digest/目标/参数/风险 | ✅ 审批卡四要素齐备（digest 短码 + 完整 operationDigest 参与决定） |
| 手机只批准特定 digest，不能"批准所有后续" | ✅ decisionDigest 必须与 operationDigest 一致（mismatch 拒绝），无全局批准语义 |
| 并发决定只能有一个成功（spec 09 §7） | ✅ decideOnce CAS（Phase 6）经端口收敛，第二方显式 already_decided |
| 审批过期 | ✅ expireDue 收敛 + decideOnce 在 expired 上失败（approvalConcurrency 测试） |

## 6. CI 结论（回填）

- 提交 `018d6991` CI 孪生 run **43596827053 / 43596798636 三 job 全绿**（首跑即绿，无修复轮次）。
- **结论：CI PASS**（分支 prd07/approval-interface，PR #9 合并以本报告为准）。

## 7. 遗留

1. **手机侧审批卡 UI**（packages/web 消费 approval-decision-request 协议）：协议/执行面已就绪；随移动端交互稳定批。
2. **审批卡位置校准**：桌面 RunsView 轮询为 MVP；后续接入 V4 事件流实时推送（PRD-06 帧泵接线同批）。
3. **E2E**：研究运行→审批卡→批准→run 收敛全旅程 E2E 待 B4 解除后补。
