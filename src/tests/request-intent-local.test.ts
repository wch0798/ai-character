import { describe, expect, it } from "vitest";
import { classifyRequestIntent, needsLocalFiles } from "../request-intent";

describe("questions about the user's own files", () => {
  it("are recognised", () => {
    for (const question of ["지금 폴더 내용 알려줘", "이 폴더에 뭐가 있어?", "README 요약해줘", "main.ts 읽고 설명해줘", "프로젝트 구조 설명해줘"]) {
      expect(needsLocalFiles(question)).toBe(true);
    }
    for (const question of ["안녕", "오늘 날씨 어때", "점심 메뉴 추천해줘"]) {
      expect(needsLocalFiles(question)).toBe(false);
    }
  });

  it("stay with the folder-aware chat instead of web research", () => {
    expect(classifyRequestIntent("최신 프로젝트 파일 목록 알려줘", "")).toBe("chat");
    expect(classifyRequestIntent("main.ts 수정해줘", "")).toBe("project");
  });
});
