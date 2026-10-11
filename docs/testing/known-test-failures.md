# 已知测试失败清单（Windows 基线）

> 数据来源：
> ① `docs/baseline/测试报告.md`（2026-10-12，commit `aac47556`，本机 Windows 11 build 22631 / Node 24.19.0 / pnpm 10.33.2）；
> ② CI 首跑 run `38164826815`（2026-10-12，GH windows-latest / Node 24.21.0，豁免参数被 pnpm 吞掉 → 全量暴露）。
> 用途：CI（`.github/workflows/ci.yml` unit job 经 `pnpm test:unit:ci` 脚本）以 `--exclude` 豁免本清单中标"CI 豁免"的文件；每项豁免必须与本清单同步，并有修复计划。
> 规则：清单只收"已登记、已归因"的失败；新失败一律先归因再决定豁免或修复，不允许未登记的静默豁免。

## 分类口径

- **真实失败**：业务逻辑断言失败，平台无关，必须修复，不得豁免。
- **环境失败**：运行环境资源/时序/权限导致（慢机超时、流超时、FS 竞态、命名管道、服务管理器），代码本身无缺陷。
- **已知兼容问题**：平台/区域差异（POSIX 路径、盘符 URL、8.3 短路径名、NSIS 编码、控制台代码页）。

## 重要机制发现（CI 实证）

1. **unit 测试依赖已构建的 workspace 包**：`@zcode/e2e-report`、`@zcode/adapters/storage` 等以构建产物（dist）为解析入口，仅 `pnpm install` 会在 vitest 收集阶段直接失败（4 个 suite）。CI unit job 已加 `pnpm build` 前置步骤；本地开发依赖 bootstrap 构建过。
2. **豁免必须落在 vitest 配置层**：CLI `pnpm test:unit --exclude X` 的参数会被 pnpm 自身吞掉；即使绕过 pnpm 直接传给 vitest 4，在项目级 `test.exclude` 存在时 CLI `--exclude` 也不会叠加生效（CI run 38169542960 / 38171747978 两轮实证）。最终方案：`vitest.ci.config.ts` 从基线 `vitest.config.ts` 单点派生，向 unit 项目的 exclude 叠加本清单，`test:unit:ci` 以 `--config` 引用。
3. **desktop 构建的 Gen UI vendor 校验要求 checkout 字节一致**：GH Windows runner 预置 `core.autocrlf=true` 会转换未声明换行策略的文件，已在 `.gitattributes` 将 `apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/**` 标记为 `-text`（run 38169542960 实证修复）。
4. **vitest 位置参数过滤器可绕过 exclude**（本机实证：`pnpm test:unit:ci <文件名>` 会重新收集被豁免文件）——本地按名过滤调试时注意，这不影响 CI（无位置参数）。

## CI 豁免清单（`test:unit:ci`，共 10 文件）

| # | 测试文件 | 失败表现 | 分类 | 归因 | 处置 |
|---|---|---|---|---|---|
| 1 | `packages/desktop/test/desktopMainIpcRemoteTelemetry.test.ts` | 断言 openExternal 以 POSIX 路径 `'/tmp/secret'` 调用，0 次（本机与 CI 均失败） | 已知兼容问题 | POSIX 路径语义 | Phase 2 改为平台无关路径断言后恢复 |
| 2 | `packages/desktop/test/desktopMainIpcRemoteOpenExternalFile.test.ts` | `file:///tmp/...`、`file://server/share` 分流断言失败（本机与 CI 均失败，2 用例） | 已知兼容问题 | POSIX/UNC 路径语义 | 同上 |
| 3 | `packages/desktop/test/subagentConfigProxy.test.ts` | `ERR_UNSUPPORTED_ESM_URL_SCHEME: protocol 'd:'`（本机与 CI 均失败，2 用例） | 已知兼容问题 | Windows 盘符路径未转 file:// URL | 登记豁免；修复点在测试的模块加载方式 |
| 4 | `packages/desktop/test/windowsInstallerNshSmoke.test.ts` | 本机：makensis 编码错误；CI（run 38164826815）：`installer could not read shortcut target`（安装后读快捷方式失败） | 环境失败 | 两环境失败模式不同——NSIS 冒烟对编码与交互会话敏感 | 登记豁免；该测试验证安装器快捷方式语义，Phase 2 评估改造为独立 job |
| 5 | `packages/desktop/test/desktopAgentBytecode.test.ts` | 期望 `C:\Users\runneradmin\...` 实得 `C:\Users\RUNNER~1\...`（仅 CI 失败，本机通过） | 已知兼容问题 | GH runner 的 TEMP 含 8.3 短路径名，断言未做路径规范化 | 登记豁免；修复方向为断言前 `realpath` 归一化 |
| 6 | `packages/provider-node/test/bundled-config-replacement.test.ts` | `EPERM: rename` 并发原子写竞态（仅 CI） | 环境失败 | Windows FS rename 与并发锁竞态，CI runner 上更易触发 | 登记豁免；观察是否稳定复现 |
| 7 | `packages/services/test/skillsService.test.ts` | 期望含 `RUNNER~1` 短路径、实得 `runneradmin` 长路径（仅 CI） | 已知兼容问题 | 同 #5，8.3 短名 vs 长名 | 同 #5 |
| 8 | `packages/zcode-server-cli/test/cli.test.ts` | `connect ENOENT \\.\pipe\zcode-server-*`（6 用例，仅 CI；本机通过） | 环境失败 | 命名管道服务端未就绪/连接时序在 CI 上失败 | 登记豁免；修复方向为管道就绪等待 |
| 9 | `packages/zcode-server-cli/test/daemonRegistration.test.ts` | 服务管理器不可用时命令序列为空（仅 CI） | 环境失败 | GH runner 无预期服务管理器行为 | 登记豁免 |
| 10 | `packages/zcode-server-cli/test/releaseDownload.test.ts` | 流 idle timeout AbortError（本机与 CI 均失败） | 环境失败 | idle 超时时序敏感 | 登记豁免；复跑确认稳定性 |

**真实失败：0 项**——本机基线与 CI 首跑均未发现平台无关的业务逻辑断言失败；typecheck（13 项目）与 lint（0 错误）全绿。

## 本机失败但 CI 通过（不在 CI 豁免清单，CI 照常执行）

| 测试文件 | 本机表现 | CI 表现 | 说明 |
|---|---|---|---|
| `packages/desktop/test/windowsInstallerCompile.test.ts` | makensis `Bad text encoding`（中文代码页） | 通过（CI 首跑无失败记录） | CI 为英文区域 runner；本机问题待上游修 fixture 编码 |
| `packages/desktop/test/powershell-command.test.ts` | deep-equal 不匹配（代码页） | 通过 | 同上 |
| `packages/provider/test/m2-completion-boundary.test.ts` | 30s 超时（本机实跑 114.7s） | 通过（CI runner 更快） | 慢机超时，保留观察 |

## 更新规则

- 修改 `package.json` 的 `test:unit:ci` 豁免必须同步本清单（含归因与处置计划）。
- 非 Windows runner（如未来接入 ubuntu unit job）不得沿用本豁免清单，需独立归因。
- #6/#8/#9/#10 属环境失败：CI 稳定复现期间保留豁免；上游修复后按条目恢复门禁覆盖。
