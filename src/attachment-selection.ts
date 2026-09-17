import {
  getAttachmentKind,
  isAttachmentAllowed,
  type AttachmentKind,
} from "./attachment";

export type PendingAttachment = {
  /*
   * AI가 실제로 읽는 경로.
   * staging 전에는 원본 경로와 같다.
   */
  path: string;

  /*
   * 사용자가 선택한 실제 원본 위치.
   */
  originalPath?: string;

  name: string;
  kind: AttachmentKind;
};

export function getAttachmentName(
  path: string
): string {
  const normalized =
    path.replace(/\\/g, "/");

  return (
    normalized.split("/").pop() ||
    normalized
  );
}

export function buildPendingAttachments(
  paths: string[]
): PendingAttachment[] {
  const seen = new Set<string>();

  return paths
    .filter((path) => {
      if (seen.has(path)) {
        return false;
      }

      seen.add(path);

      return isAttachmentAllowed(
        getAttachmentName(path)
      );
    })
    .map((path) => {
      const name =
        getAttachmentName(path);

      return {
        path,
        originalPath: path,
        name,
        kind:
          getAttachmentKind(name),
      };
    });
}
