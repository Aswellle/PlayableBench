# PHASE-02-REPORT（Phase 2 完成报告）

> 依据：spec 16 Phase 2（经 07 裁决修订）+ `docs/audit/09-Phase2-开发计划.md`。
> 分支 `phase2/domain-model`（自 main `09e1c333` 切出）· 提交 `c646ed7c` → `ff308669`。
> 结论：**PASS WITH KNOWN ISSUES**（CI 最终结论见 §5，已知问题均有登记与归属）。

## 1. 交付矩阵（计划切片 vs 实际）

| 切片 | 计划 | 实际 | 状态 |
|---|---|---|---|
| S1 存储迁移 | 0004：Inbox/Projects/Notes/Links + Task 字段 + FTS5 | 全部落地；**域表加 pb_ 前缀**（发现与上游 projects 表同名冲突后重命名，见 §4） | ✅ |
| S2 数据访问 | repos + FTS 搜索 + Today 聚合 | InboxRepo/ProjectsRepo/TaskIndexRepo 扩展（FTS∪LIKE 并集、queryTodaySummary、clearTaskScheduleFields） | ✅ |
| S3a 服务面 | Host service 接线 | IPlayableBenchService 全链路（descriptor→accessor→createLocalServices→client 代理），convert 失败保全原文 | ✅ |
| S3b UI | Today/Inbox 页面 + 导航 | 侧栏三入口 + TodayView（四分段聚合）/InboxView（捕获→转任务→归档，失败保全）/Radar 占位（显式未启用）；i18n 双语 | ✅ |
| S4 遥测 opt-out | （07 裁决并入 Phase 2） | AppSettings.telemetryEnabled + telemetryCore 门（fail-open）+ ARMS 懒化门控 + 设置页开关（双语）+ 3 路径测试 | ✅ |
| S5 导出备份最小版 | manifest+哈希+恢复预览 | **未实施**（时间盒让位给 S1-S4 + 意外发现处理），顺延 Phase 3 首批 | ❌ 如实登记 |

## 2. 变更文件摘要（提交链）

- `c646ed7c` 存储：迁移 0004（tasksDatabase/playablebench-domain-v4.ts + migrations.ts）、InboxRepo/ProjectsRepo、TaskIndexRepo 扩展、shared 域类型（playablebench-domain.ts）与 schema、测试（playablebenchDomain 9 用例 + DB109 治理同步）。
- `39fc720c` 服务 + pb_ 重命名：IPlayableBenchService（playablebench.ts 纯接口 + playablebenchService.ts 实现）、ServiceChannels、accessor、node.ts 注册、client 代理；**全部域表 pb_ 前缀化**；服务测试（playablebenchService 2 用例，强制注入临时库）。
- UI 提交：types/shell/侧栏/三组件（TodayView/InboxView/RadarPlaceholderView）/i18n 双语 25 条。
- `ff308669` 遥测 opt-out：telemetryCore 门、AppSettings.telemetryEnabled、main 接线（telemetryCore + ARMS 懒化 getArmsInitPromise）、设置页开关、telemetryOptOut 3 用例。

## 3. 命令与结果

| 检查 | 结果 |
|---|---|
| 定向存储/服务测试 | playablebenchDomain 9✅ + playablebenchService 2✅ + 迁移治理 10✅ + taskIndex 回归 ✅ |
| 遥测测试 | telemetryOptOut 3✅ + telemetryPrivacy 回归 ✅ |
| `pnpm lint`（改动文件） | 0 错误（warning 均为上游存量） |
| `tsc -b`（shared/services/client/ui/desktop-host） | 0 错误 |
| CI | run `43278670953`（HEAD ff308669）：结果回填 §5 |

## 4. 过程中的关键发现（全部已处理）

1. **上游同名表冲突（重要）**：真实用户库已存在上游 `projects` 表（project execution scopes 功能，账本含 `0004_project_execution_scopes`/`0006_task_group_admissions`）。我的 0004 初版 `CREATE TABLE IF NOT EXISTS projects` 在真实库是空操作、列结构完全不同。处置：**全部域表加 `pb_` 前缀**（pb_projects/pb_notes/pb_project_links/pb_inbox_items + fts_pb_* 影子表），FTS tasks 影子表保留（索引上游 tasks 表）；开发机真实库已安全修复（drop 误建旧表 + 删账本行 + 重放迁移，上游 16 行 projects 数据零损伤）。
2. **真实库污染事故**：服务测试初版未注入仓库路径，默认落 `~/.zcode/v2` 真实库（AutomationRepo 注释记录过的历史事故同源）。处置：清理残留 4 任务 + 4 Inbox 条目；测试强制注入临时路径并在提交信息与测试注释中登记约束。
3. **CI（run 43264964501，c646ed7c）失败**：为 pb_ 重命名前的旧提交（DB109 表清单断言），已被后续提交覆盖。

## 5. CI 结论（回填）

- 首轮 `43279065134`：quality ✅ build ✅ unit ❌（4 文件 16 用例）——全部为 Phase 2 改动的**治理测试适配缺口**而非业务缺陷：ARMS 懒化后测试未显式触发 init、BreadcrumbFrame/stable-scroller 治理计数 4→5、PlayableBench 侧栏内联 lambda 违反稳定引用治理、迁移 facts 计数与末位 ID 随 0004 变化。已逐组修复（提交 `6ed50f44`）。
- 终轮 `43288392608`：quality **PASS** / unit **PASS** / build **PASS**（三 job 全绿，1918 文件口径；以 run 记录为准）。

## 6. 验收对照（spec 16 Phase 2 门禁）

| 门禁 | 状态 |
|---|---|
| 重启后数据保持 | ✅（Inbox 重开连接保持用例） |
| 旧数据迁移成功 | ✅（0003→0004 升级保数据用例；开发机真实库实测重放） |
| 失败/重复提交正确处理 | ✅（捕获失败保留草稿；转任务失败标 failed 保留原文可重试） |
| 用户可导出核心数据 | ❌ S5 顺延（见 §1） |
| 搜索 | ✅ FTS5 trigram（CJK 实测）∪ LIKE |

## 7. 已知问题与遗留

1. **S5 导出/备份未实施**——顺延 Phase 3 首批（spec 16 门禁项，Phase 3 门禁复核时必须补）。
2. **Projects 无 UI 页**——存储/服务就绪，页面下批（Today/Inbox 先行验证了链路）。
3. **新页面键盘/窄视口手工验收未做**——桌面 GUI 仍受 B4（本机回环网络）阻塞；E2E 待 B4 解除。
4. **FTS 索引覆盖**：pb_inbox_items/pb_notes/tasks.searchable_text；会话正文快照的全文检索随 Phase 3 run 模块扩展。
5. 遥测开关经 main SettingService 读取 settings 文件；CLI/server 形态共享同一文件行为一致，未单独验收。

## 8. 结论

**PASS WITH KNOWN ISSUES**——Phase 2 核心门禁（迁移/搜索/数据保持/失败处理）全部通过，CI 终轮三 job 全绿（含全部新增能力与治理测试适配）；S5 与 Projects UI 如实顺延。
