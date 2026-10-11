import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  resolveBigModelApiOrigin,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "../shared/src/zcodeEndpoint.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
  const endpointEnv = { ...env, ZCODE_ENV: zcodeEnv };
  const endpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const oauthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  const oauthClientId = resolveZaiOAuthClientId(endpointEnv);
  // BigModel 授权入口必须跟随 ZCODE_ENV，否则测试环境会把测试账号带到生产授权页。
  const bigmodelOAuthOrigin = resolveBigModelApiOrigin(endpointEnv);

  return {
    root: resolve(HERE),
    base: "/cn/share/",
    // Share 复用 Web 的 material-icons 素材，但不复制完整 Web 源码/依赖。
    // 这样 dev:web-share 与 Docker 生产构建都从同一份 public 资源读取图标。
    publicDir: resolve(REPO_ROOT, "packages/web/public"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(REPO_ROOT, "packages/ui/src"),
        // 修复原因：@zcode/shared 是本包 workspace 依赖，其 package.json exports 已将
        // 全部子路径映射到真实源文件。此前把别名指到单文件 src/index.ts，导致
        // "@zcode/shared/zcode-protocol-v4" 等子路径被拼接成不存在的
        // "src/index.ts/<subpath>"，build:bootstrap 在本包构建失败（WP1 审计发现 B1）。
        // 删除该别名后，根入口与子路径统一走 exports 解析；@zcode/ui 未安装，仍需显式别名。
        // Share 镜像不安装 @zcode/ui（它会带入 services/rpc 闭包），子路径导入必须显式指向源码。
        "@zcode/ui/useTheme": resolve(REPO_ROOT, "packages/ui/src/useTheme.ts"),
        "@zcode/ui/conversation-share-readonly": resolve(
          REPO_ROOT,
          "packages/share-ui/src/index.ts",
        ),
        // 登录卡片要用 provider 图标（svg 走 @ -> packages/ui/src 别名解析）。
        // 该模块只依赖 shared/lucide/cn，不会把 services/rpc 闭包带进 share 镜像。
        "@zcode/ui/oauth-provider-icon": resolve(
          REPO_ROOT,
          "packages/ui/src/lib/oauthProviderIcon.tsx",
        ),
      },
    },
    define: {
      __ZCODE_VERSION__: JSON.stringify(version),
      __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(endpointOrigin),
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(endpointOrigin),
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(oauthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(oauthOrigin),
      "import.meta.env.VITE_BIGMODEL_OAUTH_ORIGIN": JSON.stringify(bigmodelOAuthOrigin),
    },
    build: {
      outDir: resolve(REPO_ROOT, "packages/web-share/dist"),
      emptyOutDir: true,
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
