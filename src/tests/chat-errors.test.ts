import { describe, expect, it } from "vitest";
import { friendlyChatError } from "../chat-errors";

describe("failure messages in the chat", () => {
  it("leave cancels, busy notices and limits as they are", () => {
    expect(friendlyChatError("민감 파일 경고에서 협업 작업 실행을 취소했습니다.")).toBe("민감 파일 경고에서 협업 작업 실행을 취소했습니다.");
    expect(friendlyChatError("이미 협업 작업이 진행 중입니다.")).toBe("이미 협업 작업이 진행 중입니다.");
  });

  it("call only network trouble a connection error", () => {
    expect(friendlyChatError("fetch failed: ECONNRESET").startsWith("연결 오류:")).toBe(true);
    expect(friendlyChatError("모델 응답이 비어 있습니다.").startsWith("작업을 마치지 못했습니다")).toBe(true);
  });

  it("put a Korean lead before raw English and keep it short", () => {
    const text = friendlyChatError(`Error: ${"x".repeat(500)}`);
    expect(text.startsWith("작업을 마치지 못했습니다.")).toBe(true);
    expect(text.length).toBeLessThan(420);
  });
});
