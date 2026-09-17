import type {
  PendingAttachment,
} from "./attachment-selection";

export function buildAttachmentPrompt(
  text: string,
  attachments: PendingAttachment[]
): string {
  const cleanText = text.trim();

  if (attachments.length === 0) {
    return cleanText;
  }

  const request =
    cleanText ||
    "첨부된 파일을 분석하고 핵심 내용을 설명해줘.";

  const files =
    attachments
      .map(
        (file, index) =>
          `${index + 1}. ${file.name}\n경로: ${file.path}`
      )
      .join("\n\n");

  return [
    request,
    "",
    "다음 첨부 파일을 직접 읽어서 분석하세요.",
    "파일 이름만 보고 추측하지 말고 실제 파일 내용을 확인하세요.",
    "",
    files,
  ].join("\n");
}
