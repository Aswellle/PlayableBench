# PHASE-06-REPORT（移动远程控制完整重造完成报告）

> 依据：spec 16 门禁（授权测试全过；未授权设备无法获得数据；命令重放与撤销立即生效）+ spec 09 全文 + spec 06 §2（RemoteDevice/RemoteCommand）+ 07 裁决（SR-04 设备注册表/scope）+ `docs/audit/13-移动远程控制-开发计划.md`。
> 分支自 main（PR #7 合并后 `5460f909`）切出。
> 结论：**PASS WITH KNOWN ISSUES**（CI 结论见 §6）。

## 1. 交付矩阵（计划切片 vs 实际）

| 切片                 | 计划                                     | 实际                                                                                                                                                                                                                                            | 状态                |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| S1 存储迁移 0009     | 设备注册表/命令账本/安全事件             | pb_remote_devices + pb_remote_command_ledger（request_id 全局唯一）+ pb_remote_security_events；设备表进备份清单                                                                                                                                | ✅                  |
| S2 设备注册表 repo   | 绑定/确认/scope/撤销                     | pending→确认→active 生命周期；逐设备撤销即时失效（凭据查找与 scope 判定拒绝）；一键撤销全部；到期收敛；最近使用推进                                                                                                                             | ✅                  |
| S3 配对确认门        | 一次性 challenge + 确认                  | 现实收敛：relay 不在本仓库，配对凭证不变；新增**设备确认门**（新凭据哈希→pending→桌面确认后才能获得数据）；过期收敛承担短时限语义                                                                                                               | ✅（收敛，见 §7.1） |
| S4 AuthZ             | 六类 scope + 每命令重检                  | 三能力档→六类 scope 固定映射（REMOTE_DEVICE_TIER_SCOPES）；manager 数据类 payload（bootstrap/工作区列表/平台请求/bridge open/reconnect/任务面）全部过授权门；白名单外 RPC 拒绝；**host 侧新增 RemoteDeviceGate**（services）+ desktop main 注入 | ✅                  |
| S5 重放保护          | requestId 账本                           | begin INSERT OR IGNORE 回读（reused=true 返回先前结果不再次执行）；有效期前置校验；payload digest 记账                                                                                                                                          | ✅                  |
| S6 并发审批 CAS      | 单次生效                                 | ApprovalRepo.decideOnce（UPDATE 影响行数判定）；并发两方只一个成功；digest 绑定校验（手机只批准特定 digest）                                                                                                                                    | ✅                  |
| S7 手机任务面        | 任务列表/run 摘要事件/追加指令/审批/控制 | **只读面**：task-list/run-summary（含 pending 审批）/run-events（游标补齐）——desktop main 直读 tasks-index；追加指令由既有 replayable 链路覆盖；审批决定/暂停取消的执行面顺延（见 §7.2）                                                        | ✅（收敛）          |
| S8 安全事件+威胁回归 | spec 09 §9 场景                          | 安全事件落表（pending/confirmed/revoked/rejected）；威胁场景分散覆盖：过期（expireDue→expired）、已撤销+WS（revoke→拒绝+IPC 停远控）、replay（ledger）、越权（凭据哈希认证）、scope 不足、白名单外 RPC、并发审批 CAS                            | ✅                  |
| S9 设备管理 UI       | 列表/确认/撤销                           | WebRemoteControlDevicesPanel（memo）：pending 确认（三档选择）/拒绝、active 撤销、一键撤销全部；IPC×4 + preload/platform 全链；撤销即停对应窗口远控                                                                                             | ✅                  |

明确不做（本批，如实）：relay 侧多凭证改造（服务端不在本仓库）；手机远程桌面/shell/默认文件权限（spec 09 §2 不做项）；端到端加密（relay 可见性文档随 Phase 7 门禁）。

## 2. 过程中的关键发现（全部已处理）

1. **manager 授权门时序**：routePayload 异步化会破坏既有同步测试契约（缓冲 outbound payload 场景）——Gate 缺席时保留同步快路径，注入时异步授权，两语义共存。
2. **hashPairingCredential 归属**：node:crypto 不能进 shared 主入口（renderer 拉入会炸）——放 `@zcode/shared/node`，services/desktop main 共用单一实现。
3. **执行面架构约束**：IAgentRuntimePort 在 host utilityProcess，desktop main 无法直发 V4 命令——追加指令已由 replayable 链路覆盖（不重复造）；审批决定/控制命令的执行面需 host RPC 面，与 PRD-07 审批 UI 同批顺延，不在本层制造第二条命令写入路径。

