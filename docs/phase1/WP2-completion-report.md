# Phase 1 · WP2 完成报告（CI 与质量门禁建设）

> 日期：2026-10-12 ~ 2026-11-12 · 基线 commit `aac47556` · 工作分支 `phase1/wp2-ci-workflow`（HEAD `55b9dd2c`，已推送）。
> 结论：**PASS WITH KNOWN ISSUES**——CI 六轮联调后三 job 全绿（run `43073576994`）；遗留项为 main 门禁升级 PR、fmt 基线漂移决策与一个已登记的 watcher 偶发观察项（见 §5）。

## 1. 修改文件列表

**初始交付**（commit `026b4e51`/`3d508c41`/`f5a3f92b`/`4715376a`）：

| 文件 | 变更 | 目的 |
|---|---|---|
| `packages/web-share/vite.config.ts` | 删除指向单文件的 `@zcode/shared` 别名（附中文修复注释） | **B1 修复**：子路径导出改走 package.json exports 解析 |
| `.oxfmtrc.json` | `ignorePatterns` 增加 `docs/electron/docs/fiddles/**` | **B2 修复**：vendored 文档示例的 HTML 语法错误不再阻断 oxfmt |
| `.github/workflows/ci.yml` | 新增（quality/unit/build 三 job） | 工程质量护栏 |
| `docs/testing/known-test-failures.md` | 新增 | Windows 平台已知失败清单 |

**CI 联调修复轮**（commit `3722dffd`/`9c9c8a4a`/`0bdae08d`/`daef5d0c`/`55b9dd2c`，每轮根因见 §3）：

| 文件 | 变更 | 目的 |
|---|---|---|
| `.github/workflows/ci.yml` | unit job 加 `pnpm build` 前置；测试步骤 env `ZCODE_TEST_POOL=forks` | 收集期解析失败、worker 堆 OOM |
| `.gitattributes` | `apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/** -text -whitespace` | vendored 资产按字节保存，防 autocrlf 破坏 sha256 校验 |
| `vitest.ci.config.ts` | 新增：从基线 `vitest.config.ts` 单点派生，unit 项目 exclude 叠加豁免清单 | CLI `--exclude` 在配置层 exclude 存在时不生效 |
| `package.json` | `test:unit:ci` 脚本（`vitest run --config vitest.ci.config.ts`） | CI 专用测试入口 |
| `docs/testing/known-test-failures.md` | 六轮迭代的归因更新 + 机制发现 + 观察项 | 豁免清单与 CI 同步维护 |

**未触碰**：Agent Runtime（apps/zcode-cli）、业务功能、UI、数据库模型、产品功能——与授权边界一致（B3/B4/B5 未处理，遵指示）。

## 2. CI 设计（.github/workflows/ci.yml）

| Job | Runner | 内容 | 本地等价验证 |
|---|---|---|---|
| quality | ubuntu-latest | Node 读 `.nvmrc` → pnpm（读 packageManager 字段）→ `pnpm install --frozen-lockfile` → `typecheck` → `lint` → `architecture:check --changed` | typecheck PASS（13 项目）/ lint PASS（0 错误）已在 WP1 本机验证；architecture:check 沿用 verify:pre-push 口径 |
| unit | windows-latest | `pnpm test:unit --exclude <8 个已登记文件>` | WP1 基线：豁免后等效于 1917/1928 文件通过（见 known-test-failures.md） |
| build | ubuntu-latest | `pnpm build`（递归全 workspace；desktop 无独立 build 脚本部分随包执行） | **本机 Windows 实测 exit 0（15.2 min）**，含 web/web-share/server/desktop renderer |

- 触发：push + pull_request + 手动；同 ref 并发取消；三 job 各带超时（30/75/60 min）与 pnpm store 缓存。
- **fmt:check 未纳入门禁**（决策记录于 workflow 注释）：修复解析错误后暴露出**上游格式基线漂移——约 2346 个文件与 oxfmt 0.41.0/0.47.0 的判定均不一致**（oxfmt 0.41.0 为 lockfile 锁定版本；`git diff` 确认 lockfile 未被本会话改动）。批量重排违反 spec 04「禁止全局格式化噪声」，且上游 CI 从未门禁过 fmt（verify:pre-push 不含此项）。此为新增发现，列入 §5 待决策。

## 3. CI 运行结果（真实执行记录）

最终状态：**run `43073576994`（重跑后）三 job 全绿**——quality（typecheck·lint·architecture）✅、unit（windows / forks 池 / 1918 文件 / 18039 用例）✅、build（递归全仓）✅。工作分支 `phase1/wp2-ci-workflow`（HEAD `55b9dd2c`）。

六轮迭代实录（每轮失败均定位到根因并修复）：

