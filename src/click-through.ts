export type RectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function pointInRect(
  pointX: number,
  pointY: number,
  rect: RectLike,
  padding = 0
): boolean {
  return (
    pointX >= rect.x - padding &&
    pointX <=
      rect.x +
        rect.width +
        padding &&
    pointY >= rect.y - padding &&
    pointY <=
      rect.y +
        rect.height +
        padding
  );
}

/** 보이는 캐릭터 몸 영역. 창 전체 사각형이 아님 */
export function characterHitLayerBox(
  centerX: number,
  footY: number,
  bodyWidth: number,
  bodyHeight: number,
  options?: {
    padding?: number;
    windowWidth?: number;
    windowHeight?: number;
  }
): RectLike {
  const padding = options?.padding ?? 4;
  return clipRectToWindow(
    centerX - bodyWidth * 0.5 - padding,
    footY - bodyHeight - padding,
    bodyWidth + padding * 2,
    bodyHeight + padding * 2,
    options?.windowWidth,
    options?.windowHeight
  );
}

export function clipRectToWindow(
  x: number,
  y: number,
  width: number,
  height: number,
  windowWidth?: number,
  windowHeight?: number
): RectLike {
  let nextX = x;
  let nextY = y;
  let nextWidth = Math.max(1, width);
  let nextHeight = Math.max(1, height);
  if (typeof windowWidth === "number") {
    const right = Math.min(windowWidth, nextX + nextWidth);
    nextX = Math.max(0, nextX);
    nextWidth = Math.max(1, right - nextX);
  }
  if (typeof windowHeight === "number") {
    const bottom = Math.min(windowHeight, nextY + nextHeight);
    nextY = Math.max(0, nextY);
    nextHeight = Math.max(1, bottom - nextY);
  }
  return { x: nextX, y: nextY, width: nextWidth, height: nextHeight };
}

const FALLBACK_DRAG_WIDTH_RATIO = 0.46;
const FALLBACK_DRAG_HEIGHT_RATIO = 0.84;

/**
 * 드래그/클릭은 보이는 캐릭터만. Live2D 캔버스나 창 사각형이 아님.
 */
export function pickCharacterDragBox(options: {
  centerX: number;
  footY: number;
  displayWidth: number;
  displayHeight: number;
  visible?: { x: number; y: number; width: number; height: number } | null;
  windowWidth: number;
  windowHeight: number;
  devicePixelRatio?: number;
  padding?: number;
}): RectLike {
  const padding = options.padding ?? 3;
  const fallback = characterHitLayerBox(
    options.centerX,
    options.footY,
    Math.max(36, options.displayWidth * FALLBACK_DRAG_WIDTH_RATIO),
    Math.max(48, options.displayHeight * FALLBACK_DRAG_HEIGHT_RATIO),
    {
      padding,
      windowWidth: options.windowWidth,
      windowHeight: options.windowHeight,
    }
  );

  const visible = options.visible;
  if (
    !visible ||
    !Number.isFinite(visible.x) ||
    !Number.isFinite(visible.y) ||
    !Number.isFinite(visible.width) ||
    !Number.isFinite(visible.height)
  ) {
    return fallback;
  }

  const dpr = options.devicePixelRatio && options.devicePixelRatio > 0
    ? options.devicePixelRatio
    : 1;
  const overscan = visible.width / Math.max(1, options.displayWidth);
  if (dpr > 1.08 && Math.abs(overscan - dpr) / dpr < 0.22) {
    return fallback;
  }
  if (visible.width < 24 || visible.height < 32) {
    return fallback;
  }
  if (
    visible.width > options.displayWidth * 1.18 ||
    visible.height > options.displayHeight * 1.18
  ) {
    return fallback;
  }
  if (
    visible.width > options.windowWidth * 0.88 &&
    visible.height > options.windowHeight * 0.88
  ) {
    return fallback;
  }

  return clipRectToWindow(
    visible.x - padding,
    visible.y - padding,
    visible.width + padding * 2,
    visible.height + padding * 2,
    options.windowWidth,
    options.windowHeight
  );
}
