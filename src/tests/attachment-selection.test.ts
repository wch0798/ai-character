import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildPendingAttachments,
  getAttachmentName,
} from "../attachment-selection";

describe("attachment selection", () => {
  it("macOS 경로에서 파일명을 얻는다", () => {
    expect(
      getAttachmentName(
        "/Users/test/Documents/report.pdf"
      )
    ).toBe("report.pdf");
  });

  it("Windows 경로에서도 파일명을 얻는다", () => {
    expect(
      getAttachmentName(
        "C:\\Users\\test\\report.docx"
      )
    ).toBe("report.docx");
  });

  it("지원 파일만 남긴다", () => {
    const result =
      buildPendingAttachments([
        "/tmp/report.pdf",
        "/tmp/data.xlsx",
        "/tmp/program.exe",
      ]);

    expect(
      result.map((item) => item.name)
    ).toEqual([
      "report.pdf",
      "data.xlsx",
    ]);
  });

  it("같은 경로는 중복 첨부하지 않는다", () => {
    const result =
      buildPendingAttachments([
        "/tmp/report.pdf",
        "/tmp/report.pdf",
      ]);

    expect(result).toHaveLength(1);
  });
});
