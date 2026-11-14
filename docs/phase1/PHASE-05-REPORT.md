# PHASE-05-REPORT（信息到工作流闭环完成报告）

> 依据：spec 16 信息到工作流闭环（文章加入项目、转任务、启动研究工作流、摘要引用和产物归档；门禁：摘要可追溯，外部内容不能提升工具权限，重复触发有幂等保护）+ spec 05 §7/§8 + spec 08 §4/§9 + spec 06 §2 + 07 裁决（SR-12 本闭环落地）+ `docs/audit/12-信息到工作流闭环-开发计划.md`。
> 分支自 main（PR #6 合并后 `308e2741`）切出。
> 结论：**PASS WITH KNOWN ISSUES**（CI 结论见 §6）。

## 1. 交付矩阵（计划切片 vs 实际）

| 切片 | 计划 | 实际 | 状态 |
|---|---|---|---|
| S1 迁移 0008 | pb_workflow_templates + pb_feed_summaries | (id,version) 复合主键（版本不可静默变更）；摘要缓存双唯一键（同卡同模型 / 同内容同模型跨源）；model_version 空串语义（防 UNIQUE NULL 不相等）；**顺带补齐备份缺口**：BACKUP_TABLES 补 feed 三表+新两表、restore 重建 feed FTS | ✅ |
| S2 领域接线 | ProjectLinkKind + 卡片转任务 | shared 加 `feed_item`；convertCardToTask 复用 IPlayableBenchService capture→convert 写入路径（单一写入方）；幂等：同卡片原始 URL 已成功转换则复用 | ✅ |
| S3 研究工作流 | 模板 + 幂等启动 | WorkflowTemplateRepo（种子不覆写）+ research_article v1（inputSchema/permissions/approvalPolicy/outputSchema 落库）+ IResearchService.startResearchFromCard（幂等：RunRepo.findActiveRunByTemplateInput 同卡活跃 run 复用）+ 端口接线（node.ts 注册 IResearchService，Run 域共享连接） | ✅ |
| S4 摘要引用 | message.final + 提取/缓存 | RuntimeEventMapper 捕获 assistantText 完成态（确定性 eventId 幂等、8000 字限长、流式不落）；FeedSummaryRepo（缓存命中 reused）；syncSummary 守卫（卡片存在/run 归属/终态/事件可得）；引用 URL 提取（上下文片段、去重） | ✅ |
| S5 SR-12 untrusted | 分隔块 + 注入回归 | goalComposer：`<untrusted_external_content>` 包裹（沿用 core 既有惯例）；闭合标签转义防逃逸；信任侧指令逐字固定；goalComposer 注入回归 4 用例（逃逸/指令注入/伪 system 行） | ✅ |
| S6 调度接线 | 常驻定时器 | feedServiceHost 内 60s 间隔扫描 refreshDueSources（0 可禁用；unref 不阻退出；上一轮未结束跳过；无到期源仅本地查询）；测试以 15ms 间隔验证自动补采 | ✅ |
| S7 UI | 卡片动作 + 摘要展示 | RadarCard（memo，拆出）：转任务/交给 Agent 研究/加入项目（feed_item 关联）/研究摘要查看（可追溯徽标：模型/时间/runId/引用数）；RadarView 编排层持状态单一所有者；workspacePath 由 shell 传入；i18n 双语 | ✅ |
| S8 收尾 | 报告 + 回填 | spec 20 PRD-05 → PARTIAL；本报告 | ✅ |

明确不做（本闭环）：批量/定时摘要（按需触发 MVP）；摘要产物归档 note 关联（pb_feed_summaries.note_id 字段就绪，UI 保存到笔记随交互稳定批）；run 状态实时轮询展示（Host 帧泵接线后补）；跨来源聚类/趋势（Phase 7）；移动端（Phase 6）。

## 2. 过程中的关键发现（全部已处理）

1. **备份覆盖缺口（Phase 4 遗留）**：feed 三表未进 BACKUP_TABLES、restore 不重建 feed FTS——本闭环 S1 一并补齐（spec 06 §5 导出保留关联）。
2. **UNIQUE 索引 NULL 语义**：SQLite 中 NULL ≠ NULL 会让 (model_version) 列重复绕过唯一键；用 NOT NULL DEFAULT '' 表达"无版本"并写测试锁定。
3. **分隔块逃逸**：untrusted 包裹的核心攻击面是内容提前闭合标签——字段值闭合标签转义 + 注入回归锁定（恶意标题含 `</untrusted_external_content>` 不产生第二个闭合）。

