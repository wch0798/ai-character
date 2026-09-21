export const CHAT_WINDOW_WIDTH = 980;
export const CHAT_WINDOW_HEIGHT = 680;
export const CHARACTER_WINDOW_PADDING = 16;
export const CHARACTER_WINDOW_HUD_EXTRA = 40;
export const WINDOW_POSITION_KEY = "ai-character-window-position";

/** 채팅 배치용 폭 비율(캐릭터가 커질수록 채팅도 같이 오른쪽으로 밀림) */
export const LIVE2D_BODY_WIDTH_RATIO = 0.72;

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

export function logicalWorkArea(
  monitor: {
    size: { width: number; height: number };
  } | null,
  scaleFactor: number,
  fallback: Size = { width: 1280, height: 720 }
): Size {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  if (!monitor) {
    return fallback;
  }
  return {
    width: Math.max(320, monitor.size.width / scale),
    height: Math.max(240, monitor.size.height / scale),
  };
}

export function characterScaleForPreset(
  modelWidth: number,
  modelHeight: number,
  presetRatio: number,
  referenceWidth = CHAT_WINDOW_WIDTH,
  referenceHeight = CHAT_WINDOW_HEIGHT
): number {
  if (modelWidth <= 0 || modelHeight <= 0) {
    return 0.2;
  }
  // 모니터 작업 영역 비율. 980x680 고정창이 아님.
  const byHeight = (referenceHeight * presetRatio) / modelHeight;
  const byWidth = (referenceWidth * 0.5) / modelWidth;
  return Math.min(byHeight, byWidth);
}

export function scaleFromVisualPercent(
  percent: number,
  largeScale: number,
  minScale: number,
  maxScale: number
): number {
  const large = largeScale > 0 ? largeScale : 0.2;
  const min = minScale > 0 ? minScale : large * 0.4;
  const cap = maxScale > 0 ? maxScale : large;
  const ratio = Number.isFinite(percent) ? percent / 100 : 0.56;
  return Math.min(cap, Math.max(min, large * ratio));
}

/** 100% = ‘크게’ 프리셋. Live2D 원본 배율(4% 같은 값)을 보여 주지 않는다. */
export function visualSizePercent(
  scale: number,
  largeScale: number
): number {
  if (!(largeScale > 0) || !(scale > 0)) {
    return 0;
  }
  return Math.max(1, Math.round((scale / largeScale) * 100));
}

export function stepCharacterScale(
  current: number,
  direction: "up" | "down",
  largeScale: number,
  maxScale: number,
  minScale?: number,
  stepPercent = 10
): number {
  const large = largeScale > 0 ? largeScale : 0.2;
  const min = minScale && minScale > 0 ? minScale : large * 0.4;
  const unit = large * (stepPercent / 100);
  const safeCurrent = Number.isFinite(current) && current > 0 ? current : min;
  const next = direction === "up" ? safeCurrent + unit : safeCurrent - unit;
  const cap = Number.isFinite(maxScale) && maxScale > 0 ? maxScale : next;
  return Math.min(cap, Math.max(min, next));
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
  occupancyWidth: number,
  gap: number,
  windowWidth: number,
  minimumChatWidth = 340,
  rightMargin = 12
): number {
  const preferred = preferredChatLeft(characterCenterX, occupancyWidth, gap);
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) {
    return preferred;
  }
  const maximumLeft = Math.max(
    gap,
    windowWidth - minimumChatWidth - rightMargin
  );
  // 창이 좁아도 채팅을 캐릭터 위로 당기지 않는다. 창을 키운 뒤 맞춘다.
  if (preferred > maximumLeft) {
    return preferred;
  }
  return preferred;
}

export function preferredChatLeft(
  characterCenterX: number,
  occupancyWidth: number,
  gap: number
): number {
  const bodyRight = characterCenterX + Math.max(1, occupancyWidth) * 0.5;
  return Math.max(gap, Math.ceil(bodyRight + gap));
}

