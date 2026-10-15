import { describe, expect, it } from "vitest";
import { isSafeHref, parseInline, parseMarkdown } from "../chat-markdown";

describe("parseInline", () => {
  it("splits code, bold and links", () => {
    expect(parseInline("run `npm test` **now** see [docs](https://example.com/a)")).toEqual([
      { type: "text", text: "run " },
      { type: "code", text: "npm test" },
      { type: "text", text: " " },
      { type: "bold", children: [{ type: "text", text: "now" }] },
      { type: "text", text: " see " },
      { type: "link", text: "docs", href: "https://example.com/a" },
    ]);
  });

  it("links bare URLs without trailing punctuation", () => {
    expect(parseInline("열기: https://github.com/x/y.")).toEqual([
      { type: "text", text: "열기: " },
      { type: "link", text: "https://github.com/x/y", href: "https://github.com/x/y" },
      { type: "text", text: "." },
    ]);
  });

  it("never links non-http schemes", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("file:///etc/passwd")).toBe(false);
    expect(parseInline("[x](javascript:alert(1))").every((node) => node.type === "text")).toBe(true);
  });
});

describe("parseMarkdown", () => {
  it("keeps fenced code verbatim, including markdown-looking lines", () => {
    const blocks = parseMarkdown("앞\n```ts\nconst a = 1;\n- not a list\n```\n뒤");
    expect(blocks).toEqual([
      { type: "paragraph", lines: [[{ type: "text", text: "앞" }]] },
      { type: "code", lang: "ts", text: "const a = 1;\n- not a list" },
      { type: "paragraph", lines: [[{ type: "text", text: "뒤" }]] },
    ]);
  });

  it("closes an unterminated fence at the end", () => {
    expect(parseMarkdown("```\nabc")).toEqual([{ type: "code", lang: "", text: "abc" }]);
  });

  it("groups list items and quotes, and separates headings", () => {
    const blocks = parseMarkdown("## 요약\n- 하나\n- 둘\n1. 첫째\n> 인용\n> 계속");
    expect(blocks.map((block) => block.type)).toEqual(["heading", "list", "list", "quote"]);
    expect(blocks[1]).toMatchObject({ ordered: false, items: [[{ text: "하나" }], [{ text: "둘" }]] });
    expect(blocks[2]).toMatchObject({ ordered: true });
    expect(blocks[3]).toMatchObject({ lines: [[{ text: "인용" }], [{ text: "계속" }]] });
  });

  it("keeps consecutive lines in one paragraph and splits on blank lines", () => {
    const blocks = parseMarkdown("a\nb\n\nc");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "paragraph", lines: [[{ text: "a" }], [{ text: "b" }]] });
  });
});
