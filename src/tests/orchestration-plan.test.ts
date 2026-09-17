import { describe, expect, it } from "vitest";
import { extractUserFacingAnswer } from "../orchestration-plan";

describe("extractUserFacingAnswer", () => {
  it("합성 JSON에서 사용자 답을 꺼낸다", () => {
    expect(
      extractUserFacingAnswer(
        '{"finalAnswer":"채팅에 이 답을 보여주세요","revisionTasks":[]}'
      )
    ).toBe("채팅에 이 답을 보여주세요");
  });

  it("일반 텍스트는 그대로 둔다", () => {
    expect(extractUserFacingAnswer("그냥 답변")).toBe("그냥 답변");
  });
});