## 3. 变更文件摘要（提交链）

- `2f97060a` 开发计划文档（docs/audit/12）。
- 迁移 0008 + shared workflow 类型（pb_workflow_templates/pb_feed_summaries + PbWorkflowTemplate/PbFeedSummary）。
- 备份覆盖：BACKUP_TABLES 补 feed/workflow 表 + PB_FEED_FTS_REBUILD_SQL 恢复重建。
- convertCardToTask（InboxRepo.findConvertedBySourceUrl 幂等查找）。
- WorkflowTemplateRepo + RunRepo.findActiveRunByTemplateInput + goalComposer + IResearchService/Host + ServiceChannels.Research + accessor/node/index/client 接线。
- 摘要：RuntimeEventMapper message.final 捕获 + FeedSummaryRepo + syncSummary/listSummaries。
- untrusted 注入回归（goalComposer.test）。
- 常驻调度定时器（feedServiceHost）。
- UI：RadarCard 拆出 + RadarView 闭环动作 + shell 传 workspacePath + i18n 键。

## 4. 命令与结果（本机实测）

| 检查 | 结果 |
|---|---|
| services 全量回归（unit project，276 文件 3109 用例） | 首轮 3088 过/5 败：3 例为 tasksDatabaseMigration 硬编码账本计数与表清单（已修复）；settingService/subagentsService 4 例单文件复跑全绿 → 并发环境 flake（登记观察项）。第二轮 3092 过/1 败（同 flake 复现，单独全绿） |
| tsc -b 全仓（pnpm typecheck，含格式化后复验） | 0 错误 |
| oxlint（逐提交改动文件；全仓 0 错误/74 警告均为既有） | 0 错误 |
| `architecture:check --changed` | OK，violations 0 |
| oxfmt（本闭环改动 31 文件） | 已格式化（仓库基线 2423 文件未格式化为既有状态，CI quality 不含 fmt） |

## 5. 门禁对照（spec 16）

| 门禁 | 状态 |
|---|---|
| 摘要可追溯 | ✅ pb_feed_summaries 带 run_id/模型/模型版本/时间/引用片段；事件流 fixture 提取测试 |
| 外部内容不能提升工具权限 | ✅ goal untrusted 分隔 + 闭合逃逸转义 + 工具白名单=模板 permissions（capabilities）∩ TOOL_POLICY_REGISTRY（端口层裁决）；注入回归测试锁定 |
| 重复触发有幂等保护 | ✅ 研究启动（同卡活跃 run 复用）、摘要（同内容同模型缓存命中 reused）、转任务（同卡原始 URL 复用）、加入项目（PK ON CONFLICT DO NOTHING）；各以并发/重复调用测试锁定 |

## 6. CI 结论（回填）

- 首跑 run 43571273956 unit job 失败 1 例：`reactStableReferences.test.ts`——RadarView 向 memo 组件 RadarSourcesPanel 传内联函数 props（4 处）。修复：四个 handler 提为 useCallback、projects 投影 useMemo（`57b1cefb`）。
- 提交 `57b1cefb` CI 孪生 run **43574539568 / 43574535332 三 job 全绿**。
- **结论：CI PASS**（分支 phase5/workflow-closed-loop，PR #7 合并以本报告为准）。

## 7. 已知问题与遗留

1. **run 状态实时展示未接帧泵**：研究 run 的 planning→running→completed 透出为启动时刻快照；Host 帧泵把 IAgentRuntimePort 接进桌面运行链路后，RadarCard 状态徽标补实时刷新（PRD-06 遗留同源）。
2. **审批 UI 未接**：research run 的高风险工具审批仍走会话原生子系统；PB 审批卡（携带 operationDigest）随 UI 闭环批（PRD-07 遗留同源）。
3. **摘要→笔记归档入口未做**：pb_feed_summaries.note_id 字段就绪；"保存摘要为笔记/加入项目"二次动作随交互稳定批。
4. **E2E 场景**：卡片闭环动作的 E2E 随交互稳定后补（AGENTS.md 交互验收要求；本批以服务层幂等/注入回归为门禁证据）。

## 8. 结论

**PASS WITH KNOWN ISSUES**——三门禁全部有测试证据；卡片→任务/项目/研究/摘要全链路与 SR-12 untrusted 纪律、调度常驻接线落地；实时 run 展示与审批 UI 如实顺延。
