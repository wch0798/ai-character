import {
  describe,
  expect,
  it,
} from "vitest";

import {
  getAttachmentKind,
  isAttachmentAllowed,
} from "../attachment";

describe("attachment", () => {
  it("일반 텍스트 파일을 판별한다", () => {
    expect(
      getAttachmentKind("memo.txt")
    ).toBe("text");

    expect(
      getAttachmentKind("README.md")
    ).toBe("text");
  });

  it("소스코드 파일을 판별한다", () => {
    expect(
      getAttachmentKind("main.ts")
    ).toBe("source");

    expect(
      getAttachmentKind("lib.rs")
    ).toBe("source");

    expect(
      getAttachmentKind("Form1.cs")
    ).toBe("source");
  });

  it("문서와 데이터를 판별한다", () => {
    expect(
      getAttachmentKind("data.csv")
    ).toBe("csv");

    expect(
      getAttachmentKind("manual.pdf")
    ).toBe("pdf");

    expect(
      getAttachmentKind("report.docx")
    ).toBe("docx");

    expect(
      getAttachmentKind("sales.xlsx")
    ).toBe("xlsx");
  });

  it("이미지를 판별한다", () => {
    expect(
      getAttachmentKind("photo.png")
    ).toBe("image");

    expect(
      getAttachmentKind("photo.JPG")
    ).toBe("image");

    expect(
      getAttachmentKind("photo.webp")
    ).toBe("image");
  });

  it("지원하지 않는 형식은 거부한다", () => {
    expect(
      isAttachmentAllowed("program.exe")
    ).toBe(false);

    expect(
      isAttachmentAllowed("archive.zip")
    ).toBe(false);
  });
});
