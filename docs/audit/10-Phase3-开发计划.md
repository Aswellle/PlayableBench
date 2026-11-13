# 10 · Phase 3 开发计划（Agent Runtime 统一接入）

> 依据：spec 16（Phase 3：AgentRuntimePort 适配、Run 状态持久化、事件映射、tool policy、审批、暂停/取消与恢复）+ spec 05 §2/§3/§4/§6/§9 + spec 06 §2/§3 + 07 裁决（§2 SR-02/TD-06/TD-14、§3 差异表阶段 3 行）。
> 原则：纵向切片、每片可构建可测试；不改 runtime 内部（apps/zcode-cli/** 冻结面解除为"只调用不修改"）；遵循 AGENTS.md 与 spec 17。
> 工作分支 `phase3/runtime-port`（自 phase2/domain-model 切出；PR #4 合并后 rebase 到 main）。

## 现状事实（源自源码盘点，2026-11-13）

- V4 命令面已具备 ACK 六态（accepted/rejected/stale/duplicate/noop/failed）、CAS（baseRevision）、resolveInteraction 审批应答、pauseGoal/resumeGoal/stop；run 生命周期以 snapshot `control.phase`（draft|prewarming|running|completedSuccess|completedInterrupted|error）与 `stopState` 表达，无独立 run 实体。
- 审批以 `pendingInteractions`（permission|userInput|workspaceHookReview）呈现，`toolCallRow.status="pendingApproval"` 携带 `approvalInteractionId`；**无操作 digest 绑定、无风险分级**。
- **无工具列表命令**（mcp/list 只有计数）；`listAvailableTools`/`health` 在适配层补充。
- tasks-index 最新迁移 `0004_playablebench_domain`；迁移框架（编号 + checksum 账本 + BEGIN IMMEDIATE）沿用。
- workspace 默认 mode=yolo（createSession.config.mode 可缺省）；PB 新启动路径必须显式指定（SR-02）。

## 切片与范围

| 切片 | 内容 | 触及 |
|---|---|---|
| S1 存储迁移 | tasks-index 迁移 0005：`pb_runs`/`pb_run_events`（(run_id,sequence) 唯一 + event_id 唯一去重）/`pb_tool_executions`（幂等键/attempt/副作用状态）/`pb_approvals`（digest/截止/决策/撤销原因）表 + 索引；shared 域类型 | `tasksDatabase/migrations.ts`、`playablebench-runs-v5.ts`、`packages/shared` |
| S2 Run 状态机 | `RunRepo`：合法迁移校验（禁止非法跳转）、状态转换作为事件持久化（runId/from/to/occurredAt/reason/eventId）、重复事件去重、V4 control.phase→PB 状态映射（含 interrupted/needs_reconciliation） | `session/runRepo.ts` |
| S3 AgentRuntimePort | 端口接口（纯 descriptor 文件）+ 适配器：createRun/sendInput/getRun/subscribeEvents/cancel/submitApproval→V4 命令映射（同步"已接受" vs "已完成"语义明确）；requestPause/resume→pauseGoal/resumeGoal（局限登记）；health/listAvailableTools 适配层补充；**V4↔Port 映射表入 docs（TD-06）** | `playablebench/agentRuntimePort.ts`、`agentRuntimePortAdapter.ts`、docs |
| S4 工具策略投影 | 产品侧 tool policy registry：toolId→{capabilities, riskLevel, requiresApproval, 策略}；模型不可改；listAvailableTools 投影出口 | `playablebench/toolPolicy.ts` |
| S5 审批 digest 绑定 | 审批创建即绑定操作摘要 digest（规范化 JSON sha256）；应答前校验 digest，参数/目标变化即失效需重审；过期处理 | `playablebench/approvalDigest.ts`、适配器接线 |
| S6 导出/备份最小版 | （Phase 2 S5 顺延补课）核心结构化数据导出：manifest{appVersion, schemaVersion, generatedAt, contents, sha256} + 恢复预览（格式/哈希校验、展示目标清单，不覆盖无确认）；密钥不随备份导出 | `playablebench/backupExport.ts`、设置页最小入口 |
| S7 合约测试 | spec 05 §9 矩阵适配 fake runtime：ACK 映射、重复事件/命令去重、取消、暂停/恢复、等待审批、审批过期、digest 变更重审、崩溃恢复扫描→needs_reconciliation；治理测试适配（DB109 等） | `packages/services/test/` |
| S8 收尾 | SR-02：PB run 启动路径显式 mode、默认禁 yolo；PHASE-03-REPORT；spec 20 回填；PERFORMANCE/known-failures 如有变化同步 | docs、services |

明确不做（本阶段）：不改 apps/zcode-cli 内部；不实现流程模板引擎（spec 05 §8 留 Phase 5 闭环前）；TD-14（会话级权限落盘）仅当触碰权限持久化时顺带评估；UI 仅设置页备份最小入口。

## 数据迁移与回滚

- 迁移 0005 纯增量建表（无破坏性 DDL、不动上游表）；回退旧构建不影响读取。
- 事件去重：`UNIQUE(run_id, sequence)` + `UNIQUE(run_id, event_id)` 双键；乱序/重复投递幂等。
- 升级测试覆盖 0004→0005 保数据（延续 0003→0004 用例模式）。

## 测试与验收（对齐 spec 16 Phase 3 门禁）

- Harness contract tests（spec 05 §9 矩阵）通过。
- 崩溃与重复事件不产生重复副作用：事件去重用例 + 幂等键用例 + 迁移重放用例。
- 所有高风险工具有策略测试：registry 全量枚举断言（删除/执行/凭据/网络外发类必须 requiresApproval）。
