import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { ChatHistoryStore } from "./chat-history";

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
  ].join("");
}

async function writeChosenFile(
  path: string,
  contents: string
): Promise<string> {
  try {
    const result = await invoke<{ path: string }>("write_text_file", {
      path,
      contents,
    });
    return result.path;
  } catch {
    // 브라우저/개발 폴백
    const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = path.split(/[\\/]/).pop() || "chat-backup.json";
    anchor.click();
    URL.revokeObjectURL(url);
    return path;
  }
}

export async function exportAllChatsJson(
  store: ChatHistoryStore
): Promise<string> {
  const defaultPath = `ai-character-chats-${stamp()}.json`;
  const path = await save({
    defaultPath,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) {
    throw new Error("저장이 취소되었습니다.");
  }
  return writeChosenFile(path, store.exportJson(true));
}

export async function exportConversationMarkdown(
  store: ChatHistoryStore,
  conversationId: string,
  title: string
): Promise<string> {
  const markdown = store.exportConversationMarkdown(conversationId);
  if (!markdown) {
    throw new Error("대화를 찾을 수 없습니다.");
  }

  const safeTitle = title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40) || "chat";
  const path = await save({
    defaultPath: `${safeTitle}-${stamp()}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!path) {
    throw new Error("저장이 취소되었습니다.");
  }
  return writeChosenFile(path, markdown);
}

export async function importChatsFromJson(
  store: ChatHistoryStore,
  mode: "replace" | "merge"
): Promise<{ imported: number; mode: "replace" | "merge"; path: string }> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) {
    throw new Error("가져오기가 취소되었습니다.");
  }

  let raw: string;
  try {
    raw = await invoke<string>("read_text_file", { path });
  } catch {
    throw new Error("백업 파일을 읽을 수 없습니다.");
  }

  const result = store.importSnapshot(raw, mode);
  return { ...result, path };
}
