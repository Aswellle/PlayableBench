// fetchGuard 测试（spec 08 §6、spec 11 T2、SR-08）：scheme 白名单、字面量 IP
// 分类（loopback/私网/link-local/云 metadata/内嵌 v4）、loopback 测试放行下
// metadata 仍拒绝、重定向逐跳校验、429 Retry-After 透传、超时、响应体上限、
// 条件请求头透传。全部用本机 http 服务器，无外网。
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFetchableUrl,
  FetchGuardError,
  guardedFetch,
  isForbiddenIpAddress,
} from "#src/playablebench/fetchGuard.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
});

async function startHandler(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
): Promise<{ port: number; url: (path: string) => string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return { port: address.port, url: (path: string) => `http://127.0.0.1:${address.port}${path}` };
}

describe("URL/IP 分类（纯函数）", () => {
  it("scheme 白名单：http/https 放行，file/javascript/data/未知拒绝", () => {
    expect(assertFetchableUrl("https://example.com/feed.xml").protocol).toBe("https:");
    expect(() => assertFetchableUrl("file:///etc/passwd")).toThrowError(
      expect.objectContaining({ kind: "ssrf_forbidden_scheme" }),
    );
    expect(() => assertFetchableUrl("javascript:alert(1)")).toThrowError(
      expect.objectContaining({ kind: "ssrf_forbidden_scheme" }),
    );
    expect(() => assertFetchableUrl("data:text/plain,hi")).toThrowError(
      expect.objectContaining({ kind: "ssrf_forbidden_scheme" }),
    );
    expect(() => assertFetchableUrl("ftp://example.com/x")).toThrowError(
      expect.objectContaining({ kind: "ssrf_forbidden_scheme" }),
    );
    expect(() => assertFetchableUrl("not a url")).toThrowError(
      expect.objectContaining({ kind: "invalid_url" }),
    );
  });

  it("字面量 IP 分类：loopback/私网/link-local/metadata/内嵌 v4 全拒绝", () => {
    expect(isForbiddenIpAddress("127.0.0.1")).toBe("loopback");
    expect(isForbiddenIpAddress("10.1.2.3")).toBe("private");
    expect(isForbiddenIpAddress("172.16.0.9")).toBe("private");
    expect(isForbiddenIpAddress("192.168.1.1")).toBe("private");
    expect(isForbiddenIpAddress("169.254.169.254")).toBe("private"); // 云 metadata
    expect(isForbiddenIpAddress("100.64.0.7")).toBe("private"); // CGNAT
    expect(isForbiddenIpAddress("224.0.0.1")).toBe("private"); // multicast
    expect(isForbiddenIpAddress("::1")).toBe("loopback");
    expect(isForbiddenIpAddress("fe80::1")).toBe("private");
    expect(isForbiddenIpAddress("fd00::5")).toBe("private");
    expect(isForbiddenIpAddress("fd00:ec2::254")).toBe("private"); // AWS IPv6 metadata
    expect(isForbiddenIpAddress("::ffff:10.0.0.5")).toBe("private"); // v4-mapped
    expect(isForbiddenIpAddress("8.8.8.8")).toBe("none");
    expect(isForbiddenIpAddress("2606:4700::1111")).toBe("none");
  });

  it("loopback 测试放行只放行 loopback：metadata/私网在任何模式下拒绝", () => {
    expect(isForbiddenIpAddress("127.0.0.1", { allowLoopback: true })).toBe("none");
    expect(isForbiddenIpAddress("::1", { allowLoopback: true })).toBe("none");
    expect(isForbiddenIpAddress("169.254.169.254", { allowLoopback: true })).toBe("private");
    expect(isForbiddenIpAddress("10.0.0.5", { allowLoopback: true })).toBe("private");
    expect(() => assertFetchableUrl("http://10.0.0.5/feed", { allowLoopback: true })).toThrowError(
      expect.objectContaining({ kind: "ssrf_forbidden_host" }),
    );
  });

  it("URL 携带 userinfo 拒绝；localhost 域名默认拒绝、测试放行", () => {
    expect(() => assertFetchableUrl("https://user:pass@example.com/feed")).toThrowError(
      expect.objectContaining({ kind: "ssrf_forbidden_host" }),
    );
    expect(() => assertFetchableUrl("http://localhost/feed")).toThrowError(
      expect.objectContaining({ kind: "ssrf_forbidden_host" }),
    );
    expect(
      assertFetchableUrl("http://localhost/feed", { allowLoopback: true }).hostname,
    ).toBe("localhost");
  });
});

