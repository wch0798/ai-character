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

  it("mean project work for program names and for fixes in a project conversation", () => {
    expect(
      classifyRequestIntent("mkfs.ext4 이 부분에 제대로 안되는 부분들이 많다!! 이 부분들을 제대로 수정해야 하며. 바로 적용을 해라")
    ).toBe("project");
    expect(classifyRequestIntent("이 부분도 제대로 고쳐", "user: 프로젝트 코드에서 버그 고쳐줘")).toBe("project");
    expect(classifyRequestIntent("문장을 자연스럽게 고쳐줘", "user: 오늘 날씨 어때")).toBe("chat");
  });

  it("do not turn a plain yes into project work just because history mentioned an account", () => {
    expect(classifyRequestIntent("네", "어떤 계정으로 로그인했는지 알려줘")).toBe("chat");
  });
});
