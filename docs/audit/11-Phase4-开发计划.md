# 11 · Phase 4 开发计划（信息雷达基础版）

> 依据：spec 16 Phase 4（RSS/Atom/自定义源、调度、规范化、去重、统一卡片、收藏、原文链接、source health）+ spec 08 全文 + spec 19 §1-§4（A 级首批）+ spec 06 §2/§3（FeedSource/FeedItem/FeedMetricSnapshot）+ 07 裁决（SR-08 SSRF 第一天内置、SR-12 untrusted 标记留 Phase 5、C/D 级不实施、B 级延后）。
> 原则：纵向切片、每片可构建可测试；采集可靠、来源可见、去重准确、刷新成本可控优先；失败的 source 只影响自身。
> 工作分支 `phase4/information-radar`（自 main 切出，PR #4/#5 合并后）。

## 范围裁决（A 级首批，spec 19）

- **本阶段 connector**：RSS/Atom（任意用户输入 URL，首个完整真实 connector——覆盖坏 XML、ETag、429、超时、去重、SSRF、陈旧状态）；GitHub Releases/Activity 与 Hacker News 官方公开源延后（同为 A 级但非门禁必需，登记下批）。
- **明确不做**（裁决）：C/D 级（RSSHub 外接、X/知乎/公众号、绕过类）；B 级（少数派/Reddit）随 Phase 7。
- **UI**：Radar 页替换占位（占位组件 Phase 2 已留），最小面：卡片列表（原始标题/来源/作者/发布时间/firstSeenAt/摘要/原文链接/指标带采样时刻）+ 添加源 + 手动刷新 + 收藏/已读 + 打开原文。密度切换与"交给 Agent 研究"等闭环动作随 Phase 5。
- **SR-12**：untrusted 内容标记系统随 Phase 5 闭环（裁决原文）；本阶段 HTML 不渲染、只存摘要文本，不进 DOM。

## 切片与范围

| 切片 | 内容 | 触及 |
|---|---|---|
| S1 存储迁移 | tasks-index 迁移 0007：`pb_feed_sources`/`pb_feed_items`/`pb_feed_metric_snapshots`（spec 06 §2 字段）+ 索引（(source_id, source_item_id) 部分唯一、canonical_url、(source_id, published_at)）+ FTS（标题/摘要 trigram，external-content + 触发器）+ shared 类型 | `tasksDatabase/playablebench-feed-v7.ts`、`packages/shared` |
| S2 数据访问 | `FeedSourceRepo`/`FeedItemRepo`：sources CRUD + 能力声明/健康字段；items upsert 去重（sourceItemId → canonicalUrl → contentHash 三级；重复合并多来源 attribution；firstSeenAt 保留/lastSeenAt 推进）；收藏/已读；metric 采样（metricOrigin 区分 native_source/derived_estimate）；失败不清空旧内容（upsert 语义） | `session/feedSourceRepo.ts`、`feedItemRepo.ts` |
| S3 SSRF 防线（SR-08） | URL 校验纯函数（scheme 白名单 http/https；拒绝 file/javascript/data/未知 scheme）+ IP 分类拒绝（localhost/私网/link-local/loopback/云 metadata 169.254.169.254）+ DNS 解析后校验（防 rebinding）+ 重定向逐跳校验 + 资源上限（连接/总超时、响应体上限、最大重定向）+ 代理环境不豁免校验 | `playablebench/fetchGuard.ts` |
| S4 受限解析器 | 自研 RSS 2.0/Atom 最小解析器（**不引入 XML 依赖**，供应链最小面）：禁 DTD/实体（防 XXE/billion laughs）、文档大小/嵌套深度/条目数上限；提取 entry/item 的 id/title/link(canonical 化)/updated/author/summary/content | `playablebench/feedParser.ts` |
| S5 Connector + 调度 | `FeedConnector` 契约（getCapabilities 运行时声明，spec 19 §3：fetchItems/nativeHotList/nativeMetrics/requiresCredential/limitations/lastValidatedAt）+ RssAtomConnector（ETag/If-Modified-Since 条件请求、429 遵守 Retry-After、5xx/超时指数退避 + jitter、4xx 不重试、single-flight per source、全局/单源暂停、分批补采、canonical URL 白名单参数规范化）+ source health 记录 | `playablebench/feedConnector.ts`、`feedScheduler.ts` |
| S6 服务面 | `IFeedService` descriptor + 实现：addSource/listSources/removeSource/pauseSource/refreshSource(manual)/listCards（统一卡片契约）/favorite/markRead/unfavorite + 健康状态查询 | `playablebench/feedService.ts` |
| S7 Radar 最小 UI | RadarPlaceholderView 替换为 RadarView：卡片列表（契约字段全展示、来源归属不隐藏）+ 添加源（URL）+ 手动刷新 + 收藏/已读切换 + 原文链接外开；空态/加载/错误/unsupported 十态；i18n 双语 | `packages/ui/src/playablebench/` |
| S8 收尾 | 合约 fixture 集（正常 RSS/Atom、坏 XML、空 feed、超大、恶意实体、429+Retry-After、超时、重定向到私网、相同内容多 URL）；治理适配；PHASE-04-REPORT；spec 20 回填 | tests、docs |

明确不做（本阶段）：AI 摘要（spec 08 §9 留 Phase 5）、趋势/For You 排序（Phase 7，需两个采样点起步）、B/C/D 级 connector、HTML 渲染/Readability 提取。

## 数据迁移与回滚

- 迁移 0007 纯增量建表；FTS 同 0004/0006 纪律（external-content + 触发器 + rebuild 入口，content 表名与迁移测试断言一致——吸取 0006 教训，迁移测试断言 content 表名逐字比对）。
- 旧库升级保留全部数据；feed 表为空表，无数据迁移。

## 测试与验收（对齐 spec 16 Phase 4 门禁）

- **fixture 集成测试**：429+Retry-After、timeout、坏 XML、空 feed、超大/恶意实体 XML、重定向到私网（SSRF）、相同内容多 URL（去重）——全部通过。
- **失败不清空旧内容**：source 抓取失败后 items 保留且 lastSuccessAt/lastErrorCode 正确。
- **来源能力声明准确**：connector getCapabilities 与实际行为一致（测试断言）；能力字段进卡片/源管理。
- 去重三级键（sourceItemId → canonicalUrl → contentHash）测试；重复合并保留 attribution 与 firstSeenAt。