| 轮次 | run | 结果 | 根因 → 修复 |
|---|---|---|---|
| 1 | `38164826815` | quality ✅ build ✅ unit ❌ | ①unit 测试依赖已构建包入口（@zcode/e2e-report、@zcode/adapters/storage 收集期解析失败）→ unit job 加 `pnpm build` 前置；②CLI `--exclude` 被 pnpm 吞掉 → 豁免内建脚本 |
| 2 | `38169542960` | unit ❌（构建步骤） | GH Windows runner 预置 `core.autocrlf=true`，checkout 转换未声明换行策略的 vendored Gen UI 资产 → manifest sha256 失配 → `.gitattributes` 标记 `-text` |
| 3 | `38171747978` | unit ❌（16 失败） | 豁免清单内文件照跑：vitest 4 在项目级 `test.exclude` 存在时 CLI `--exclude` 不叠加生效（e2e 排除来自配置所以一直有效）→ 新建 `vitest.ci.config.ts` 从基线配置单点派生叠加豁免，`test:unit:ci` 改 `--config` 引用 |
| 4 | `38179220502` | unit ❌（0 用例失败） | 17926 用例全过后 threads worker 收尾堆 OOM（ERR_WORKER_OUT_OF_MEMORY）→ NODE_OPTIONS=6144 |
| 5 | `38181939996` | unit ❌（2 失败+OOM） | NODE_OPTIONS 对 worker_threads 堆上限不生效 → 切换仓库自带 `ZCODE_TEST_POOL=forks` 进程隔离 |
| 6 | `43073576994` | unit ❌ 1 项 → **重跑全绿** | `subagentRuntimeConfigWatcher` 大小写改名 watcher 偶发（本地 3/3 通过、重跑通过）→ 登记为 known-test-failures 观察项，未豁免 |

**本地等价验证**（每轮修复后）：`pnpm build` exit 0（15.2 min）；`pnpm test:unit:ci` 1918 文件 = 1928-10 精确豁免，余 5 失败均为已登记本机项/本机网络时序项。

**运维提示**：
- 本机网络对 api.github.com 间歇干扰（DNS 污染/301、EOF），gh 调用需重试；git push 偶发假失败（断连时推送实际已落盘），以 `gh run list` 为准。
- 首跑、二跑失败日志曾贴于会话；全部根因与机制发现已沉淀至 `docs/testing/known-test-failures.md`「重要机制发现」。

**激活 main 门禁（待办）**：main 当前仍持有未修复版 ci.yml（PR #2 合入的是首轮版本）。将 `phase1/wp2-ci-workflow`（含 5 个修复 commit：`3722dffd`/`9c9c8a4a`/`0bdae08d`/`daef5d0c`/`55b9dd2c`）向 main 发起 PR 并合并，main 门禁即为全绿版本。

## 4. 测试结果（本会话实际执行）

| 项 | 结果 |
|---|---|
| `pnpm --filter @zcode/web-share build` | **PASS**（41.4s，B1 直接验证） |
| `pnpm build`（全仓递归，= CI build 命令） | **PASS**（exit 0，15.2 min，B1 全量规模验证） |
| `oxlint packages/web-share/vite.config.ts` | PASS（0 警告 0 错误） |
| `pnpm fmt:check` | 解析错误已消除（B2 修复生效）；余 2346 文件格式漂移（上游基线问题，见 §2/§5） |
| `git push`（B1/B2/docs） | PASS |
| `git push`（ci.yml） | **BLOCKED**（OAuth scope，§3） |

## 5. 未解决问题与风险评估

**未解决（按影响排序）**：
1. **main 门禁待升级**：main 仍持有首轮版 ci.yml（PR #2 合入），需将 `phase1/wp2-ci-workflow`（5 个修复 commit）向 main 发 PR 合并，main 门禁才升级为全绿版本。
2. **fmt 基线漂移（约 2346 文件）**：上游提交内容与 oxfmt（0.41/0.47 均验证）判定不一致，批量重排违反 spec 04「禁止全局格式化噪声」。决策选项：a) 永久不门禁 fmt（现状）；b) 一次性全量 `pnpm fmt`（需特批）；c) 收窄 fmt 范围（仅 src/*.ts，**建议**）。Phase 2 处理。
3. **watcher 偶发失败观察项**：`subagentRuntimeConfigWatcher` 六轮中首跑出现一次（重跑通过、本地 3/3）——未豁免保持覆盖；复现即入豁免清单并归因。
4. B3（dev:server Windows 引号）/B4（本机回环网络）/B5（licenses EMFILE）按指示未处理。

**风险评估**：
- 豁免清单存在"豁免即盲区"的固有风险——当前 10 文件占测试面 0.5%，全部有归因与处置计划；`known-test-failures.md` 强制"新豁免必须同步归因"缓解漂移。
- forks 池（maxWorkers=2）使 unit job 耗时增加（~33 min vs threads ~19 min 测试段），换取进程级内存隔离，两轮实证 OOM 消除；超时上限 75 min 内余量充足。
- 本机网络对 api.github.com 间歇干扰——不影响 CI 本身，仅影响本地观察（gh 需重试、git push 假失败需以 run list 为准）。
- `architecture:check --changed` 已在六轮 CI 中实际执行并通过（quality job 连续六绿），此前"可能暴露存量违规"的担忧解除。

## 6. 下一步（Phase 1 剩余工作包）

WP3 远控 P0 修复 → WP4 凭据存储改造 → WP5 性能基准；CI 结果已回填至本报告 §3。前置待办：将本分支向 main 发 PR 合并，使 main 门禁升级为全绿版本。