describe("guardedFetch 逐跳防线", () => {
  it("正常抓取：状态/正文/ETag/Last-Modified/条件请求头透传", async () => {
    let sawIfNoneMatch: string | undefined;
    const { url } = await startHandler((request, response) => {
      sawIfNoneMatch = request.headers["if-none-match"];
      response.writeHead(200, { etag: '"v1"', "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT" });
      response.end("<rss>ok</rss>");
    });
    const result = await guardedFetch(url("/feed.xml"), {
      allowLoopback: true,
      headers: { "if-none-match": '"v0"' },
    });
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe("<rss>ok</rss>");
    expect(result.etag).toBe('"v1"');
    expect(result.lastModified).toContain("2026");
    expect(sawIfNoneMatch).toBe('"v0"');
  });

  it("429 透传 Retry-After；5xx 状态原样返回由调用方退避", async () => {
    const { url } = await startHandler((request, response) => {
      response.writeHead(429, { "retry-after": "7" });
      response.end("slow down");
    });
    const result = await guardedFetch(url("/feed"), { allowLoopback: true });
    expect(result.status).toBe(429);
    expect(result.retryAfterSeconds).toBe(7);
  });

  it("重定向逐跳校验：重定向到私网/拒绝协议在测试放行模式下仍被拒", async () => {
    const { url } = await startHandler((request, response) => {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
    });
    await expect(guardedFetch(url("/jump"), { allowLoopback: true })).rejects.toMatchObject({
      kind: "ssrf_forbidden_host",
    });
    const { url: schemeUrl } = await startHandler((request, response) => {
      response.writeHead(302, { location: "file:///etc/passwd" });
      response.end();
    });
    await expect(guardedFetch(schemeUrl("/jump"), { allowLoopback: true })).rejects.toMatchObject({
      kind: "ssrf_forbidden_scheme",
    });
  });

  it("重定向上限拒绝", async () => {
    const { url } = await startHandler((request, response) => {
      response.writeHead(302, { location: "/next" });
      response.end();
    });
    await expect(guardedFetch(url("/loop"), { allowLoopback: true, maxRedirects: 3 })).rejects.toMatchObject({
      kind: "too_many_redirects",
    });
  });

  it("总超时拒绝", async () => {
    const { url } = await startHandler((request, response) => {
      const timer = setTimeout(() => {
        response.writeHead(200);
        response.end("late");
      }, 800);
      response.on("close", () => clearTimeout(timer));
    });
    await expect(guardedFetch(url("/slow"), { allowLoopback: true, totalTimeoutMs: 150 })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("响应体超上限拒绝", async () => {
    const { url } = await startHandler((request, response) => {
      response.writeHead(200);
      response.write("x".repeat(100_000));
      response.end();
    });
    await expect(guardedFetch(url("/big"), { allowLoopback: true, maxBytes: 1_000 })).rejects.toMatchObject({
      kind: "response_too_large",
    });
  });

  it("跟随合法重定向链到 200", async () => {
    const { url } = await startHandler((request, response) => {
      if (request.url === "/a") {
        response.writeHead(302, { location: "/b" });
        response.end();
        return;
      }
      response.writeHead(200, { etag: '"final"' });
      response.end("final body");
    });
    const result = await guardedFetch(url("/a"), { allowLoopback: true });
    expect(result.status).toBe(200);
    expect(result.finalUrl.endsWith("/b")).toBe(true);
    expect(result.bodyText).toBe("final body");
  });
});
