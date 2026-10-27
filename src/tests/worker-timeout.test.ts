import { describe, expect, it } from "vitest";
import { isTimeoutError } from "../orchestration-engine";

describe("a worker that runs out of time", () => {
  it("is told apart from other failures, so its changes are kept and it resumes", () => {
    expect(isTimeoutError(new Error("Cursor Agent 실행 시간이 제한을 초과해 중지했습니다."))).toBe(true);
    expect(isTimeoutError("AI 프로그램 실행 시간이 설정된 제한을 초과했습니다.")).toBe(true);
    expect(isTimeoutError(new Error("process timed out after 3600s"))).toBe(true);
    expect(isTimeoutError(new Error("Git이 설치되어 있지 않습니다."))).toBe(false);
  });
});
