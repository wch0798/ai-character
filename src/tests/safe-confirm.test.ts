import { describe, expect, it } from "vitest";
import { safeConfirm } from "../safe-confirm";

describe("safeConfirm", () => {
  it("네이티브 확인창을 쓰지 않아 응답 없음이 나지 않는다", () => {
    expect(safeConfirm("계속할까요?")).toBe(true);
  });
});
