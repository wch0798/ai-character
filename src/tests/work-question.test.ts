import { describe, expect, it } from "vitest";
import { isQuestionAboutWork } from "../request-intent";

describe("a message typed while program work runs", () => {
  it("is a question when it asks about the work", () => {
    for (const text of [
      "지금 그 부분은 어떻게 처리하고 있어?",
      "왜 writer.py를 고쳤어",
      "지금 뭐 하고 있어",
      "테스트는 몇 개 통과했나요",
      "casefold도 지원하는지",
      "what are you changing now?",
    ]) {
      expect(isQuestionAboutWork(text), text).toBe(true);
    }
  });

  it("is an instruction when it asks for more changes", () => {
    for (const text of ["이것도 고쳐줘", "README도 수정해", "왜 안 돼? 고쳐줘", "로그 파일도 추가해줘", "진행해"]) {
      expect(isQuestionAboutWork(text), text).toBe(false);
    }
  });
});
