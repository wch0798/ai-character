import { describe, expect, it } from "vitest";
import { judgeRequestIntent } from "../request-intent";
import { nextRequestMode } from "../request-mode";

describe("chat or program", () => {
  it("is settled by the words when they point at code or files", () => {
    expect(judgeRequestIntent("README.md 작성해줘")).toEqual({ intent: "project", sure: true });
    expect(judgeRequestIntent("오늘 날씨 어때?").sure).toBe(true);
  });

  it("is left open for an edit verb with nothing about code, so an AI can decide", () => {
    expect(judgeRequestIntent("이 부분 제대로 고쳐")).toEqual({ intent: "chat", sure: false });
  });

  it("cycles 🤖 AI 모드 → 💬 채팅 → 🛠 프로그램", () => {
    expect(nextRequestMode("auto")).toBe("chat");
    expect(nextRequestMode("chat")).toBe("program");
    expect(nextRequestMode("program")).toBe("auto");
  });
});
