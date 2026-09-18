export const MIN_CHAT_WIDTH = 480;
export const MAX_CHAT_WIDTH = 1200;
export const DEFAULT_CHAT_WIDTH = 560;

export const MIN_CHAT_HEIGHT = 280;
export const MAX_CHAT_HEIGHT = 900;
export const DEFAULT_CHAT_HEIGHT = 420;

export const CHAT_WINDOW_MARGIN = 12;

export type SizeLike = {
  width: number;
  height: number;
};

export function clampChatWidth(
  value: number,
  min = MIN_CHAT_WIDTH,
  max = MAX_CHAT_WIDTH
): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHAT_WIDTH;
  }

  return Math.round(Math.max(min, Math.min(value, max)));
}

export function clampChatHeight(
  value: number,
  min = MIN_CHAT_HEIGHT,
  max = MAX_CHAT_HEIGHT
): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHAT_HEIGHT;
  }

  return Math.round(Math.max(min, Math.min(value, max)));
}

export function clampChatSize(
  width: number,
  height: number,
  maxWidth = MAX_CHAT_WIDTH,
  maxHeight = MAX_CHAT_HEIGHT
): SizeLike {
  return {
    width: clampChatWidth(width, MIN_CHAT_WIDTH, maxWidth),
    height: clampChatHeight(height, MIN_CHAT_HEIGHT, maxHeight),
  };
}

export function readChatWidth(stored: string | null): number {
  if (!stored) {
    return DEFAULT_CHAT_WIDTH;
  }
  return clampChatWidth(Number(stored));
}

export function readChatHeight(stored: string | null): number {
  if (!stored) {
    return DEFAULT_CHAT_HEIGHT;
  }
  return clampChatHeight(Number(stored));
}

/** 채팅 모드 앱 창: 캐릭터 칸 + 채팅 최소 크기. UI가 깨지지 않는 하한 */
export function minChatAppWindowSize(
  characterPaneWidth: number,
  characterHeight = 0,
  bottomInset = 0
): SizeLike {
  const pane = Math.max(0, characterPaneWidth);
  const inset = Math.max(0, bottomInset);
  return {
    width: Math.ceil(pane + MIN_CHAT_WIDTH + CHAT_WINDOW_MARGIN),
    height: Math.ceil(
      Math.max(
        MIN_CHAT_HEIGHT + CHAT_WINDOW_MARGIN * 2 + inset,
        characterHeight + CHAT_WINDOW_MARGIN
      )
    ),
  };
}

/** 창이 실제로 목표 크기가 아니면, 이전에 같은 값을 적용했더라도 다시 적용한다. */
export function shouldApplyChatWindowSize(
  next: SizeLike,
  current: SizeLike,
  _lastApplied: SizeLike,
  tolerance = 2
): boolean {
  const alreadyShowing =
    Math.abs(current.width - next.width) <= tolerance &&
    Math.abs(current.height - next.height) <= tolerance;
  return !alreadyShowing;
}

/** 캐릭터와 채팅을 같은 바닥에 붙인 뒤, 둘을 감싸는 창 크기 */
export function chatAppWindowSize(
  characterPaneWidth: number,
  chatWidth: number,
  chatHeight: number,
  characterHeight = 0,
  bottomInset = 0
): SizeLike {
  const inset = Math.max(0, bottomInset);
  const min = minChatAppWindowSize(
    characterPaneWidth,
    characterHeight,
    inset
  );
  return {
    width: Math.max(
      min.width,
      Math.ceil(characterPaneWidth + chatWidth + CHAT_WINDOW_MARGIN)
    ),
    height: Math.max(
      min.height,
      Math.ceil(
        Math.max(
          characterHeight + CHAT_WINDOW_MARGIN,
          chatHeight + CHAT_WINDOW_MARGIN * 2 + inset
        )
      )
    ),
  };
}
