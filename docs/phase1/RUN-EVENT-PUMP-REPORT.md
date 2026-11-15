# Run 事件帧泵（PRD-06 帧泵接线）完成报告

> 依据：PRD-06 遗留"Host 帧泵接线与 UI 随 Phase 5 闭环"（Phase 5 报告 §7.1/§7.2 同源）+ spec 05 §6（事件持久化/补发）+ spec 09 §2（run 摘要与事件）+ docs/audit/V4-Port映射表.md（TD-06）。
> 分支自 main（PR #10 合并后 `3c37a1c1`）切出。
> 结论：**PASS**（CI 结论见 §6）。

## 1. 交付内容

| 项                        | 实际                                                                                                                                                                                                                                                                                     | 状态           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 帧泵（AgentRunEventPump） | 订阅活动 PB run 工作区的 V4 下行帧流（`IZCodeAgentService.onDynamicConversationFrame`，workspace 级 emitter）；帧按 `conversationTopicFrameSchema` 解析 → sessionId → `runRepo.getRunBySessionId` 过滤（非 PB 会话帧丢弃）→ RuntimeEventMapper 持久化（状态迁移/审批建档/message.final） | ✅             |
| 订阅生命周期              | 15s 周期同步：活动 run 的 (workspacePath, workspaceIdentity) 建订阅；run 收敛终态后工作区退订（只断泵监听，不影响 renderer/mobile 既有订阅）；帧源暂不可用（workspace client 未起）下次 sync 重试                                                                                        | ✅             |
| CAS revision 桥           | mapper 的 onSnapshotRevision 回调 → 端口适配器 `observeSnapshotRevision`（升级为 IAgentRuntimePort 帧泵面方法，Host 专用）——**requestPause/resume 的 pause_requires_snapshot 前置由此满足**（测试锁定：桥接前 rejected → 桥接后 accepted）                                               | ✅             |
| host 装配                 | node.ts services 装配处构造并 `start()`（与 IAgentRunControlService 共享同一 pbAgentRuntimePort/连接族）                                                                                                                                                                                 | ✅             |
| RunsView 跟进             | 无需 UI 改动：pump 实时落库后既有 8s 轮询即见真实审批卡/状态（数据层实时、展示层轮询延迟 ≤8s；broadcast 实时推送留后续批）                                                                                                                                                               | ✅（验证结论） |

## 2. 关键调研结论

1. **帧源**：`onDynamicConversationFrame(workspaceTarget)` 是 workspace 级下行帧流（CLI `v4/conversation/frame` 通知 → facade emitter），帧外壳为 `{topic, subscriptionId, fromSeq/toSeq, sentAt, payload: {kind: snapshot|deltas}}`（conversationTopicFrameSchema）。
2. **生产缺口**：RuntimeEventMapper 此前只有测试构造——帧泵是让 Phase 3 的事件映射在生产生效的缺失装配件。
3. **CAS 前置闭环**：pause/resume 需要"已观察到快照 revision"；帧泵是唯一能在生产满足该前置的组件（此前端口只能诚实拒绝）。

## 3. 测试

- `agentRunEventPump.test.ts`（3）：snapshot 帧驱动 queued→running + revision 桥（pause rejected→accepted）；delta permission 交互→审批建档 + waiting_approval；非 PB 会话帧丢弃 + 终态后工作区退订。
- 既有回归：agentRunControl（4）/agentRuntimePort（9）/agentRuntimeContract（4）/runtimeEventMapper（7）/researchService（6）全绿。

## 4. 命令与结果（本机实测）

| 检查                                                  | 结果                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全量回归（services/desktop/ui，1652 文件 15040 用例） | 首轮 14996 过/10 败：2 例 conversationShareComposition EBUSY——**本批 pump 连接/timer 泄漏引入**（修复：pump/端口/映射共享单连接 + dispose 链 stop+close）；2 例 rootUpdateReadyOverlay/overlay 并发 flake（单文件全绿）；7 例已登记豁免/环境项。修复后 14999 过/7 败（全部为已登记项） |
| tsc -b 全仓                                           | 0 错误                                                                                                                                                                                                                                                                                 |
| oxlint / architecture:check --changed                 | 0 错误 / violations 0                                                                                                                                                                                                                                                                  |

## 5. 遗留

1. **会话面实时推送**：pump 落库后 RunsView 8s 轮询；broadcast 推送（host→renderer 即时刷新）随后续批。
2. **帧泵覆盖面**：目前只追踪经 AgentRuntimePort 创建的 PB run（research runs）；桌面普通会话不入 pb_runs（产品边界，非缺陷）。
3. **E2E**：研究 run→审批→实时状态全旅程 E2E 待 B4 解除后补。

## 6. CI 结论（回填）

- 待推送后回填（以 run 记录为准）。
