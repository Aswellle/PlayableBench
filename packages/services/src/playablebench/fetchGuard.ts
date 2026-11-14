// Feed 抓取 SSRF 防线（spec 08 §6、spec 11 T2、07 裁决 SR-08 第一天内置）。
// 控制全链路：scheme 白名单（http/https）→ 字面量 IP/主机名分类拒绝（loopback/
// 私网/link-local/云 metadata/保留段）→ DNS 解析全地址校验并钉定 IP（防
// rebinding 的解析-连接竞态）→ 重定向逐跳重新校验 → 连接/总超时、响应体上限。
// 代理环境不豁免校验（spec 08 §6）；测试仅可放行 loopback（allowLoopbackForTest），
// 私网/metadata 段在任何模式下都拒绝，保证测试里的逐跳 SSRF 断言真实有效。
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import net from "node:net";

const FORBIDDEN_SCHEMES = new Set(["file:", "javascript:", "data:", "vbscript:", "blob:"]);
const METADATA_IPV4 = "169.254.169.254";
const METADATA_IPV6 = "fd00:ec2::254";

export type FetchGuardErrorKind =
  | "invalid_url"
  | "ssrf_forbidden_scheme"
  | "ssrf_forbidden_host"
  | "ssrf_dns_failure"
  | "timeout"
  | "response_too_large"
  | "too_many_redirects"
  | "http_error";

export class FetchGuardError extends Error {
  constructor(
    readonly kind: FetchGuardErrorKind,
    message: string,
    readonly detail?: { status?: number; retryAfterSeconds?: number; url?: string },
  ) {
    super(message);
    this.name = "FetchGuardError";
  }
}

/** IPv4 点分十进制 → 数值；非法返回 null。 */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const value = parseIpv4(ip);
  if (value === null) return false;
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (base === undefined) return false;
  const baseValue = parseIpv4(base);
  if (baseValue === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) === (baseValue & mask));
}

const FORBIDDEN_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

const LOOPBACK_IPV4_CIDRS = ["127.0.0.0/8", "0.0.0.0/8"];

/** IPv6 展开为 8 组 16 位十六进制；非法返回 null。 */
function expandIpv6(ip: string): Array<number> | null {
  if (!ip.includes(":")) return null;
  let text = ip;
  let tail: Array<number> = [];
  const embedded = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const v4 = parseIpv4(embedded[2] ?? "");
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = embedded[1] ?? "";
  }
  const parts = text.split("::");
  if (parts.length > 2) return null;
  const parseGroups = (raw: string): Array<number> | null => {
    if (raw === "") return [];
    const groups = raw.split(":");
    const parsed: Array<number> = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      parsed.push(parseInt(group, 16));
    }
    return parsed;
  };
  // embedded v4 前的段可能以冒号结尾（如 "::ffff:"）：去掉一个尾空组再解析。
  if (tail.length > 0 && (parts[1] ?? "").endsWith(":")) {
    parts[1] = (parts[1] ?? "").slice(0, -1);
  }
  const left = parseGroups(parts[0] ?? "");
  if (left === null) return null;
  const right = parts.length === 2 ? parseGroups(parts[1] ?? "") : [];
  if (right === null) return null;
  const fill = 8 - left.length - right.length - tail.length;
  if (fill < 0 || (parts.length === 1 && fill !== 0)) return null;
  return [...left, ...Array<number>(fill).fill(0), ...right, ...tail];
}

function ipv6InPrefix(groups: Array<number>, prefixBits: number, prefixFirstWord: number): boolean {
  if (prefixBits <= 0) return true;
  if (prefixBits <= 16) {
    const mask = 0xffff << (16 - prefixBits);
    return (groups[0]! & mask) === (prefixFirstWord & mask);
  }
  return groups[0] === prefixFirstWord;
}

function groupMatches(groups: Array<number>, candidates: Array<Array<number>>): boolean {
  return candidates.some((c) => groups.length === c.length && groups.every((g, i) => g === c[i]));
}

