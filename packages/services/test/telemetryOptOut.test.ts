// 遥测 opt-out 门控测试（安全审计 SR-07）：开关关闭时事件不出网；
// 开关解析失败 fail-open（与未注入一致）；开启时正常上报。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createTelemetryCore } from "#src/telemetry/telemetryCore.js";

const homes: string[] = [];
const servers: Array<import("node:http").Server> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function startCollector(): Promise<{
  port: number;
  requests: Array<{ url: string }>;
}> {
  const requests: Array<{ url: string }> = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* 消费请求体即可，不需要内容。 */
    }
    requests.push({ url: request.url ?? "" });
    response.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  servers.push(server);
  return { port: address.port, requests };
}

function makeContext() {
  return { clientTimezone: "UTC", clientLanguage: "en-US", screenResolution: "1x1" };
}

describe("telemetry opt-out gate (SR-07)", () => {
  it("开关关闭时 reportEvent 不产生任何出网请求", async () => {
    const { port, requests } = await startCollector();
    const homeDir = await mkdtemp(join(tmpdir(), "telemetry-optout-"));
    homes.push(homeDir);
    const core = createTelemetryCore({
      homeDir,
      isTelemetryEnabled: () => false,
      resolveZCodeEndpointOrigin: () => `http://127.0.0.1:${port}`,
    });
    await core.reportEvent({
      context: makeContext(),
      elementName: "app_login_ck",
      eventRegion: "app",
      eventType: "ck",
      eventExtraDetail: {},
    });
    expect(requests).toHaveLength(0);
  });

  it("开关解析失败时 fail-open 照常上报", async () => {
    const { port, requests } = await startCollector();
    const homeDir = await mkdtemp(join(tmpdir(), "telemetry-optout-failopen-"));
    homes.push(homeDir);
    const core = createTelemetryCore({
      homeDir,
      isTelemetryEnabled: () => {
        throw new Error("settings read failure");
      },
      resolveZCodeEndpointOrigin: () => `http://127.0.0.1:${port}`,
    });
    await core.reportEvent({
      context: makeContext(),
      elementName: "app_login_ck",
      eventRegion: "app",
      eventType: "ck",
      eventExtraDetail: {},
    });
    expect(requests).toHaveLength(1);
  });

  it("开关开启时正常上报", async () => {
    const { port, requests } = await startCollector();
    const homeDir = await mkdtemp(join(tmpdir(), "telemetry-optout-on-"));
    homes.push(homeDir);
    const core = createTelemetryCore({
      homeDir,
      isTelemetryEnabled: () => true,
      resolveZCodeEndpointOrigin: () => `http://127.0.0.1:${port}`,
    });
    await core.reportEvent({
      context: makeContext(),
      elementName: "app_login_ck",
      eventRegion: "app",
      eventType: "ck",
      eventExtraDetail: {},
    });
    expect(requests).toHaveLength(1);
  });
});
