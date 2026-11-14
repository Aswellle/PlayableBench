# PHASE-04-REPORT（Phase 4 完成报告）

> 依据：spec 16 Phase 4（RSS/Atom/自定义源、调度、规范化、去重、统一卡片、收藏、原文链接、source health）+ spec 08 全文 + spec 19 §1-§4 + spec 06 §2/§3 + 07 裁决（SR-08 第一天内置、SR-12 留 Phase 5、C/D 级不实施、B 级延后）+ `docs/audit/11-Phase4-开发计划.md`。
> 分支 `phase4/information-radar`（自 main `21b6b55f` 切出，PR #4/#5 合并后）。
> 结论：**PASS WITH KNOWN ISSUES**（CI 结论见 §6）。

## 1. 交付矩阵（计划切片 vs 实际）

| 切片 | 计划 | 实际 | 状态 |
|---|---|---|---|
| S1 存储迁移 | 迁移 0007：feed_sources/items/metric_snapshots + FTS | 全部落地；去重部分唯一索引（(source_id,source_item_id)/(source_id,content_hash)）；canonical_url 只建查找索引（spec 06 §3 不盲目全局唯一）；**content 表名逐字断言**（吸取 0006 教训） | ✅ |
| S2 数据访问 | FeedSourceRepo/FeedItemRepo | 三级去重合并（sourceItemId→contentHash→新建；firstSeenAt 保留/lastSeenAt 推进/attribution 追加）；健康字段纪律（失败不清 last_success_at/条件游标）；级联删除；收藏/已读/计数；FTS ∪ LIKE | ✅ |
| S3 SSRF 防线 | fetchGuard（SR-08） | scheme 白名单；IP 全量分类（loopback/私网/CGNAT/link-local/云 metadata v4+v6/保留段/内嵌 v4 mapped/NAT64/6to4/Teredo）；DNS 解析全地址校验并**钉定 IP**（防 rebinding 竞态）；重定向逐跳校验；连接/总超时、体上限、重定向上限；userinfo 拒绝；测试放行仅限 loopback | ✅ |
| S4 受限解析器 | 自研 RSS/Atom | 不引入 XML 依赖（供应链最小面）；DOCTYPE/ENTITY 文档级拒绝；大小/深度/条目上限；CDATA/实体解码统一剥标签（HTML 不渲染）；RFC822+ISO8601 双日期 | ✅ |
| S5 Connector+调度 | FeedConnector + FeedScheduler | getCapabilities 运行时声明（spec 19 §3）；ETag/If-Modified-Since；429 Retry-After 透传；指数退避+jitter；4xx 不加速重试；source 级 single-flight（占位同步段完成）；分批补采；暂停/停用跳过原因透出 | ✅ |
| S6 服务面 | IFeedService | descriptor/实现分离（renderer 安全）；添加时前置 scheme/字面量校验；刷新 skipped 语义透出；卡片契约字段齐备 | ✅ |
| S7 Radar 最小 UI | 占位替换 | RadarView：添加源/源管理（刷新/暂停/删除+健康可见）/卡片列表（来源归属不隐藏/原文外开 rel=noopener）/收藏已读/过滤三态/i18n 双语；占位组件与占位键删除 | ✅ |
| S8 收尾 | fixture 集 + 报告 + 回填 | fixture 覆盖见 §5；spec 20 PRD-03/04 回填 PARTIAL | ✅ |

明确不做（本阶段，裁决）：AI 摘要（spec 08 §9 → Phase 5）、趋势/For You 排序（Phase 7）、B/C/D 级 connector、GitHub/HN connector（A 级但非门禁必需，登记下批）、untrusted 标记系统（SR-12 → Phase 5）。

## 2. 过程中的关键发现（全部已处理）

1. **单飞竞态**：single-flight 的 check-then-act 跨 await 会让并发调用全部通过检查——占位必须在首个 await 前同步完成。测试以并发双调用断言锁定。
2. **解析器层级归属**：元素文本提取必须定位该元素首个开标签（全局 CDATA 搜索会越过频道级标题命中条目 CDATA）；CDATA 内容同样剥标签（HTML 不渲染）。
3. **测试 connector 与 https**：本机测试服务器为纯 http，重写 URL 时需同步改协议，否则 SSL 错误掩盖真实断言。