## 3. 变更文件摘要（提交链）

- 计划文档（docs/audit/13）。
- 迁移 0009 + shared remote 域类型（tier/scope 固定映射）+ 备份清单补设备表。
- RemoteDeviceRepo / RemoteSecurityEventRepo / RemoteCommandLedgerRepo（session）。
- RemoteDeviceGate（playablebench：AuthZ+幂等一体化准入）。
- ApprovalRepo.decideOnce + 并发审批测试。
- manager：deviceGate/taskFacade 窄接口 + routePayload 授权门（同步快路径保留）+ 任务面只读 case；desktop main 注入（共享 RunStoreConnection）。
- shared web-remote-control-tasks payload 类型（新文件，旧桌面 default 跳过安全）。
- IPC×4/preload/renderer platform + WebRemoteControlDevicesPanel + i18n 双语。

## 4. 命令与结果（本机实测）

| 检查                                                                  | 结果                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 全量回归（unit project：services+desktop+shared，711 文件 7087 用例） | 7045 过/9 败：2 例 DB109 硬编码表清单与账本计数（已修复复绿）；7 例全部为已登记豁免/环境项（NSIS 冒烟/盘符代理/代码页/POSIX 路径 ×3） |
| tsc -b 全仓（pnpm typecheck）                                         | 0 错误                                                                                                                                |
| oxlint（逐提交改动文件）                                              | 0 错误                                                                                                                                |
| `architecture:check --changed`                                        | OK，violations 0                                                                                                                      |

## 5. 门禁对照（spec 16）

| 门禁                   | 状态                                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 授权测试全过           | ✅ spec 09 §9 场景：过期二维码（expireDue）、撤销后拒绝（gate+IPC 停远控）、replay（ledger reused）、越权（凭据哈希）、scope 不足、白名单外 RPC、并发审批 CAS——remoteDeviceGate(6)/remoteDeviceRepo(6)/approvalConcurrency(3)/manager 集成(+2) 全绿 |
| 未授权设备无法获得数据 | ✅ 新设备 pending→manager 数据类 payload 全部拒绝（app-error unsupported-action）；未确认/撤销/过期设备凭据认证不命中                                                                                                                               |
| 命令重放与撤销立即生效 | ✅ requestId 账本重复返回先前结果；revokeDevice 后凭据查找与 scope 判定即时拒绝 + 同窗口远控 stop                                                                                                                                                   |

## 6. CI 结论（回填）

- 提交 `8a0b130e` CI 孪生 run **43585001860 / 43584977942 三 job 全绿**（首跑即绿，无修复轮次）。
- **结论：CI PASS**（分支 phase6/remote-device-control，PR #8 合并以本报告为准）。

## 7. 已知问题与遗留

1. **QR 长期凭证残余（SR-01 完整项）**：relay 认证材料（deviceSid/passHash）与 QR 内容不变——一次性 challenge/设备独立凭证需 relay 服务端配合，服务端不在本仓库。Host 侧已用"设备确认门+短时有效期+撤销即时失效"收敛风险面；relay 改造随跨网 relay 批次（Phase 7）对齐。
2. **多物理设备共享凭证**：同一 passHash 的多台手机共享一个注册表条目（设备条目以凭证为粒度）——物理设备级隔离依赖 relay 多凭证，同 §7.1 顺延。
3. **审批决定/暂停取消的 host 执行面**：需要 host 侧 RPC 方法 + 手机审批卡片 UI（与 PRD-07 审批 UI 同批）；数据层（CAS/digest 绑定）本批已就绪。
4. **手机侧任务面 UI**：payload 协议与授权已就绪；packages/web 手机页面消费（任务列表/摘要/事件展示）随交互稳定批。
5. **E2E 场景**：设备配对→确认→撤销全旅程 E2E 待 B4 解除后补。

## 8. 结论

**PASS WITH KNOWN ISSUES**——三门禁全部有测试证据；设备注册表/scope 分级/授权门/重放保护/并发审批 CAS/设备管理 UI 全链路落地；relay 侧残余如实顺延。
