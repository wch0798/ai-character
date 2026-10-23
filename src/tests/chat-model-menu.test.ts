import { beforeEach, describe, expect, it } from "vitest";
import { choiceFor, prunedChoices } from "../chat-model-menu";

// Tests run without a browser: a minimal in-memory localStorage.
const store = new Map<string, string>();
(globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem" | "clear"> }).localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => void store.set(key, String(value)),
  clear: () => store.clear(),
};

describe("program and model picked per conversation", () => {
  beforeEach(() => localStorage.clear());

  it("uses the conversation's own pick, else the last pick, else the default program", () => {
    expect(choiceFor("a")).toEqual({ agent: "claude", model: "" });
    localStorage.setItem("ai-character-last-model", JSON.stringify({ agent: "codex", model: "gpt-6-sol" }));
    expect(choiceFor("new")).toEqual({ agent: "codex", model: "gpt-6-sol" });
    localStorage.setItem(
      "ai-character-conversation-models",
      JSON.stringify({ a: { agent: "claude", model: "opus", at: 1 } })
    );
    expect(choiceFor("a")).toEqual({ agent: "claude", model: "opus" });
  });

  it("ignores broken entries", () => {
    localStorage.setItem("ai-character-conversation-models", JSON.stringify({ a: { agent: "nope", model: 3 } }));
    expect(choiceFor("a")).toEqual({ agent: "claude", model: "" });
  });

  it("keeps only the newest picks when there are too many", () => {
    const many = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`c${i}`, { agent: "claude" as const, model: "", at: i }])
    );
    expect(Object.keys(prunedChoices(many, 2)).sort()).toEqual(["c3", "c4"]);
  });
});
