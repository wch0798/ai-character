import { describe, expect, it } from "vitest";
import {
  chatProgressLabel,
  cradleProgressPercent,
  formatChatProgress,
} from "../chat-progress";

describe("chat progress", () => {
  it("일반 채팅은 파일 작업이라고 말하지 않는다", () => {
    expect(chatProgressLabel("chat")).toBe("답변 중…");
    expect(chatProgressLabel("file", "cursor")).toBe("Cursor가 파일을 수정하는 중…");
  });

  it("CRADLE 작업 개수로 진행율을 계산한다", () => {
    expect(cradleProgressPercent(2, 5)).toBe(40);
    expect(cradleProgressPercent(0, 0)).toBeNull();
  });

  it("진행 문구에 퍼센트와 경과 시간을 붙인다", () => {
    expect(
      formatChatProgress({
        kind: "cradle",
        label: "작업 2/5",
        percent: 40,
        elapsedMs: 12_000,
        canStop: true,
      })
    ).toBe("작업 2/5 40% · 12초");
  });
});
