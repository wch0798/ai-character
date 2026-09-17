import { shouldAutoWebSearch } from "./web-research";

export type RequestIntent = "chat" | "research" | "project";

const PROJECT_MARKERS = [
  "구현해",
  "구현하",
  "수정해",
  "수정하",
  "고쳐",
  "만들어줘",
  "만들어 줘",
  "만들어줄",
  "만들어 줄",
  "만들어주",
  "만들어 줄수",
  "만들어줄수",
  "웹페이지",
  "대시보드",
  "페이지를 만들",
  "페이지가 있었으면",
  "추가해",
  "추가해줘",
  "삭제해",
  "리팩터",
  "리팩토",
  "패치해",
  "커밋해",
  "적용해",
  "변경해",
  "바꿔줘",
  "작성해",
  "빌드해",
  "버그 고",
  "오류 고",
  "에러 고",
  "implement",
  "refactor",
  "patch this",
  "commit this",
  "bugfix",
  "fix this",
  "fix the",
  "build a",
  "create a page",
  "create a dashboard",
];

const PROJECT_CONFIRMATIONS = [
  "1",
  "2",
  "3",
  "네",
  "응",
  "좋아",
  "진행",
  "시작해",
  "시작",
  "확인",
  "확인했어",
  "해줘",
  "해 줘",
  "그대로",
  "그렇게",
  "ㅇㅇ",
];

const CURRENT_REQUEST_MARKERS = ["현재 사용자 요청:", "USER REQUEST:"];

export function extractCurrentUserRequest(prompt: string): string {
  const text = prompt.trim();
  if (!text) return "";

  for (const marker of CURRENT_REQUEST_MARKERS) {
    const index = text.lastIndexOf(marker);
    if (index >= 0) {
      const current = text.slice(index + marker.length).trim();
      if (current) return current;
    }
  }
  return text;
}

function includesProjectMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return PROJECT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

function isProjectConfirmation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/add-dir")) return true;
  return PROJECT_CONFIRMATIONS.some(
    (marker) => trimmed === marker || trimmed.toLowerCase() === marker.toLowerCase()
  );
}

function historyLooksLikeProject(history: string): boolean {
  if (!history.trim()) return false;
  return (
    includesProjectMarker(history) ||
    /웹페이지|대시보드|구현|폴더|페이지|계정/.test(history)
  );
}

export function classifyRequestIntent(
  prompt: string,
  conversationContext = ""
): RequestIntent {
  const current = extractCurrentUserRequest(prompt);
  if (!current) return "chat";
  if (includesProjectMarker(current)) return "project";
  if (isProjectConfirmation(current) && historyLooksLikeProject(conversationContext)) {
    return "project";
  }
  if (shouldAutoWebSearch(current)) return "research";
  return "chat";
}
