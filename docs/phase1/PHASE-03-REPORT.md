# PHASE-03-REPORT（Phase 3 完成报告）

> 依据：spec 16 Phase 3（AgentRuntimePort 适配、Run 状态持久化、事件映射、tool policy、审批、暂停/取消与恢复）+ spec 05 §2/§3/§4/§6/§9 + spec 06 §2/§5 + 07 裁决（SR-02/TD-06）+ `docs/audit/10-Phase3-开发计划.md`。
> 分支 `phase3/runtime-port`（自 phase2/domain-model `56e0585b` 切出，含 2 个 Windows 重试窗口修复提交；PR #4 合并后 rebase）。
> 结论：**PASS WITH KNOWN ISSUES**（CI 结论见 §6，已知问题均有登记与归属）。

## 1. 交付矩阵（计划切片 vs 实际）

| 切片 | 计划 | 实际 | 状态 |
|---|---|---|---|
| S1 存储迁移 | 迁移 0005：runs/run_events/tool_executions/approvals | 全部落地（pb_ 前缀延续）；事件 (run_id,sequence) 主键 + (run_id,event_id) 唯一双键去重；工具执行幂等键唯一部分索引 | ✅ |
| S2 Run 状态机 | RunRepo + 合法迁移校验 | RunRepo/ToolExecutionRepo/ApprovalRepo 三仓库共享一条连接（架构 max-lines 拆分）；非法迁移抛 `illegal_run_transition`；重复 eventId 幂等、乱序观测 stale 跳过 | ✅ |
| S3 AgentRuntimePort | 端口接口 + V4 命令映射 + 映射表入 docs | createRun/sendInput/cancel/pause/resume/submitApproval → V4 六命令；ACK 六态透传；命令层不抢跳终态；pause/resume 需已观察快照 revision（CAS 命令，未观察到时诚实拒绝）；**V4↔Port 映射表** `docs/audit/V4-Port映射表.md`（TD-06） | ✅ |
| S4 工具策略投影 | riskLevel/capability 注册表 | TOOL_POLICY_REGISTRY（30+ 上游内置工具静态声明）+ 未收录工具保守默认；listAvailableTools 投影；策略测试全量枚举不变量 | ✅ |
| S5 审批 digest 绑定 | digest + 参数变化重审 | approvalDigest（规范化 JSON sha256）+ submitApproval decisionDigest 强制校验（mismatch 拒绝）+ recordPendingApproval 创建侧绑定（审批/工具执行同 digest） | ✅ |
| S6 事件映射 | V4 快照/增量 → Run 事实 | RuntimeEventMapper：control.phase→状态迁移、permission 交互→审批建档、toolCall 行→工具执行推进；waiting_approval 覆盖态语义；单帧单项容错 | ✅ |
| S7 导出备份最小版 | （Phase 2 S5 顺延补课） | backupExport：manifest（format/appVersion/schemaVersion/每表 sha256）+ 恢复预览 + confirm 恢复（单事务 REPLACE + FTS rebuild）；密钥不进清单 | ✅ |
| S8 SR-02 | PB 启动路径显式 mode、默认禁 yolo | 端口层收窄：createRun 的 policyContext.permissionMode ∈ {plan,build,edit,guarded}，yolo/auto 抛 `yolo_forbidden`；mode 落 pb_runs.permission_mode | ✅ |

## 2. 过程中的关键发现（全部已处理）

1. **0004 冻结 SQL 潜伏缺陷（重要）**：`fts_pb_notes` 影子表 content 仍指向 pb_ 重命名前已不存在的 `'notes'` 表——触发器同步可用但 `rebuild` 必失败（spec 06 §3 违约）。Phase 2 的 rebuild 测试只覆盖 fts_tasks 所以漏网。处置：0004 checksum 冻结面不动，新增 **0006 迁移**重建影子表/触发器并立即 rebuild；测试覆盖全新库 + 0005 时代库升级两条路径，并断言修复前 rebuild 必失败。
2. **waiting_approval 覆盖态语义**：V4 在审批挂起时 `control.phase` 仍是 running——映射器若按 phase 迁移会把覆盖态拉回 running。裁决为覆盖态：phase 驱动的迁移不得从 waiting_approval 回运行态（离开仅经审批清空或终态相位）。
3. **架构 max-lines**：Run 域单仓库超 400 行 → 按实体拆分三仓库 + 共享连接（`runStoreConnection.ts`），上游 InboxRepo 连接纪律保持。

