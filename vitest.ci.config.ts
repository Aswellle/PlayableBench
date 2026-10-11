import { defineConfig } from "vitest/config";
// CI 专用测试配置：继承仓库基线 vitest.config.ts，仅向 unit 项目叠加
// docs/testing/known-test-failures.md 登记的 Windows 平台豁免清单。
//
// 为什么不用 CLI --exclude：CI run 38169542960 / 38171747978 实证，
// vitest 4（4.1.4）在项目级 test.exclude 存在时，CLI --exclude 不会叠加生效
// （e2e 排除来自配置文件所以一直生效，CLI 追加的文件级排除全部被忽略，
// pnpm 命令行传参还会被 pnpm 自身吞掉）。豁免必须落在配置层。
// 本文件与基线 vitest.config.ts 单点派生，避免复制维护两份 include/alias。
import baseConfig from "./vitest.config";

// 与 docs/testing/known-test-failures.md 的"CI 豁免清单"保持同步：
// 每一项均有登记归因（环境失败/已知兼容问题），修复后从此处与清单同时移除。
const knownTestFailures = [
  "packages/desktop/test/desktopAgentBytecode.test.ts",
  "packages/desktop/test/desktopMainIpcRemoteOpenExternalFile.test.ts",
  "packages/desktop/test/desktopMainIpcRemoteTelemetry.test.ts",
  "packages/desktop/test/subagentConfigProxy.test.ts",
  "packages/desktop/test/windowsInstallerNshSmoke.test.ts",
  "packages/provider-node/test/bundled-config-replacement.test.ts",
  "packages/services/test/skillsService.test.ts",
  "packages/zcode-server-cli/test/cli.test.ts",
  "packages/zcode-server-cli/test/daemonRegistration.test.ts",
  "packages/zcode-server-cli/test/releaseDownload.test.ts",
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: baseConfig.test.projects.map((project) => {
      if (project.test?.name !== "unit") {
        return project;
      }
      return {
        ...project,
        test: {
          ...project.test,
          exclude: [...(project.test.exclude ?? []), ...knownTestFailures],
        },
      };
    }),
  },
});
