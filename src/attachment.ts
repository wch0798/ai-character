export type AttachmentKind =
  | "text"
  | "source"
  | "csv"
  | "pdf"
  | "docx"
  | "xlsx"
  | "image"
  | "unsupported";

export type ChatAttachment = {
  id: string;
  name: string;
  path: string;
  kind: AttachmentKind;
  sizeBytes: number;
};

const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx",
  "js", "jsx",
  "rs",
  "py",
  "java",
  "cs",
  "cpp", "cc", "c", "h", "hpp",
  "html", "css",
  "json",
  "xml",
  "yaml", "yml",
  "toml",
  "sql",
  "sh",
  "ps1",
]);

export function getAttachmentKind(
  filename: string
): AttachmentKind {
  const extension =
    filename
      .split(".")
      .pop()
      ?.toLowerCase() ?? "";

  if (
    extension === "txt" ||
    extension === "md" ||
    extension === "log"
  ) {
    return "text";
  }

  if (SOURCE_EXTENSIONS.has(extension)) {
    return "source";
  }

  if (extension === "csv") {
    return "csv";
  }

  if (extension === "pdf") {
    return "pdf";
  }

  if (extension === "docx") {
    return "docx";
  }

  if (extension === "xlsx") {
    return "xlsx";
  }

  if (
    extension === "png" ||
    extension === "jpg" ||
    extension === "jpeg" ||
    extension === "webp"
  ) {
    return "image";
  }

  return "unsupported";
}

export function isAttachmentAllowed(
  filename: string
): boolean {
  return getAttachmentKind(filename) !== "unsupported";
}
