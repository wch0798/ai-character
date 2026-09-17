import { describe, expect, it } from "vitest";
import {
  classifyRequestIntent,
  extractCurrentUserRequest,
} from "../request-intent";

describe("request intent", () => {
  it("현재 사용자 요청만 잘라낸다", () => {
    const prompt = [
      "이전 대화 기록:",
      "User:\n안녕",
      "현재 사용자 요청:",
      "이 버그 고쳐줘",
    ].join("\n");
    expect(extractCurrentUserRequest(prompt)).toBe("이 버그 고쳐줘");
  });

  it("일반 질문은 chat으로 분류한다", () => {
    expect(classifyRequestIntent("지금 프로그램의 대화 내용을 볼 수 있나요?")).toBe(
      "chat"
    );
    expect(classifyRequestIntent("이게 질문인지 작업인지 구분이 필요해")).toBe(
      "chat"
    );
  });

  it("최신 조사 요청은 research로 분류한다", () => {
    expect(classifyRequestIntent("React 최신 버전을 조사해줘")).toBe("research");
  });

  it("코드/프로젝트 작업은 project로 분류한다", () => {
    expect(classifyRequestIntent("채팅 버그를 고쳐줘")).toBe("project");
    expect(classifyRequestIntent("이 컴포넌트 UI를 수정해")).toBe("project");
    expect(
      classifyRequestIntent("연결된 계정 사용량을 한눈에 보는 웹페이지를 만들어 줄수 있나?")
    ).toBe("project");
  });

  it("프로젝트 확인 답은 이전 작업 맥락이 있으면 project로 이어간다", () => {
    expect(
      classifyRequestIntent(
        "1",
        "연결된 계정 사용량을 한눈에 보는 웹페이지를 만들어 줄수 있나?"
      )
    ).toBe("project");
    expect(classifyRequestIntent("/add-dir /tmp/.ai-character", "페이지를 만들어줘")).toBe(
      "project"
    );
  });

  it("대화 기록이 있어도 현재 요청만 보고 분류한다", () => {
    const prompt = [
      "이전 대화 기록:",
      "User:\n프로젝트 파일을 수정했어",
      "현재 사용자 요청:",
      "방금 한 말 다시 설명해줘",
    ].join("\n");
    expect(classifyRequestIntent(prompt)).toBe("chat");
  });
});
