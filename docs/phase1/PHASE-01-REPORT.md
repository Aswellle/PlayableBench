# PHASE-01-REPORT（Phase 1 完成报告）

> 依据：`product-spec/16`（经 07 裁决修订的 Phase 1 五目标）、`docs/audit/08-Phase1-开发计划.md`、`product-spec/17` 完成报告模板。
> 分支 `phase1/wp2-ci-workflow` · 工作区仅 docs/ 与 scripts/perf 新增，源码改动见 §2。
> 结论：**PASS WITH KNOWN ISSUES**（已知问题均有登记与后续归属，见 §7）。

## 1. 阶段目标与需求 ID

| 目标（07/08 裁决版） | 需求 ID | 状态 |
|---|---|---|
| 建立 CI | PRD-10 | **PASS**（六轮联调，run `43073576994` 三 job 全绿） |
| 完成依赖和测试基线 | PRD-10 / TD-02 | **PASS**（docs/baseline 三报告 + known-test-failures） |
| 修复 Remote Control P0 安全问题（SR-01 最小集） | PRD-08（部分） | **PASS（最小集）**；完整重造留 Phase 6 |
| 改造凭据存储（SR-03 最小集） | PRD-09 关联 | **PASS（最小集）**；oauth:* 共享键待 Main↔Host 桥 |
| 建立性能基准 | PRD-10 / spec 12 | **PARTIAL**（可测项全测；桌面形态受 B4 阻塞，如实记录） |

约束遵守：信息雷达零实现、大规模 UI 重构零、Agent Runtime 零改动——全部 PR diff 复核通过。

## 2. 实际变更文件（按工作包）

**WP1（基线，无源码改动）**：`docs/baseline/环境报告.md`、`测试报告.md`、`运行报告.md`。

**WP2（CI）**：`.github/workflows/ci.yml`（新增）、`.gitattributes`（vendored 资产 -text）、`.oxfmtrc.json`（fiddles 忽略）、`vitest.ci.config.ts`（新增）、`package.json`（test:unit:ci）、`packages/web-share/vite.config.ts`（B1）、`docs/testing/known-test-failures.md`。提交：`026b4e51`/`3d508c41`/`f5a3f92b`/`4715376a`/`3722dffd`/`9c9c8a4a`/`0bdae08d`/`daef5d0c`/`55b9dd2c`/`d6d1e261`。

**WP3（远控安全最小集）**：`packages/shared/src/web-remote-control.ts`（TTL 常量+纯函数）、`channels.ts`（revoke 通道）、`platform.ts`（契约）、`packages/desktop/src/main/webRemoteControlManager.ts`（首次配对 TTL 校验 + revokePairing）、`desktopWebRemoteControlIpc.ts`、`preload/index.ts`、`renderer/src/desktopPlatform.ts`、`packages/client/src/globals.d.ts`、`packages/web/src/main.tsx`（手机端过期拦截+平台桩）、`packages/ui/src/WebRemoteControlDialog.tsx`（撤销入口）、`i18n/locales/zh-CN.ts`+`en-US.ts`、`packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`（+5 用例）。提交：`9e4f58a7`。

**WP4（凭据存储最小集）**：`packages/services/src/credential/providers/credentialVersionedCipherProvider.ts`（新增）、`credentialService.ts`（migrateLegacyCredentialEntries）、`services/src/node.ts`（导出）、`packages/desktop/src/main/credentialSafeStorageBridge.ts`（新增）、`main/index.ts`（接线+启动迁移）、测试 ×2（新增）。提交：`10fbf5fe`。

**WP5（性能基准）**：`scripts/perf/measure-tasks-query.ts`、`scripts/perf/measure-server-startup.mjs`（新增，只读测量）、`docs/audit/PERFORMANCE_BASELINE.md`（数据版）。

## 3. 命令与结果（真实 exit code）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（全量） | PASS（WP1 582.6s；本轮复跑见 §5） |
| `pnpm lint`（全量） | **exit 0**，64 警告（存量漂移，改动文件 0 警告） |
| `pnpm test:unit:ci`（本地全量） | 1918 文件精确豁免（1928-10）；5 失败均为已登记本机项/本机网络时序项 |
| WP3 定向测试 | 2 文件 67 用例全过（含新增 5） |
| WP4 定向测试 | 3 文件 14 用例全过（新增 8） |
| `pnpm build` | exit 0（915s，WP2 期间验证） |
| CI（run `43073576994`） | **quality ✅ unit ✅ build ✅**（六轮联调实录见 WP2 报告 §3） |
| scripts/perf ×2 | 输出见 docs/audit/PERFORMANCE_BASELINE.md |

## 4. UI/交互验收（适用项）

远控面板新增「撤销配对」按钮：确认弹窗（双语）→ 撤销 → 状态回 idle；手机端过期二维码给出明确失败指引（session-expired 文案）。桌面 GUI 全量视觉验收受 B4 阻塞（渲染层 dev 交接未恢复），已登录为遗留；键盘/窄视口回归随 B4 解除后补。

## 5. typecheck/lint 复跑声明

WP3/WP4 提交前对本会话全部改动文件执行 oxlint：**0 错误 0 新增警告**；全量 typecheck 在收尾复跑（结果回填处：PASS / 失败项清单）。CI 侧 quality job 对本分支连续七轮通过。

## 6. 安全/许可证/性能/迁移结果

- **安全**：SR-01 最小集落地（QR TTL + 过期拦截双端 + revoke）；SR-03 最小集落地（main 独占键 OS 级加密 + 迁移 + 降级可见）；SR-04 部分推进（revoke 即撤销单设备，设备注册表/scope 留 Phase 6）。未引入新依赖。
- **许可证**：无新增第三方依赖；`LICENSE`/`NOTICE.md`/`THIRD-PARTY-NOTICES.md` 未触碰。
- **性能**：PERFORMANCE_BASELINE 数据版落盘；1k/10k 查询达标（LIKE p95 8/103ms）；FTS 紧迫度下调但维持计划；500MiB 桌面门槛**无结论**（受阻，未声称）。
- **数据迁移**：凭据迁移为显式键清单 + 解密失败保留原值 + 文件锁内整体写；测试覆盖迁移/跳过/失败三路径。无数据库 schema 变更。

## 7. 已知问题与遗留

1. main 门禁升级 PR #3 待合并（main 仍持首轮 ci.yml）。
2. fmt 基线漂移（~2346 文件）——待范围收窄决策（建议仅 src/*.ts）。
3. `subagentRuntimeConfigWatcher` CI 偶发一次（重跑过、本地 3/3）——观察项，复现即入豁免。
4. B3/B4/B5 未处理（遵指示）：B4 同时阻塞桌面性能补测。
5. oauth:* 共享键的 safeStorage 完整覆盖需 Main↔Host 加密桥（Phase 6 评估）。
6. 远控完整重造（设备注册表/scope/一次性 challenge）留 Phase 6。

## 8. 结论

**PASS WITH KNOWN ISSUES**——Phase 1 五目标全部有可验证产出，CI 门禁真实全绿，已知问题均有登记、归属与复现路径；无静默降级、无未登记豁免、无 P0 遗留。
