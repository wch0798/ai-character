/**
 * What a failed request says in the chat. A cancel or a busy notice is not a "connection
 * error", and raw English from a program gets a Korean lead with the original kept short.
 */
const NETWORK = /network|fetch failed|timed? ?out|econn|enotfound|socket|dns|인터넷|연결할 수 없|연결이 끊/i;
const HANGUL = /[가-힣]/;

export function friendlyChatError(message: string): string {
  const text = message.trim() || "알 수 없는 문제가 생겼습니다.";
  // Already written for the user: cancels, busy notices, limits.
  if (/취소|중지|이미 .*진행 중|사용량|한도/.test(text)) {
    return text;
  }
  const detail = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  if (NETWORK.test(text)) {
    return `연결 오류: 인터넷이나 AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.\n자세히: ${detail}`;
  }
  if (!HANGUL.test(text)) {
    return `작업을 마치지 못했습니다. 다시 시도하거나 기술 로그를 확인해 주세요.\n자세히: ${detail}`;
  }
  return `작업을 마치지 못했습니다: ${detail}`;
}
