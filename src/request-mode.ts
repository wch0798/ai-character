import { readStored, writeStored } from "./local-store";

/**
 * How a chat message is handled. "auto" lets the app decide (and an AI when the words leave it
 * open); "chat" only answers and never changes files; "program" always works on the project
 * with the progress and apply screens.
 */
export type RequestMode = "auto" | "chat" | "program";

export const REQUEST_MODES: Array<{ id: RequestMode; label: string; title: string }> = [
  { id: "auto", label: "🤖 AI 모드", title: "질문인지 프로그램 수정인지 앱이 알아서 정합니다. 애매하면 AI에게 물어봅니다." },
  { id: "chat", label: "💬 채팅", title: "파일은 건드리지 않고 답만 합니다." },
  { id: "program", label: "🛠 프로그램", title: "프로그램(파일) 작업으로 처리합니다. 진행 상황과 적용 화면이 함께 나옵니다." },
];

const MODE_KEY = "ai-character-request-mode";

export function readRequestMode(): RequestMode {
  const value = readStored(MODE_KEY);
  return value === "chat" || value === "program" ? value : "auto";
}

export function writeRequestMode(mode: RequestMode): void {
  writeStored(MODE_KEY, mode === "auto" ? null : mode);
}

export function nextRequestMode(mode: RequestMode): RequestMode {
  const index = REQUEST_MODES.findIndex((item) => item.id === mode);
  return REQUEST_MODES[(index + 1) % REQUEST_MODES.length].id;
}