## 3. 变更文件摘要（提交链）

- `6e4c26f1` 存储：迁移 0005 + shared run 域类型/状态机（playablebench-runs.ts）+ 迁移治理适配。
- `fd91919f` 三仓库：RunRepo（合法迁移/事件去重/stale）/ToolExecutionRepo（幂等键/崩溃扫描）/ApprovalRepo（单向决策/到期扫描）。
- `1e3ad3d5` 端口：IAgentRuntimePort（纯接口）+ AgentRuntimePortAdapter（V4 映射）+ V4↔Port 映射表文档。
- `d1e0d18d` 工具策略：TOOL_POLICY_REGISTRY + listAvailableTools 投影 + 全量枚举策略测试。
- `9ff7c8b0` 审批 digest：approvalDigest + 端口 digest 强制校验 + 创建侧绑定。
- `24d83aa3` 修复：0006 迁移（fts_pb_notes 重指向 pb_notes + rebuild）。
- `d6889b8e` 备份：backupExport 导出/预览/恢复。
- `25e14c80` 事件映射：RuntimeEventMapper（waiting_approval 覆盖态语义）。
- `fcc6e1a9` 合约测试：Harness 应用层合约套件 + known-test-failures 登记 forks worker 偶发。
- 另含 phase2 修复两笔（`e60bed79`/`5e61ba40`，重试窗口对齐，随本分支带走）。

## 4. 命令与结果（本机实测）

| 检查 | 结果 |
|---|---|
| 迁移/域/启动准备测试（6 文件） | 41 用例全绿（含 0004→0006 升级保数据、0006 修复路径、账本计数 6） |
| runRepo / approvalDigest / agentRuntimePort / toolPolicy / runtimeEventMapper / backupExport / agentRuntimeContract | 45 用例全绿 |
| `pnpm architecture:check --changed` | OK，violations 0 |
| oxlint（逐提交改动文件） | 0 错误 |
| tsc -b（shared/services） | 0 错误 |

## 5. 门禁对照（spec 16 Phase 3）

| 门禁 | 状态 |
|---|---|
| Harness contract tests 通过 | ✅（应用层合约套件 4 组：全生命周期/重复投递/崩溃恢复/审批过期；上游 harness 内部行为（超时/上下文超限/模型失效/恶意输出）由上游自有测试承担，07 裁决保留不改） |
| 崩溃与重复事件不导致重复副作用 | ✅（事件双键去重 + 幂等键 + 合约套件整轮帧重放断言） |
| 所有高风险工具有策略测试 | ✅（toolPolicy 全量枚举不变量：delete/send_external/credential_use/execute_process ⇒ requiresApproval 且 high/critical；未收录工具保守默认） |

## 6. CI 结论（回填）

- 待推送后回填（本报告提交与推送同批完成，以 run 记录为准）。

## 7. 已知问题与遗留

1. **pause/resume 局限**：V4 无通用会话暂停，映射为 goal 级 CAS 命令且需已观察快照 revision；未观察到时返回 rejected（诚实拒绝，不假装已暂停）。通用会话暂停需上游能力扩展，登记为远期。
2. **Host 帧泵接线未做**：RuntimeEventMapper 就绪但尚未接入 `IZCodeAgentService.onDynamicConversationFrame` 的常驻消费（当前由合约测试驱动）；接线与 UI（run 列表/详情页）随 Phase 5 闭环（spec 16 Phase 5"信息到工作流闭环"消费方）。
3. **备份 UI 入口未做**：backupExport 服务面就绪；设置页导出/恢复入口随 Phase 8 发布准备（spec 15 发布链路集成）。
4. **TD-14（会话级 allow 落盘）**：本阶段权限持久化面仅在 approvals 层，上游会话级规则落盘未触碰，维持随阶段顺延。
5. forks 池 worker 收尾崩溃 infra 偶发（run 43462093537 用例全绿但 job 失败、孪生 run 全绿）——登记于 known-test-failures 观察项，处置规则随附。

## 8. 结论

**PASS WITH KNOWN ISSUES**——Phase 3 三项门禁全部有测试证据；Run 状态持久化、事件映射、端口适配、审批 digest、工具策略、备份导出全链路落地；Host 接线与 UI 随 Phase 5 如实顺延。
