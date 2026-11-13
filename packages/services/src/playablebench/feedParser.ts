// 受限 RSS 2.0 / Atom 解析器（spec 08 §6 资源限制、S4 切片）。
// 安全姿态：不引入 XML 解析依赖（供应链最小面）；文档级拒绝 DOCTYPE/ENTITY
// 声明（防 XXE/实体爆炸——解析器不展开任何自定义实体）；大小/嵌套深度/条目数
// 上限；只做文本提取（HTML 标签剥离 + 五个基础 XML 实体与数字实体解码），
// 不产出 DOM、不执行任何来源内容。
export type FeedParseErrorKind =
  | "empty_document"
  | "too_large"
  | "doctype_forbidden"
  | "entity_forbidden"
  | "too_deep"
  | "too_many_items"
  | "no_feed_structure";

export class FeedParseError extends Error {
  constructor(
    readonly kind: FeedParseErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "FeedParseError";
  }
}

export interface ParseLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxItems?: number;
}

export interface ParsedFeedItem {
  sourceItemId?: string;
  title?: string;
  linkUrl?: string;
  publishedAt?: number;
  author?: string;
  summaryText?: string;
}

export interface ParsedFeed {
  kind: "rss" | "atom";
  title?: string;
  items: ParsedFeedItem[];
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_ITEMS = 500;

const BASIC_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => BASIC_ENTITIES[name] ?? name);
}

/** HTML/富文本 → 纯文本（剥离标签；CDATA 已在外层剥离）。不清洗为可渲染 HTML。 */
function stripTags(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** RFC 822（RSS）与 ISO 8601（Atom）日期 → epoch ms；无效返回 undefined。 */
function parseFeedDate(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 读取元素文本：定位该元素首个开标签（保证层级归属），CDATA 优先、纯文本次之。 */
function readElementText(block: string, tagName: string): string | undefined {
  const openPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "i");
  const openMatch = openPattern.exec(block);
  if (!openMatch) return undefined;
  const rest = block.slice(openMatch.index + openMatch[0].length);
  const cdataMatch = rest.match(/^<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) {
    // CDATA 内常含 HTML；不渲染任何来源 HTML，统一剥标签存纯文本（spec 08 §6）。
    const text = stripTags(decodeXmlEntities(cdataMatch[1] ?? "")).trim();
    return text || undefined;
  }
  const closeIndex = rest.toLowerCase().indexOf(`</${tagName.toLowerCase()}>`);
  if (closeIndex === -1) return undefined;
  const text = stripTags(decodeXmlEntities(rest.slice(0, closeIndex))).trim();
  return text || undefined;
}

function readLinkHref(block: string, preferAlternate: boolean): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map((match) => {
    const attributes = match[1] ?? "";
    const href = attributes.match(/href\s*=\s*["']([^"']*)["']/i)?.[1];
    const rel = attributes.match(/rel\s*=\s*["']([^"']*)["']/i)?.[1]?.toLowerCase();
    return { href, rel };
  });
  // RSS：<link>url</link> 文本形式；Atom：<link href=... rel=alternate>。
  const textLink = readElementText(block, "link");
  const chosen =
    (preferAlternate ? links.find((l) => l.rel === "alternate") : undefined) ??
    links.find((l) => l.rel === undefined && l.href) ??
    links.find((l) => l.href) ??
    undefined;
  const raw = chosen?.href ?? (preferAlternate ? undefined : textLink);
  const value = raw?.trim();
  return value || undefined;
}

/** 嵌套深度上限：扫描开闭标签的近似深度（属性内的 ">" 已按引号跳过）。 */
function assertDepthWithinLimit(xml: string, maxDepth: number): void {
  let depth = 0;
  const tokenPattern = /<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->|<!\[CDATA\[|\]\]>/g;
  let selfClosingHint: RegExpExecArray | null;
  while ((selfClosingHint = tokenPattern.exec(xml)) !== null) {
    const token = selfClosingHint[0];
    if (token.startsWith("<!--") || token.startsWith("<![CDATA") || token === "]]>") continue;
    if (token.startsWith("</")) {
      depth -= 1;
      if (depth < 0) return;
      continue;
    }
    if (token.endsWith("/>")) continue;
    depth += 1;
    if (depth > maxDepth) {
      throw new FeedParseError("too_deep", `嵌套深度超过上限 ${maxDepth}`);
    }
  }
}