## 3. 变更文件摘要（提交链）

- `219aa835`→`5ae23d96` 计划文档（分支重建后 cherry-pick）。
- `37f9f6e2` 迁移 0007 + shared feed 类型/能力契约。
- `a4c9106e` FeedSourceRepo/FeedItemRepo（三级去重/attribution/健康纪律）。
- `8587620a` fetchGuard（SSRF 防线，11 用例）。
- `f31c150b` feedParser（受限解析，7 用例）。
- `c1bea149` feedConnector + feedScheduler（7 用例）。
- `18b2a774` IFeedService 服务面 + 通道/accessor 接线（3 用例）。
- `77191b3a` RadarView 最小 UI（占位替换）。
- 收尾：占位组件删除 + spec 20 回填 + 本报告。

## 4. 命令与结果（本机实测）

| 检查 | 结果 |
|---|---|
| Phase 4 全部测试（10 文件） | 60 用例全绿 |
| services 全量回归 | 262 文件 3020 用例全绿（S5 前）；S6/S7 后针对性全绿 |
| tsc -b（shared/services/client/ui） | 0 错误 |
| oxlint（逐提交改动文件） | 0 错误 |
| `architecture:check --changed` | OK，violations 0 |

## 5. 门禁对照（spec 16 Phase 4）

| 门禁 | 状态 |
|---|---|
| 429/timeout/坏 XML/SSRF fixture 集成测试通过 | ✅（429+Retry-After 透传、totalTimeout 拒绝、坏 XML/无结构 parse 错误码、重定向到 metadata 在 loopback 放行下仍拒绝、DOCTYPE/ENTITY 拒绝） |
| 失败不清空旧内容 | ✅（健康字段只记错误不清 last_success_at/游标；条目表无失败删除路径；500 后 count 断言不变） |
| 来源能力声明准确 | ✅（getCapabilities 与行为一致断言：A 级无凭据/无热榜/无指标；声明落库并进源管理） |

## 6. CI 结论（回填）

- 提交 `7ef36c5b`（Phase 4 全量）首跑 run 43495126642 unit job 失败：`backupExport.test.ts` 断言账本末位仍指向 `0006_fts_pb_notes_repoint`，0007 落库后过期。修复 `f17d6e8c`（断言跟随账本末位语义，grep 全库确认无其他硬编码点；services 全量 268 文件 3058 用例本机回归全绿）。
- 提交 `f17d6e8c` CI 孪生 run **43555867396 / 43556117080 三 job 全绿**。
- **结论：CI PASS**（分支 phase4/information-radar，PR 合并以本报告为准）。

## 7. 已知问题与遗留

1. **cron 自动调度未接线**：FeedScheduler 提供 refreshDueSources 分批补采，但尚无常驻定时触发（桌面已有 Cron Scheduler utilityProcess 可承载）；接线随 Phase 5 闭环（卡片"转任务/Agent 研究"同批）。
2. **GitHub/HN connector 未做**：同为 A 级；RSS/Atom 是首个完整真实 connector（spec 19 要求），GitHub/HN 官方源下批（接入时按 spec 19 §4 上线检查核验条款与真实请求）。
3. **手动添加文章 URL**（spec 08 §2 P0 第 3 条）未做独立入口；卡片原文外开已覆盖查看路径，收录入口随 Phase 5。
4. **抓取性能基准**（spec 12 查询 p95）未单独实测：feed 表为空表起步，基准随 Phase 5 数据积累后补测。
5. AI 摘要、趋势/For You、untrusted 标记系统（SR-12）按裁决随 Phase 5/7。

## 8. 结论

**PASS WITH KNOWN ISSUES**——Phase 4 三门禁全部有测试证据；采集/去重/SSRF/调度/服务面/UI 最小面全链路落地；自动调度接线与第二批复 connector 如实顺延。
