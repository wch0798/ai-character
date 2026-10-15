import { invoke } from "@tauri-apps/api/core";

export type TaskContext = {
  context: string;
  fingerprint: string;
  files: string[];
  keywords: string[];
  usedRipgrep: boolean;
  changedFiles: number;
};

const EMPTY_CONTEXT: TaskContext = {
  context: "",
  fingerprint: "",
  files: [],
  keywords: [],
  usedRipgrep: false,
  changedFiles: 0,
};

/** Relevant code blocks + baseline diff for a task; never throws (context is optional). */
export async function buildTaskContext(
  conversationId: string | null | undefined,
  query: string,
  maxChars: number
): Promise<TaskContext> {
  if (!query.trim()) {
    return EMPTY_CONTEXT;
  }
  try {
    return await invoke<TaskContext>("build_task_context", {
      conversationId: conversationId ?? null,
      query,
      maxChars,
    });
  } catch (error) {
    console.warn("작업 컨텍스트 생성 실패", error);
    return EMPTY_CONTEXT;
  }
}