function extractBlocks(xml: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}[\\s>]`, "gi");
  const blocks: string[] = [];
  for (const open of pattern.execAll(xml)) {
    const openIndex = open.index;
    const closeIndex = xml.toLowerCase().indexOf(`</${tagName.toLowerCase()}>`, openIndex);
    if (closeIndex === -1) continue;
    blocks.push(xml.slice(openIndex, closeIndex + tagName.length + 3));
  }
  return blocks;
}

// RegExp.execAll（es2025 前的本地实现）。
declare global {
  interface RegExp {
    execAll(input: string): Array<RegExpExecArray>;
  }
}
// eslint-disable-next-line no-restricted-syntax
RegExp.prototype.execAll = function execAll(this: RegExp, input: string): Array<RegExpExecArray> {
  const results: Array<RegExpExecArray> = [];
  const flags = this.flags.includes("g") ? this.flags : `${this.flags}g`;
  const scanner = new RegExp(this.source, flags);
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(input)) !== null) {
    results.push(match);
    if (match.index === scanner.lastIndex) scanner.lastIndex += 1;
  }
  return results;
};

function parseRss(xml: string, maxItems: number): ParsedFeed {
  const channelBlock = extractBlocks(xml, "channel")[0];
  const feedTitle = channelBlock ? readElementText(channelBlock, "title") : undefined;
  const itemBlocks = extractBlocks(xml, "item");
  if (itemBlocks.length > maxItems) {
    throw new FeedParseError("too_many_items", `条目数超过上限 ${maxItems}`);
  }
  const items: ParsedFeedItem[] = itemBlocks.map((block) => ({
    sourceItemId: readElementText(block, "guid"),
    title: readElementText(block, "title"),
    linkUrl: readLinkHref(block, false),
    publishedAt: readElementDate(block, "pubDate"),
    author: readElementText(block, "author") ?? readElementText(block, "dc:creator"),
    summaryText: readElementText(block, "description"),
  }));
  return { kind: "rss", title: feedTitle, items };
}

function readElementDate(block: string, tagName: string): number | undefined {
  const raw = readElementText(block, tagName);
  return raw ? parseFeedDate(raw) : undefined;
}

function parseAtom(xml: string, maxItems: number): ParsedFeed {
  const feedBlock = extractBlocks(xml, "feed")[0];
  const feedTitle = feedBlock ? readElementText(feedBlock, "title") : undefined;
  const entryBlocks = extractBlocks(xml, "entry");
  if (entryBlocks.length > maxItems) {
    throw new FeedParseError("too_many_items", `条目数超过上限 ${maxItems}`);
  }
  const items: ParsedFeedItem[] = entryBlocks.map((block) => ({
    sourceItemId: readElementText(block, "id"),
    title: readElementText(block, "title"),
    linkUrl: readLinkHref(block, true),
    publishedAt: readElementDate(block, "updated") ?? readElementDate(block, "published"),
    author:
      extractBlocks(block, "author")
        .map((authorBlock) => readElementText(authorBlock, "name"))
        .find((name) => name !== undefined),
    summaryText: readElementText(block, "summary") ?? readElementText(block, "content"),
  }));
  return { kind: "atom", title: feedTitle, items };
}

export function parseFeedDocument(rawXml: string, limits?: ParseLimits): ParsedFeed {
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = limits?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxItems = limits?.maxItems ?? DEFAULT_MAX_ITEMS;
  if (rawXml.length === 0 || rawXml.trim().length === 0) {
    throw new FeedParseError("empty_document", "文档为空");
  }
  if (Buffer.byteLength(rawXml, "utf-8") > maxBytes) {
    throw new FeedParseError("too_large", `文档超过上限 ${maxBytes} 字节`);
  }
  // 文档级拒绝 ENTITY/DOCTYPE：解析器不展开任何自定义实体（防 XXE/实体爆炸）。
  // ENTITY 先查（实体爆炸 fixture 通常同时带 DOCTYPE，需验证 ENTITY 守卫本身）。
  if (/<!\s*ENTITY/i.test(rawXml)) {
    throw new FeedParseError("entity_forbidden", "禁止 ENTITY 声明");
  }
  if (/<!\s*DOCTYPE/i.test(rawXml)) {
    throw new FeedParseError("doctype_forbidden", "禁止 DOCTYPE 声明");
  }
  assertDepthWithinLimit(rawXml, maxDepth);
  if (/<(feed[\s>])/i.test(rawXml)) {
    return parseAtom(rawXml, maxItems);
  }
  if (/<(rss[\s>])/i.test(rawXml)) {
    return parseRss(rawXml, maxItems);
  }
  throw new FeedParseError("no_feed_structure", "未找到 rss/channel 或 feed/entry 结构");
}

export { parseFeedDate as parseFeedDateForTests };
