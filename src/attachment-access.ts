import {
  invoke,
} from "@tauri-apps/api/core";

export type AttachmentAccess = {
  exists: boolean;
  isFile: boolean;
  readable: boolean;
  writable: boolean;
};

type InvokeFunction = (
  command: string,
  args?: Record<string, unknown>
) => Promise<boolean[]>;

export async function inspectAttachmentAccess(
  path: string,
  invokeFunction: InvokeFunction = invoke
): Promise<AttachmentAccess> {
  const result =
    await invokeFunction(
      "inspect_attachment_access",
      { path }
    );

  return {
    exists: result[0] === true,
    isFile: result[1] === true,
    readable: result[2] === true,
    writable: result[3] === true,
  };
}

export function attachmentAccessLabel(
  access: AttachmentAccess
): string {
  if (!access.exists) {
    return "❌ 파일 없음";
  }

  if (!access.isFile) {
    return "❌ 파일 아님";
  }

  if (!access.readable) {
    return "❌ 접근 권한 필요";
  }

  if (!access.writable) {
    return "⚠️ 읽기 전용";
  }

  return "✅ 읽기 가능";
}
