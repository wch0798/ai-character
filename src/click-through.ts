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
  let x = centerX - bodyWidth * 0.5 - padding;
  let y = footY - bodyHeight - padding;
  let width = Math.max(1, bodyWidth + padding * 2);
  let height = Math.max(1, bodyHeight + padding * 2);

  if (typeof options?.windowWidth === "number") {
    const right = Math.min(options.windowWidth, x + width);
    x = Math.max(0, x);
    width = Math.max(1, right - x);
  }
  if (typeof options?.windowHeight === "number") {
    const bottom = Math.min(options.windowHeight, y + height);
    y = Math.max(0, y);
    height = Math.max(1, bottom - y);
  }

  return { x, y, width, height };
}
