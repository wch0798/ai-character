export const CHAT_WINDOW_WIDTH = 980;
export const CHAT_WINDOW_HEIGHT = 680;
export const CHARACTER_WINDOW_PADDING = 16;
export const CHARACTER_WINDOW_HUD_EXTRA = 30;
export const WINDOW_POSITION_KEY = "ai-character-window-position";

/** 채팅 배치용 폭 비율(캐릭터가 커질수록 채팅도 같이 오른쪽으로 밀림) */
export const LIVE2D_BODY_WIDTH_RATIO = 0.72;

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

export function characterScaleForPreset(
  modelWidth: number,
  modelHeight: number,
  presetRatio: number,
  referenceWidth = CHAT_WINDOW_WIDTH,
  referenceHeight = CHAT_WINDOW_HEIGHT
): number {
  const maxWidth = referenceWidth * 0.65;
  const maxHeight = referenceHeight * presetRatio;
  return Math.min(maxWidth / modelWidth, maxHeight / modelHeight);
}

export function characterDisplaySize(
  modelBaseWidth: number,
  modelBaseHeight: number,
  characterScale: number
): Size {
  return {
    width: Math.max(1, modelBaseWidth * characterScale),
    height: Math.max(1, modelBaseHeight * characterScale),
  };
}

export function characterBodyWidth(
  displayWidth: number,
  bodyRatio = LIVE2D_BODY_WIDTH_RATIO
): number {
  return Math.max(40, displayWidth * bodyRatio);
}

export function compactWindowSizeForCharacter(
  characterWidth: number,
  characterHeight: number,
  options?: {
    padding?: number;
    hudExtra?: number;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
  }
): Size {
  const padding = options?.padding ?? CHARACTER_WINDOW_PADDING;
  const hudExtra = options?.hudExtra ?? 0;
  const minWidth = options?.minWidth ?? 220;
  const minHeight = options?.minHeight ?? 160;
  let width = Math.max(minWidth, Math.ceil(characterWidth + padding * 2));
  let height = Math.max(
    minHeight,
    Math.ceil(characterHeight + padding * 2 + hudExtra)
  );
  if (typeof options?.maxWidth === "number") {
    width = Math.min(width, Math.floor(options.maxWidth));
  }
  if (typeof options?.maxHeight === "number") {
    height = Math.min(height, Math.floor(options.maxHeight));
  }
  return { width, height };
}

/** 채팅 모드: 캐릭터 중심 X (전체 모델이 창 왼쪽 안에 들어오게) */
export function characterCenterXForChat(
  displayWidth: number,
  leftPadding = 10
): number {
  return displayWidth * 0.5 + leftPadding;
}

/** 보이는 몸 오른쪽 기준으로 채팅 left */
export function chatLeftForCharacterLayout(
  characterCenterX: number,
  bodyWidth: number,
  gap: number,
  windowWidth: number,
  minimumChatWidth = 340,
  rightMargin = 12
): number {
  const bodyRight = characterCenterX + bodyWidth * 0.5;
  const preferred = Math.ceil(bodyRight + gap);
  const maximumLeft = Math.max(
    gap,
    windowWidth - minimumChatWidth - rightMargin
  );
  return Math.min(maximumLeft, Math.max(gap, preferred));
}

export function windowPositionKeepingCharacter(
  characterScreenX: number,
  characterScreenY: number,
  characterInWindowX: number,
  characterInWindowY: number,
  scaleFactor: number
): Point {
  return {
    x: Math.round(characterScreenX - characterInWindowX * scaleFactor),
    y: Math.round(characterScreenY - characterInWindowY * scaleFactor),
  };
}

export function readStoredWindowPosition(
  raw: string | null
): Point | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Point>;
    if (
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y)
    ) {
      return {
        x: Math.round(parsed.x),
        y: Math.round(parsed.y),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function clampWindowPositionToMonitor(
  x: number,
  y: number,
  windowWidth: number,
  windowHeight: number,
  monitor: { x: number; y: number; width: number; height: number },
  minVisible = 48
): Point {
  const maxX = monitor.x + monitor.width - minVisible;
  const maxY = monitor.y + monitor.height - minVisible;
  const minX = monitor.x + minVisible - windowWidth;
  const minY = monitor.y + minVisible - windowHeight;
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, x))),
    y: Math.round(Math.min(maxY, Math.max(minY, y))),
  };
}

/** 모니터 안에 들어오도록 스케일 상한 */
export function maxCharacterScaleForMonitor(
  modelBaseWidth: number,
  modelBaseHeight: number,
  maxWidth: number,
  maxHeight: number
): number {
  if (modelBaseWidth <= 0 || modelBaseHeight <= 0) {
    return 1;
  }
  return Math.min(maxWidth / modelBaseWidth, maxHeight / modelBaseHeight);
}
