import { describe, expect, it } from "vitest";
import { askClaude } from "../claude-client";

describe("askClaude", () => {
  it("Tauri ask_claude 명령에 사용자 메시지를 전달한다", async () => {
    const fakeInvoke = async (
      command: string,
      args?: Record<string, unknown>
    ) => {
      expect(command).toBe("ask_claude");
      expect(args).toEqual({
        prompt: "안녕하세요",
      });

      return "Claude 응답";
    };

    const result = await askClaude(
      "안녕하세요",
      fakeInvoke
    );

    expect(result).toBe("Claude 응답");
  });
});
