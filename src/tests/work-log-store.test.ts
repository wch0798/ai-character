import { describe, expect, it } from "vitest";
import { formatWorkLog, type WorkLogSnapshot } from "../work-log-store";

describe("work log", () => {
  it("기술 상세가 비어 있지 않으면 로그 본문에 넣는다", () => {
    const snapshot: WorkLogSnapshot = {
      title: "기술 로그",
      status: "다시 시도해 주세요",
      output: "stderr: failed",
      technical: "ENOENT claude.exe",
      updatedAt: 1,
    };
    const text = formatWorkLog(snapshot);
    expect(text).toContain("ENOENT claude.exe");
    expect(text).toContain("stderr: failed");
    expect(text).not.toContain("응답 없음");
  });
});
