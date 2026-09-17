import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildAttachmentPrompt,
} from "../attachment-prompt";

describe("attachment prompt", () => {
  it("첨부가 없으면 원래 질문을 사용한다", () => {
    expect(
      buildAttachmentPrompt(
        "안녕",
        []
      )
    ).toBe("안녕");
  });

  it("첨부 파일 경로를 프롬프트에 포함한다", () => {
    const result =
      buildAttachmentPrompt(
        "이 파일 분석해줘",
        [
          {
            path: "/tmp/report.pdf",
            name: "report.pdf",
            kind: "pdf",
          },
        ]
      );

    expect(result).toContain(
      "이 파일 분석해줘"
    );

    expect(result).toContain(
      "/tmp/report.pdf"
    );

    expect(result).toContain(
      "report.pdf"
    );
  });

  it("질문 없이 파일만 보내도 분석 요청을 만든다", () => {
    const result =
      buildAttachmentPrompt(
        "",
        [
          {
            path: "/tmp/data.xlsx",
            name: "data.xlsx",
            kind: "xlsx",
          },
        ]
      );

    expect(result).toContain(
      "첨부된 파일을 분석"
    );

    expect(result).toContain(
      "/tmp/data.xlsx"
    );
  });
});
