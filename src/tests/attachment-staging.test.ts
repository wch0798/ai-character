import {
  describe,
  expect,
  it,
} from "vitest";

import {
  stageAttachment,
} from "../attachment-staging";

describe("attachment staging", () => {
  it("원본 대신 임시 복사본 경로를 받는다", async () => {
    const result =
      await stageAttachment(
        "/Users/test/report.pdf",
        async (
          command,
          args
        ) => {
          expect(command).toBe(
            "stage_attachment"
          );

          expect(args).toEqual({
            path:
              "/Users/test/report.pdf",
          });

          return (
            "/tmp/ai-character/" +
            "000001-report.pdf"
          );
        }
      );

    expect(result).toContain(
      "report.pdf"
    );

    expect(result).not.toBe(
      "/Users/test/report.pdf"
    );
  });
});
