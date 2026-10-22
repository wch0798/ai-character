import { shouldAutoWebSearch } from "./web-research";

export type RequestIntent = "chat" | "research" | "project";

/** Always work on the project, whatever else the request says. */
const PROJECT_MARKERS = [
  "구현해",
  "구현하",
  "웹페이지",
  "대시보드",
  "페이지를 만들",
  "페이지가 있었으면",
  "리팩터",
  "리팩토",
  "패치해",
  "커밋해",
  "빌드해",
  "버그 고",
  "오류 고",
  "에러 고",
  "implement",
  "refactor",
  "patch this",
  "commit this",
  "bugfix",
  "create a page",
  "create a dashboard",
];

/**
 * Everyday verbs: "이 문장 영어로 바꿔줘" or "시 작성해줘" are plain chat, so these only mean
 * project work when the request is about code or files (CODE_CONTEXT, LOCAL_FILE_MARKERS).
 */
const EDIT_VERBS = [
  "수정해",
  "수정하",
  "고쳐",
  "만들어줘",
  "만들어 줘",
  "만들어줄",
  "만들어 줄",
  "만들어주",
  "추가해",
  "삭제해",
  "적용해",
  "변경해",
  "바꿔줘",
  "작성해",
  "fix this",
  "fix the",
  "build a",
];

const CODE_CONTEXT = [
  "버그",
  "오류",
  "에러",
  "컴포넌트",
  "화면",
  "버튼",
  "기능",
  "함수",
  "클래스",
  "변수",
  "스크립트",
  "앱",
  "프로그램",
  "웹",
  "사이트",
  "페이지",
  "서버",
  "스타일",
  "테스트",
  "빌드",
  "설정",
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

// Whole words only: "ui" is inside "build", "app" inside "happy".
const CODE_CONTEXT_EN = /\b(ui|ux|api|css|html|bug|function|component|script|app|test)\b/i;

function includesAny(text: string, markers: string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((marker) => lower.includes(marker.toLowerCase()));
}

function mentionsCodeOrFiles(text: string): boolean {
  return includesAny(text, CODE_CONTEXT) || CODE_CONTEXT_EN.test(text) || includesAny(text, LOCAL_FILE_MARKERS) || FILE_NAME_PATTERN.test(text);
}

function includesProjectMarker(text: string): boolean {
  return includesAny(text, PROJECT_MARKERS) || (includesAny(text, EDIT_VERBS) && mentionsCodeOrFiles(text));
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
  return includesProjectMarker(history) || /웹페이지|대시보드|구현/.test(history);
}

const LOCAL_FILE_MARKERS = [
  "폴더",
  "디렉토리",
  "디렉터리",
  "파일",
  "프로젝트",
  "코드",
  "소스",
  "저장소",
  "레포",
  "readme",
  "folder",
  "directory",
  "file",
  "project",
  "codebase",
  "source code",
  "repo",
];

/** e.g. `main.ts`, `app.py`, `settings.json` mentioned by name. */
const FILE_NAME_PATTERN = /[\w가-힣-]+\.(ts|tsx|js|jsx|mjs|py|rs|go|java|kt|cs|cpp|c|h|json|toml|yaml|yml|md|txt|html|css|sql|sh|ps1|bat)\b/i;

/**
 * Questions about the user's own folder or files. Only programs running inside the work
 * folder (ChatGPT/Codex, Claude) can answer these; web-only AIs cannot see the files.
 */
export function needsLocalFiles(prompt: string): boolean {
  const text = extractCurrentUserRequest(prompt);
  if (!text) return false;
  const lower = text.toLowerCase();
  return LOCAL_FILE_MARKERS.some((marker) => lower.includes(marker)) || FILE_NAME_PATTERN.test(text);
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
  // A question about the user's files must not be sent to web research first.
  if (needsLocalFiles(current)) return "chat";
  if (shouldAutoWebSearch(current)) return "research";
  return "chat";
}
