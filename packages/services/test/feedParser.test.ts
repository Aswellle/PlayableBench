// 受限解析器测试（spec 08 §6/§10、S4）：正常 RSS/Atom 提取、CDATA/实体、
// 日期双格式、坏 XML/空 feed/无结构、DOCTYPE/ENTITY 拒绝、大小/深度/条目上限。
import { describe, expect, it } from "vitest";
import { FeedParseError, parseFeedDocument } from "#src/playablebench/feedParser.js";

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>示例博客</title>
  <item>
    <title><![CDATA[错误边界重构实践]]></title>
    <link>https://blog.example.com/error-boundary</link>
    <guid isPermaLink="false">post-123</guid>
    <pubDate>Wed, 12 Nov 2026 08:30:00 GMT</pubDate>
    <dc:creator>张三</dc:creator>
    <description><![CDATA[<p>关于 <code>retry</code> 的讨论 &amp; 修复记录</p>]]></description>
  </item>
  <item>
    <title>数据库迁移清单</title>
    <link>https://blog.example.com/migration</link>
    <guid>post-124</guid>
    <pubDate>Thu, 13 Nov 2026 09:00:00 +08:00</pubDate>
    <description>plain &lt;b&gt;text&lt;/b&gt; 摘要</description>
  </item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 示例</title>
  <entry>
    <id>urn:uuid:aaaa-bbbb</id>
    <title>发布 2026.11 版本</title>
    <link rel="alternate" href="https://example.com/releases/2026.11"/>
    <link rel="self" href="https://example.com/rels/1"/>
    <updated>2026-11-13T10:00:00Z</updated>
    <author><name>Release Bot</name></author>
    <summary>包含安全修复与迁移说明</summary>
  </entry>
</feed>`;

describe("feedParser 提取", () => {
  it("RSS：CDATA/实体解码、guid/link/pubDate(RFC822)/dc:creator", () => {
    const feed = parseFeedDocument(RSS_SAMPLE);
    expect(feed.kind).toBe("rss");
    expect(feed.title).toBe("示例博客");
    expect(feed.items).toHaveLength(2);
    const first = feed.items[0];
    expect(first?.title).toBe("错误边界重构实践");
    expect(first?.sourceItemId).toBe("post-123");
    expect(first?.linkUrl).toBe("https://blog.example.com/error-boundary");
    expect(first?.author).toBe("张三");
    expect(first?.publishedAt).toBe(Date.parse("Wed, 12 Nov 2026 08:30:00 GMT"));
    expect(first?.summaryText).toBe("关于 retry 的讨论 & 修复记录");
    const second = feed.items[1];
    expect(second?.summaryText).toBe("plain text 摘要");
    expect(second?.publishedAt).toBe(Date.parse("Thu, 13 Nov 2026 09:00:00 +08:00"));
  });

  it("Atom：id/link rel=alternate/updated(ISO8601)/author/name", () => {
    const feed = parseFeedDocument(ATOM_SAMPLE);
    expect(feed.kind).toBe("atom");
    const entry = feed.items[0];
    expect(entry?.sourceItemId).toBe("urn:uuid:aaaa-bbbb");
    expect(entry?.linkUrl).toBe("https://example.com/releases/2026.11");
    expect(entry?.publishedAt).toBe(Date.parse("2026-11-13T10:00:00Z"));
    expect(entry?.author).toBe("Release Bot");
    expect(entry?.summaryText).toBe("包含安全修复与迁移说明");
  });

  it("空 feed（0 条目）合法返回", () => {
    const feed = parseFeedDocument("<rss version='2.0'><channel><title>空</title></channel></rss>");
    expect(feed.items).toEqual([]);
  });
});

describe("feedParser 资源限制（spec 08 §6）", () => {
  it("坏 XML / 空 / 无结构拒绝", () => {
    expect(() => parseFeedDocument("")).toThrowError(expect.objectContaining({ kind: "empty_document" }));
    expect(() => parseFeedDocument("<html><body>不是 feed</body></html>")).toThrowError(
      expect.objectContaining({ kind: "no_feed_structure" }),
    );
  });

  it("DOCTYPE 与 ENTITY 文档级拒绝（防 XXE/实体爆炸）", () => {
    // 组合形态：任一守卫拒绝即可（XXE 与实体爆炸通常同时出现）。
    const xxe = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel/></rss>`;
    expect(() => parseFeedDocument(xxe)).toThrowError(FeedParseError);
    const billion = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><rss><channel/></rss>`;
    expect(() => parseFeedDocument(billion)).toThrowError(FeedParseError);
    // 隔离形态：分别验证两个守卫各自生效。
    const doctypeOnly = `<?xml version="1.0"?><!DOCTYPE rss><rss><channel/></rss>`;
    expect(() => parseFeedDocument(doctypeOnly)).toThrowError(
      expect.objectContaining({ kind: "doctype_forbidden" }),
    );
    const entityOnly = `<?xml version="1.0"?><rss><!ENTITY a "x"><channel/></rss>`;
    expect(() => parseFeedDocument(entityOnly)).toThrowError(
      expect.objectContaining({ kind: "entity_forbidden" }),
    );
  });

  it("大小 / 嵌套深度 / 条目数上限", () => {
    expect(() => parseFeedDocument(`<rss>${"x".repeat(3000)}</rss>`, { maxBytes: 100 })).toThrowError(
      expect.objectContaining({ kind: "too_large" }),
    );
    const deep = `<rss><channel><a><b><c><d><e><f><g><h/></g></f></e></d></c></b></a></channel></rss>`;
    expect(() => parseFeedDocument(deep, { maxDepth: 5 })).toThrowError(
      expect.objectContaining({ kind: "too_deep" }),
    );
    const manyItems = `<rss><channel>${"<item><title>t</title></item>".repeat(6)}</channel></rss>`;
    expect(() => parseFeedDocument(manyItems, { maxItems: 5 })).toThrowError(
      expect.objectContaining({ kind: "too_many_items" }),
    );
  });

  it("有效深度内的正常文档不被误拒", () => {
    const feed = parseFeedDocument(ATOM_SAMPLE, { maxDepth: 4 });
    expect(feed.items).toHaveLength(1);
  });
});
