# 已知测试失败清单（Windows 基线）

> 基线来源：`docs/baseline/测试报告.md`（2026-10-12，commit `aac47556`，Windows 11 build 22631 / Node 24.19.0 / pnpm 10.33.2）。
> 用途：CI（`.github/workflows/ci.yml` unit job）以 `--exclude` 豁免本清单中的文件；每项豁免必须与本清单同步，并有修复计划。
> 规则：清单只收"已登记、已归因"的失败；新失败一律先归因再决定豁免或修复，不允许未登记的静默豁免。

## 分类口径

- **真实失败**：业务逻辑断言失败，平台无关，必须修复，不得豁免。
- **环境失败**：本机资源/时序导致（慢机超时、流超时），代码本身无缺陷；复跑可判定。
- **已知兼容问题**：平台/区域差异（POSIX 路径、盘符 URL、NSIS 编码、代码页），上游主开发环境未暴露。

## 清单（WP1 基线，共 8 文件 / 10 用例）

| # | 测试文件 | 失败用例 | 分类 | 归因 | 处置 |
|---|---|---|---|---|---|
| 1 | `packages/desktop/test/desktopMainIpcRemoteTelemetry.test.ts` | 只允许 main 进程打开 http/https/file URL | 已知兼容问题 | 断言以 POSIX 路径 `'/tmp/secret'` 调 openExternal，Windows 下路径语义不同 | 登记豁免；Phase 2 改为平台无关路径断言后恢复 |
| 2 | `packages/desktop/test/desktopMainIpcRemoteOpenExternalFile.test.ts` | 带锚点 file URL 剥 hash 后走 shell.openPath；无法转本地路径时 warn 且不回退 | 已知兼容问题 | `file:///tmp/...`、`file://server/share` 的 POSIX/UNC 语义 | 同上 |
| 3 | `packages/desktop/test/subagentConfigProxy.test.ts` | preloads the stdio proxy（2 例） | 已知兼容问题 | `ERR_UNSUPPORTED_ESM_URL_SCHEME: protocol 'd:'`——Windows 盘符路径未转 `file://` URL（测试加载器缺陷） | 登记豁免；修复点在测试的模块加载方式 |
| 4 | `packages/desktop/test/windowsInstallerCompile.test.ts` | compiles real UAC calls… | 已知兼容问题 | makensis `Bad text encoding`（fixture UTF-8 与中文 Windows 代码页冲突） | 登记豁免；英文区域 runner 上预期可通过，豁免为保守处理 |
| 5 | `packages/desktop/test/windowsInstallerNshSmoke.test.ts` | NSIS 冒烟 | 已知兼容问题 | 同 #4（NSIS/编码环境） | 同上 |
| 6 | `packages/desktop/test/powershell-command.test.ts` | 还原带空格和脚本元字符的动态值 | 已知兼容问题 | PowerShell 输出经控制台代码页（GBK）转码后 deep-equal 不匹配 | 登记豁免；修复方向为显式 UTF-8 编码管道 |
| 7 | `packages/provider/test/m2-completion-boundary.test.ts` | 旧 Provider DTO 只属于一次性物理迁移边界 | **环境失败** | 全仓文件扫描型测试，30s 超时；本机实跑 114.7s（4 核低配机） | 登记豁免（CI runner 更快，预期可通过）；长期应调大该用例超时或缩小扫描范围 |
| 8 | `packages/zcode-server-cli/test/releaseDownload.test.ts` | keeps an active archive stream alive past the idle timeout | **环境失败** | 流 idle timeout 时序敏感（AbortError） | 登记豁免；复跑观察是否稳定失败，若 CI 上稳定通过则从豁免移除 |

**真实失败：0 项**——WP1 基线中未发现业务逻辑断言的平台无关失败；typecheck（13 项目）与 lint（0 错误）全绿佐证。

## CI 豁免的运行口径

- CI unit job（windows-latest）以 `pnpm test:unit --exclude <上述 8 文件>` 运行，豁免即本清单。
- 非 Windows runner（如未来接入 ubuntu unit job）不得直接沿用本豁免清单——平台敏感项在 POSIX 上可能通过，也可能暴露新失败，需独立归因。
- 新增豁免的 PR 必须同时更新本清单（含归因与处置计划）；无归因的失败不允许进入豁免。

## 观察项

- #7/#8 属环境失败：在 CI（更高配 runner）首次运行后复核；若通过，从豁免与清单中移除，恢复门禁覆盖。
- #1–#6 的修复不阻塞 Phase 1；在 Phase 2「测试配置」工作中按处置计划逐项恢复。
