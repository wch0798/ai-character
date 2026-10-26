import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COOLDOWN_MS,
  isUsageLimitMessage,
  limitedUntil,
  limitResetAt,
  noteRunFailure,
  noteRunSuccess,
} from "../subscription-limits";

const store = new Map<string, string>();
(globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> }).localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => void store.set(key, String(value)),
  removeItem: (key) => void store.delete(key),
  clear: () => store.clear(),
};

const now = new Date(2026, 9, 26, 15, 0, 0).getTime();

describe("subscription limits switch back and forth", () => {
  beforeEach(() => store.clear());

  it("reads when the limit lifts from the program's message", () => {
    expect(limitResetAt("Claude AI usage limit reached|1792999999", now)).toBe(1792999999 * 1000);
    expect(limitResetAt("You've hit your usage limit. Try again in 2 hours 5 minutes.", now)).toBe(now + 125 * 60_000);
    expect(limitResetAt("5-hour limit reached ∙ resets 7pm", now)).toBe(new Date(2026, 9, 26, 19, 0, 0).getTime());
    expect(limitResetAt("사용량 초과: 3시간 후 다시 시도", now)).toBe(now + 180 * 60_000);
    expect(limitResetAt("usage limit reached", now)).toBe(now + DEFAULT_COOLDOWN_MS);
  });

  it("skips a program until it resets, then uses it again", () => {
    expect(noteRunFailure("claude", "network error", now)).toBeNull();
    expect(limitedUntil("claude", now)).toBeNull();

    noteRunFailure("claude", "usage limit reached. Try again in 1 hour", now);
    expect(limitedUntil("claude", now + 30 * 60_000)).toBe(now + 60 * 60_000);
    expect(limitedUntil("codex", now)).toBeNull();
    expect(limitedUntil("claude", now + 61 * 60_000)).toBeNull();

    noteRunFailure("codex", "usage limit reached", now);
    noteRunSuccess("codex", now + 1_000);
    expect(limitedUntil("codex", now + 2_000)).toBeNull();
  });

  it("tells limits from other failures", () => {
    expect(isUsageLimitMessage("Rate limit reached for requests")).toBe(true);
    expect(isUsageLimitMessage("작업 폴더를 찾을 수 없습니다")).toBe(false);
  });
});