/** 채팅 왼쪽이 붙는 캐릭터 칸 폭 (모델 전체 + 여백) */
export function characterPaneWidthForChat(
  displayWidth: number,
  leftPadding = 10,
  gap = 6
): number {
  return Math.ceil(leftPadding + Math.max(1, displayWidth) + gap);
}

/**
 * Live2D 메시는 Cubism 캔버스보다 조금 넓을 수 있다.
 * 창 전체/로컬 원본 박스처럼 비정상적으로 큰 값은 버린다.
 */
export function occupancyFromModelBounds(
  displayWidth: number,
  modelX: number,
  bounds: { x: number; width: number } | null,
  leftPadding = 10,
  maxOverscanRatio = 1.28,
  devicePixelRatio = 1
): { centerX: number; occupancyWidth: number } {
  const occupancyWidth = Math.max(1, displayWidth);
  const fallbackCenter =
    Number.isFinite(modelX) && modelX > 0
      ? modelX
      : characterCenterXForChat(occupancyWidth, leftPadding);
  const fallback = {
    centerX: fallbackCenter,
    occupancyWidth,
  };

  if (
    !bounds ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.width) ||
    bounds.width < 8
  ) {
    return fallback;
  }

  const overscan = bounds.width / occupancyWidth;
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  // WebView2 고DPI에서 getBounds가 물리 픽셀이면 1.25~2배로 부풀어 창이 화면을 덮는다.
  if (
    dpr > 1.08 &&
    Math.abs(overscan - dpr) / dpr < 0.22
  ) {
    return fallback;
  }
  if (overscan > maxOverscanRatio) {
    return fallback;
  }

  const boundsCenter = bounds.x + bounds.width / 2;
  if (bounds.x <= 1 && bounds.width >= occupancyWidth * 2.5) {
    return fallback;
  }
  if (
    Math.abs(boundsCenter - fallbackCenter) >
    Math.max(occupancyWidth, bounds.width) * 0.85
  ) {
    return fallback;
  }

  return {
    centerX: boundsCenter,
    occupancyWidth: Math.max(occupancyWidth, bounds.width),
  };
}

export function pickVisualModelBox(
  displayWidth: number,
  raw: {
    x?: number;
    width?: number;
    rectangle?: { x: number; width: number };
  } | null
): { x: number; width: number } | null {
  if (!raw) {
    return null;
  }
  const candidates: { x: number; width: number }[] = [];
  if (
    Number.isFinite(raw.x) &&
    Number.isFinite(raw.width) &&
    (raw.width as number) > 8
  ) {
    candidates.push({ x: raw.x as number, width: raw.width as number });
  }
  const nested = raw.rectangle;
  if (
    nested &&
    Number.isFinite(nested.x) &&
    Number.isFinite(nested.width) &&
    nested.width > 8
  ) {
    candidates.push({ x: nested.x, width: nested.width });
  }
  if (candidates.length === 0) {
    return null;
  }
  let best = candidates[0];
  let bestScore = Math.abs(best.width - displayWidth);
  for (const candidate of candidates.slice(1)) {
    const score = Math.abs(candidate.width - displayWidth);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/** 채팅을 옆에 둔 채 모니터 안에 들어오게 하는 스케일 상한 */
export function maxCharacterScaleBesideChat(
  modelBaseWidth: number,
  modelBaseHeight: number,
  maxWindowWidth: number,
  maxWindowHeight: number,
  chatWidth: number,
  leftPadding = 10,
  gap = 6,
  windowMargin = 12
): number {
  const reserved =
    Math.max(chatWidth, 480) + windowMargin + leftPadding + gap;
  const maxDisplayWidth = Math.max(80, maxWindowWidth - reserved);
  const maxDisplayHeight = Math.max(80, maxWindowHeight - windowMargin);
  return maxCharacterScaleForMonitor(
    modelBaseWidth,
    modelBaseHeight,
    maxDisplayWidth,
    maxDisplayHeight
  );
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
