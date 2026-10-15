import { describe, expect, it } from "vitest";
import { isNearBottom, keyIntent, rememberSent, SENT_HISTORY_LIMIT, stepHistory, type KeyState } from "../chat-composer";

const base: KeyState = {
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  value: "hello",
  caretAtStart: false,
  caretAtEnd: true,
  busy: false,
};

describe("keyIntent", () => {
  it("sends on Enter and breaks the line on Shift+Enter", () => {
    expect(keyIntent(base)).toBe("submit");
    expect(keyIntent({ ...base, shiftKey: true })).toBe("newline");
  });

  it("never sends while a Korean IME is composing", () => {
    expect(keyIntent({ ...base, isComposing: true })).toBe("none");
    expect(keyIntent({ ...base, keyCode: 229 })).toBe("none");
  });

  it("stops with Escape only while busy", () => {
    expect(keyIntent({ ...base, key: "Escape", busy: true })).toBe("stop");
    expect(keyIntent({ ...base, key: "Escape" })).toBe("none");
  });

  it("recalls history only from the edges of a single-line input", () => {
    expect(keyIntent({ ...base, key: "ArrowUp", caretAtStart: true })).toBe("recall-previous");
    expect(keyIntent({ ...base, key: "ArrowUp", caretAtStart: false })).toBe("none");
    expect(keyIntent({ ...base, key: "ArrowUp", caretAtStart: true, value: "a\nb" })).toBe("none");
    expect(keyIntent({ ...base, key: "ArrowDown" })).toBe("recall-next");
  });
});

describe("sent history", () => {
  it("dedupes, trims and caps", () => {
    expect(rememberSent(["a", "b"], " a ")).toEqual(["b", "a"]);
    expect(rememberSent(["a"], "   ")).toEqual(["a"]);
    const many = Array.from({ length: SENT_HISTORY_LIMIT + 5 }, (_, index) => `q${index}`);
    expect(rememberSent(many, "last")).toHaveLength(SENT_HISTORY_LIMIT);
  });

  it("clamps the cursor between the oldest entry and the draft", () => {
    expect(stepHistory(3, 0, -1)).toBe(0);
    expect(stepHistory(3, 3, 1)).toBe(3);
    expect(stepHistory(3, 3, -1)).toBe(2);
  });
});

describe("isNearBottom", () => {
  it("treats the last 80px as the bottom", () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true);
    expect(isNearBottom(830, 100, 1000)).toBe(true);
    expect(isNearBottom(500, 100, 1000)).toBe(false);
  });
});
