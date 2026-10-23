import { describe, expect, it } from "vitest";
import { classifyRequestIntent } from "../request-intent";

describe("everyday edit verbs", () => {
  it("stay plain chat when nothing points at code or files", () => {
    for (const request of ["이 문장 영어로 바꿔줘", "시 작성해줘", "이메일 답장 작성해줘", "문장을 자연스럽게 고쳐줘", "happy birthday 노래 가사 바꿔줘", "웹툰 줄거리 작성해줘", "TV 프로그램 소개 작성해줘", "책 한 페이지 요약해서 작성해"]) {
      expect(classifyRequestIntent(request)).toBe("chat");
    }
  });

  it("mean project work when they are about code, screens or files", () => {
    for (const request of ["로그인 버튼 색 바꿔줘", "설정 화면에 항목 추가해줘", "README.md 작성해줘", "app 오류 고쳐줘"]) {
      expect(classifyRequestIntent(request)).toBe("project");
    }
  });

  it("do not turn a plain yes into project work just because history mentioned an account", () => {
    expect(classifyRequestIntent("네", "어떤 계정으로 로그인했는지 알려줘")).toBe("chat");
  });
});
