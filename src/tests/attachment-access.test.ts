import {
  describe,
  expect,
  it,
} from "vitest";

import {
  attachmentAccessLabel,
  inspectAttachmentAccess,
} from "../attachment-access";

describe("attachment access", () => {
  it("읽기 가능한 파일 상태를 만든다", async () => {
    const result =
      await inspectAttachmentAccess(
        "/tmp/test.txt",
        async () => [
          true,
          true,
          true,
          false,
        ]
      );

    expect(result.readable).toBe(true);
    expect(result.writable).toBe(false);

    expect(
      attachmentAccessLabel(result)
    ).toBe("⚠️ 읽기 전용");
  });

  it("접근 거부 상태를 표시한다", async () => {
    const result =
      await inspectAttachmentAccess(
        "/protected/test.txt",
        async () => [
          true,
          true,
          false,
          false,
        ]
      );

    expect(
      attachmentAccessLabel(result)
    ).toBe("❌ 접근 권한 필요");
  });
});
