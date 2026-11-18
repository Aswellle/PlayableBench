# PHASE-07-REPORT（更多连接器与趋势视图完成报告）

> 依据：spec 16 Phase 7 门禁（安全架构与数据流说明公开；不要求端口转发；relay 无任意执行能力；性能/费用/来源条款可观察）+ spec 19 §1-§4（A 级第二批：GitHub Releases A/P0-P1、HackerNews A/P1）+ spec 08 §8（热度模型）+ `docs/audit/14-更多连接器与趋势视图-开发计划.md`。
> 分支自 main（PR #11 合并后）切出。
> 结论：**PASS WITH KNOWN ISSUES**（CI 结论见 §6）。

## 1. 交付矩阵

| 切片                                | 计划                     | 实际                                                                                                                                                                                                                                                                                            | 状态 |
| ----------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| S1 connector 工厂 + GitHub Releases | 类型扩展/工厂/能力差异化 | FeedConnectorType 扩 `github_releases`/`hackernews`；`fetchAtomFeed` 提取复用；`createFeedConnector` 工厂；feedService.addSource 显式类型优先 + URL 识别（github.com 仓库 → Releases Atom）；能力声明差异化（无原生指标——stars 不等同内容质量）+ limitations（无凭据限额）+ termsUrl 落库       | ✅   |
| S2 HackerNews connector             | 官方 API/原生指标        | 官方 Firebase API：topstories（≤30）→ 批量 item（并发 5、单条容错）；受限 JSON 解析（字段白名单/类型校验）；原生指标 score/comment_count → FeedFetchOutcome.metrics → scheduler 落 FeedMetricSnapshot（native_source）；deleted/dead 剔除；无外链条目保留 HN item 链接；无 score 字段不推断指标 | ✅   |
| S3 趋势视图                         | native 排序              | listCards `trending`：最新 native 采样值降序（不跨平台求和、无采样卡片不参与、旧采样不影响）；RadarView 第四态"热门（原生）"+ 卡片"来源原生排名"徽标（spec 19 §6 文案规则）                                                                                                                     | ✅   |
| S4 relay 数据流说明                 | 门禁第一条               | docs/security/relay-data-flow.md：出站 WSS 架构图（不要求端口转发）、relay 可见数据清单（**非 E2E 明确标注**）、信任边界、白名单 RPC 面（relay 无任意执行能力）、日志纪律、费用/条款可观察表、威胁测试映射                                                                                      | ✅   |
| S5 收尾                             | 报告+回填                | spec 20 PRD-03 回填；本报告                                                                                                                                                                                                                                                                     | ✅   |

明确不做：B 级 connector（sspai/知乎/X/Reddit 按裁决延后）、relay 服务端改造、E2E 全旅程、For You 推荐算法。

## 2. 过程中的关键发现

1. **fixture 键名漂移**：HN 测试注入对象误用 `kind` 作 ok 标记——类型层面无法发现（结构兼容 Object），断言 `failed` 才暴露；fixture 与真实返回形状逐键核对。
2. **resolver 旁路**：connectorResolver 会旁路测试注入的 loopback connector——rss_atom 保持注入优先，新类型走 registry。
3. **SQL 动态拼接**：trending 分支 where 为空时 `FROM … AND EXISTS` 语法错——空条件分支必须显式 WHERE。

## 3. 测试

- `feedConnectorsRegistry.test.ts`（4）：HN 链路（items/metrics/外链纪律/无指标不推断）、单条容错/全失败退避/坏 JSON/429 透传、GitHub+HN 能力声明（含条款链接）、工厂路由。
- `feedConnectorScheduler.test.ts` 追加：调度器原生指标采样落表（native_source、非本批次指标丢弃）。
- `feedService.test.ts` 追加：addSource URL 识别 github → Releases + termsUrl 落库、显式类型覆盖。
- `feedRepo.test.ts` 追加：trending 排序（最新采样值/无采样不参与/默认视图不受影响）。
- 全量回归：services+ui **1366 文件 12785 用例全绿**。

## 4. 命令与结果（本机实测）

| 检查                                 | 结果                     |
| ------------------------------------ | ------------------------ |
| 全量回归（services+ui unit project） | 1366 文件 12785 用例全绿 |
| tsc -b 全仓                          | 0 错误                   |
| oxlint（逐提交改动文件）             | 0 错误                   |
| `architecture:check --changed`       | OK，violations 0         |

## 5. 门禁对照（spec 16 Phase 7）

| 门禁                     | 状态                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 安全架构与数据流说明公开 | ✅ docs/security/relay-data-flow.md（出站 WSS 图、relay 可见数据清单、非 E2E 标注、信任边界）                                     |
| 不要求端口转发           | ✅ Host 出站 WSS（Phase 1 已证）+ 文档陈述                                                                                        |
| relay 无任意执行能力     | ✅ 白名单 RPC 面（spec 09 §6 锁定）+ 文档陈述 relay 只路由配对会话帧                                                              |
| 性能/费用/来源条款可观察 | ✅ capabilities.lastValidatedAt/limitations + termsUrl 落库 + 文档核验记录（GitHub 限额、HN 无凭据；未来计费 API 须提供预算上限） |

## 6. CI 结论（回填）

- 提交 `4625332f` CI 孪生 run **44352308131 / 44352209111 三 job 全绿**（首跑即绿，含修复后的 bash+retry 自愈策略）。
- **结论：CI PASS**（分支 phase7/connectors-trending，PR #12 合并以本报告为准）。

## 7. 遗留

1. B 级 connector（sspai/知乎/X/Reddit）按裁决延后；接入时按 spec 19 §4 上线检查逐条核验。
2. 趋势面为最小实现（最新采样值排序）；For You 推荐与跨来源聚类留后续批。
3. relay E2E 加密未实现（文档明确标注）；如需 E2E 需客户端-Host 密钥协商，随跨网 relay 批。
4. HN connector 真实请求核验日期 2026-11-16（测试以 fixture 表达返回字段；真实端点在上线检查清单中记录）。
