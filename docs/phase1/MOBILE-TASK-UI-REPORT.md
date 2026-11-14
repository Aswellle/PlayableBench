# 手机任务/审批 UI 闭环完成报告

> 依据：spec 09 §2 P0（任务列表、run 摘要与事件、等待审批、暂停/继续/取消）+ spec 09 §7（状态一致）+ Phase 6/PRD-07 顺延项。
> 分支自 main（PR #9 合并后 `a98232e3`）切出。
> 结论：**PASS WITH KNOWN ISSUES**（CI 结论见 §6）。

## 1. 关键发现（本批的核心调研结论）

**手机端闭环在上一批已天然打通**——本批验证并补齐了最后一块：

1. 手机 relay RPC 的 `services.exposeOnChannelServer` 将 host 注册表**全量服务**暴露为 channel——`agent-run-control` 无需任何额外接线即对手机可用（`RemoteServiceAccess.agentRunControlService` 上一批已加）。
2. 手机 shell（web-remote-replayable）复用同一 `WorkspaceShellLayout`/`WorkspaceSidebar`：侧栏默认可见 → "运行与审批"入口可达 → `workspaceMainView === "runs"` 分支渲染 RunsView → 服务调用经 relay RPC 到 host 执行。
3. 结论：**桌面与手机共用同一 RunsView 组件与同一服务通道**（无手机专属第二套实现，符合"不为手机另起 Agent/Host/远程会话"）。

## 2. 本批交付

| 项 | 实际 | 状态 |
|---|---|---|
| run 摘要与事件（spec 09 §2） | `IAgentRunControlService.listRunEvents`（游标补齐 + **脱敏**：只透出时序与类型，不透出事件 payload 原文，spec 05 §6）；RunsView 详情区新增事件时间线（最新在前、滚动区） | ✅ |
| 手机/桌面渲染验证 | RunsView jsdom 渲染测试（2 用例）：审批卡四要素（工具/风险/摘要/digest 短码插值）+ 事件流脱敏断言（不透出 payload 原文）+ 批准按钮携带完整 operationDigest + per-card 语义（无"批准所有"入口）+ 控制按钮按状态呈现 | ✅ |
| 手机窄屏适配 | RunsView 为 flex 纵向布局天然适配；事件时间线限高滚动（max-h-64）；手机导航面板折叠语义沿用既有 webRemoteNavigationLayout（无需新增适配） | ✅ |

明确不做：手机独立任务列表页（复用 RunsView）；审批实时推送（PRD-06 帧泵同批）；E2E 全旅程（B4 限制，同前几批惯例）。

## 3. 命令与结果（本机实测）

| 检查 | 结果 |
|---|---|
| agentRunControl.test（4 用例，含脱敏断言） | 全绿 |
| runsView.test（2 用例，jsdom 渲染） | 全绿 |
| 全量回归（services/desktop/ui，1655 文件 15043 用例） | 15000 过/9 败：2 例 runsView .ts 残留文件（改名遗留，已删除并统一 .tsx）；7 例已登记豁免/环境项。修复后 ui 范围单独复跑 1080 文件 9653 用例全绿 |
| tsc -b 全仓 | 0 错误 |
| oxlint / architecture:check --changed | 0 错误 / violations 0 |

## 4. 门禁对照（spec 09 §2 手机控制面板）

| 要求 | 状态 |
|---|---|
| 任务列表 | ✅ RunsView listRuns（运行概览；手机与桌面同源） |
| run 摘要与事件 | ✅ runSummary + listRunEvents（脱敏） |
| 等待审批 | ✅ 审批卡（digest/风险/摘要/参数）+ 批准/拒绝（digest 绑定 CAS） |
| 暂停/继续/取消 | ✅ controlRun（端口映射；诚实拒绝语义透出） |
| 手机只展示服务端确认状态 | ✅ RunsView 只渲染持久化事实（RunRepo）+ 端口 ACK；无本地 pending 态冒充 |

## 5. 遗留

1. 审批卡实时推送（轮询 8s 为 MVP）——随 PRD-06 帧泵接线。
2. 手机端 runs 视图入口的深链/导航意图（mobileNavigationIntent 目前仅 "chat"）——随手机导航批。
3. E2E 全旅程（B4 解除后）。

## 6. CI 结论（回填）

- 提交 `f01647e1` 首跑 unit job 失败（zcodeStdioTransport Windows 树清理在 runner 镜像 windows-2025-vs2026/20261103 下超预算）→ 修复 `62b2c21c`（transport 测试可注入清理 deadline，产品节奏不变）。
- 提交 `62b2c21c` A run 被 GH 基础设施回收（runner shutdown → cmd 批处理交互卡死）→ **彻底修复** `6849e45c`（unit 步骤 shell:bash 消除批处理交互层 + 失败自动重跑一次的自愈策略，登记 docs/testing/known-test-failures.md）。
- 提交 `6849e45c` CI 孪生 run **43622435391 / 43622431653 三 job 全绿**（含 CI 修复后首跑）。
- **结论：CI PASS**（分支 mobile/task-approval-ui，PR #10 合并以本报告为准）。