function ipv6IsForbidden(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) return false;
  // 未指定地址。
  if (groupMatches(groups, [[0, 0, 0, 0, 0, 0, 0, 0]])) return true;
  // IPv4-mapped（::ffff:a.b.c.d）与 NAT64（64:ff9b::/96）内嵌 v4 逐段校验。
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0) {
    if (groups[5] === 0xffff || (groups[5] === 0x64 && groups[6] === 0xff9b)) {
      const v4 = `${(groups[6]! >> 8) & 0xff}.${groups[6]! & 0xff}.${(groups[7]! >> 8) & 0xff}.${groups[7]! & 0xff}`;
      return ipv4ForbiddenClassification(v4) !== "none";
    }
  }
  if (groupMatches(groups, [[0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254]])) return true;
  if (ipv6InPrefix(groups, 7, 0xfc00)) return true; // unique local
  if (ipv6InPrefix(groups, 10, 0xfe80)) return true; // link local
  if (ipv6InPrefix(groups, 16, 0x2002)) {
    // 6to4 内嵌 v4。
    const v4 = `${(groups[1]! >> 8) & 0xff}.${groups[1]! & 0xff}.${(groups[2]! >> 8) & 0xff}.${groups[2]! & 0xff}`;
    return ipv4ForbiddenClassification(v4) !== "none";
  }
  if (ipv6InPrefix(groups, 16, 0x2001)) {
    // Teredo（2001::/32）内嵌 v4（混淆端口，按原值保守校验）。
    if (groups[1] === 0 && groups[2] !== 0 && groups[3] !== 0) {
      const v4 = `${(groups[2]! >> 8) & 0xff}.${groups[2]! & 0xff}.${(groups[3]! >> 8) & 0xff}.${groups[3]! & 0xff}`;
      return ipv4ForbiddenClassification(v4) !== "none";
    }
  }
  if (groups[0]! >= 0xff00) return true; // multicast/reserved
  return false;
}

export type IpForbiddenClass = "loopback" | "private" | "none";

/** IPv4 禁用分类；loopback 单列以便测试模式最小放行。 */
export function ipv4ForbiddenClassification(ip: string): IpForbiddenClass {
  if (LOOPBACK_IPV4_CIDRS.some((cidr) => ipv4InCidr(ip, cidr))) return "loopback";
  if (ip === METADATA_IPV4 || FORBIDDEN_IPV4_CIDRS.some((cidr) => ipv4InCidr(ip, cidr))) return "private";
  return "none";
}

export function isForbiddenIpAddress(ip: string, options?: { allowLoopback?: boolean }): IpForbiddenClass {
  if (net.isIPv4(ip)) {
    const classification = ipv4ForbiddenClassification(ip);
    if (classification === "loopback" && options?.allowLoopback) return "none";
    return classification;
  }
  if (net.isIPv6(ip)) {
    if (ip === "::1" || ip === "::") {
      return options?.allowLoopback ? "none" : "loopback";
    }
    return ipv6IsForbidden(ip) ? "private" : "none";
  }
  return "private";
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

export interface UrlGuardOptions {
  allowLoopback?: boolean;
}

/** URL 校验（spec 08 §6）：scheme 白名单 + 字面量 IP/主机名分类；返回规范化 URL。 */
export function assertFetchableUrl(rawUrl: string, options?: UrlGuardOptions): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchGuardError("invalid_url", `URL 无法解析: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    if (FORBIDDEN_SCHEMES.has(url.protocol)) {
      throw new FetchGuardError("ssrf_forbidden_scheme", `禁止的协议: ${url.protocol}`, { url: rawUrl });
    }
    throw new FetchGuardError("ssrf_forbidden_scheme", `仅允许 http/https: ${url.protocol}`, { url: rawUrl });
  }
  if (url.username || url.password) {
    throw new FetchGuardError("ssrf_forbidden_host", "URL 不应携带凭据（userinfo）", { url: rawUrl });
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    if (!options?.allowLoopback) {
      throw new FetchGuardError("ssrf_forbidden_host", `禁止访问本机地址: ${hostname}`, { url: rawUrl });
    }
  } else if (net.isIP(hostname)) {
    const classification = isForbiddenIpAddress(hostname, options);
    if (classification !== "none") {
      throw new FetchGuardError("ssrf_forbidden_host", `禁止访问受限地址: ${hostname}`, { url: rawUrl });
    }
  }
  return url;
}

export interface GuardedFetchResult {
  status: number;
  bodyText: string;
  finalUrl: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  retryAfterSeconds?: number;
}

export interface GuardedFetchOptions {
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowLoopback?: boolean;
  headers?: Record<string, string>;
}

interface FetchAttemptOptions extends GuardedFetchOptions {
  hopsUsed: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TOTAL_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;

function collectBody(
  response: http.IncomingMessage,
  maxBytes: number,
  deadlineAt: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    response.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        reject(new FetchGuardError("response_too_large", `响应体超过上限 ${maxBytes} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    response.on("error", reject);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      response.destroy();
      reject(new FetchGuardError("timeout", "总超时"));
    }
  });
}

