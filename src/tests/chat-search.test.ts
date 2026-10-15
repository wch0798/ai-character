import { describe, expect, it } from "vitest";
import { countMatches, matchConversation, snippetAround, splitMatches, stepIndex } from "../chat-search";

describe("chat search", () => {
  it("splits text into matching parts case-insensitively", () => {
    expect(splitMatches("Rust와 rust", "RUST")).toEqual([
      { text: "Rust", match: true },
      { text: "와 ", match: false },
      { text: "rust", match: true },
    ]);
    expect(splitMatches("abc", "")).toEqual([{ text: "abc", match: false }]);
    expect(countMatches("가나가나가", "가")).toBe(3);
  });

  it("cuts a snippet around the first hit", () => {
    const text = `${"앞".repeat(50)} 업데이트 ${"뒤".repeat(50)}`;
    const parts = snippetAround(text, "업데이트", 5)!;
    expect(parts[0]).toEqual({ text: "…", match: false });
    expect(parts[parts.length - 1]).toEqual({ text: "…", match: false });
    expect(parts.find((part) => part.match)?.text).toBe("업데이트");
    expect(snippetAround("없음", "x")).toBeNull();
  });

  it("totals matches across messages", () => {
    const result = matchConversation([{ content: "빌드 실패" }, { content: "다시 빌드, 빌드 성공" }], "빌드");
    expect(result.count).toBe(3);
    expect(result.snippet?.some((part) => part.match)).toBe(true);
    expect(matchConversation([{ content: "x" }], "y")).toEqual({ count: 0, snippet: null });
  });

  it("wraps result navigation in both directions", () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(-1, 1, 0)).toBe(-1);
  });
});
