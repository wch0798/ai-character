export const MIN_CHAT_HEIGHT = 160;
export const MAX_CHAT_HEIGHT = 520;
export const DEFAULT_CHAT_HEIGHT = 260;

export function clampChatHeight(
  value: number,
  min = MIN_CHAT_HEIGHT,
  max = MAX_CHAT_HEIGHT
): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHAT_HEIGHT;
  }

  return Math.round(
    Math.max(
      min,
      Math.min(value, max)
    )
  );
}

export function readChatHeight(
  stored: string | null
): number {
  if (!stored) {
    return DEFAULT_CHAT_HEIGHT;
  }

  return clampChatHeight(
    Number(stored)
  );
}