function requestOnce(
  target: URL,
  pinnedIp: string,
  options: GuardedFetchOptions,
  deadlineAt: number,
  redirectCount: number,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; bodyText: string; location?: string }> {
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: "GET",
        // DNS 校验 + IP 钉定：连接只使用校验通过的地址（防 rebinding）。
        lookup: (
          _hostname: string,
          lookupOptions: unknown,
          callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
        ) => {
          callback(null, pinnedIp, net.isIP(pinnedIp) === 6 ? 6 : 4);
        },
        headers: {
          "user-agent": "PlayableBench-Feed/1.0",
          "accept-encoding": "identity",
          ...extraHeaders,
        },
        timeout: Math.min(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, Math.max(1, deadlineAt - Date.now())),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          resolve({ status, headers: response.headers, bodyText: "", location: response.headers.location });
          return;
        }
        void collectBody(response, options.maxBytes ?? DEFAULT_MAX_BYTES, deadlineAt)
          .then((bodyText) => resolve({ status, headers: response.headers, bodyText }))
          .catch(reject);
      },
    );
    request.on("timeout", () => {
      request.destroy(new FetchGuardError("timeout", "连接超时"));
    });
    request.on("error", (error) => {
      reject(error instanceof FetchGuardError ? error : new FetchGuardError("http_error", String(error.message ?? error)));
    });
    request.end();
    void redirectCount;
  });
}

/** 带防线的 GET：逐跳校验、DNS 钉定、资源上限；4xx/5xx 以状态返回由调用方决策。 */
export async function guardedFetch(url: string, options: GuardedFetchOptions = {}): Promise<GuardedFetchResult> {
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadlineAt = Date.now() + totalTimeoutMs;
  let current = assertFetchableUrl(url, options);
  let hops = 0;
  for (;;) {
    // 每跳重新校验（重定向可能指向任意目标）。
    current = assertFetchableUrl(current.toString(), options);
    const hostname = current.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    let pinnedIp: string;
    if (net.isIP(hostname)) {
      pinnedIp = hostname;
    } else {
      const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        dnsLookup(hostname, { all: true, verbatim: true }, (error, results) => {
          if (error) reject(new FetchGuardError("ssrf_dns_failure", `DNS 解析失败: ${hostname}`));
          else resolve(results);
        });
      });
      if (addresses.length === 0) {
        throw new FetchGuardError("ssrf_dns_failure", `DNS 无可用地址: ${hostname}`);
      }
      for (const entry of addresses) {
        const classification = isForbiddenIpAddress(entry.address, options);
        if (classification !== "none") {
          throw new FetchGuardError("ssrf_forbidden_host", `解析到受限地址 ${entry.address}（${hostname}）`);
        }
      }
      pinnedIp = addresses[0]!.address;
    }
    if (Date.now() >= deadlineAt) {
      throw new FetchGuardError("timeout", "总超时");
    }
    const attempt = await requestOnce(current, pinnedIp, options, deadlineAt, hops, options.headers ?? {});
    if ([301, 302, 303, 307, 308].includes(attempt.status)) {
      if (!attempt.location) {
        throw new FetchGuardError("http_error", `重定向缺少 Location（${attempt.status}）`);
      }
      if (hops >= maxRedirects) {
        throw new FetchGuardError("too_many_redirects", `重定向超过上限 ${maxRedirects}`);
      }
      hops += 1;
      current = new URL(attempt.location, current);
      continue;
    }
    const retryAfterRaw = attempt.headers["retry-after"];
    const retryAfterSeconds =
      typeof retryAfterRaw === "string" && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : undefined;
    return {
      status: attempt.status,
      bodyText: attempt.bodyText,
      finalUrl: current.toString(),
      contentType: typeof attempt.headers["content-type"] === "string" ? attempt.headers["content-type"] : undefined,
      etag: typeof attempt.headers.etag === "string" ? attempt.headers.etag : undefined,
      lastModified: typeof attempt.headers["last-modified"] === "string" ? attempt.headers["last-modified"] : undefined,
      retryAfterSeconds,
    };
  }
}
