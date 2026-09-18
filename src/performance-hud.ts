export type BoundsLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DomRectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function readPerformanceHudVisible(
  storedValue: string | null
): boolean {
  return storedValue !== "false";
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.max(min, Math.min(value, max));
}

/**
 * HUD의 **왼쪽 위** 좌표.
 * 발 아래 예약 스트립에 한 줄로 둔다. 채팅은 이 스트립 위에 있어서 가로를 채팅에 맞추지 않는다.
 */
export function getPerformanceHudPosition(
  modelBounds: BoundsLike,
  canvasRect: DomRectLike,
  screenWidth: number,
  screenHeight: number,
  hudWidth: number,
  hudHeight: number,
  chatRect: DomRectLike | null,
  _gap = 6,
  stripHeight = 40
): {
  left: number;
  top: number;
  maxWidth: number;
} {
  const canvasBottom = canvasRect.top + canvasRect.height;
  const strip = Math.max(22, stripHeight);
  const usedHeight = Math.min(Math.max(hudHeight, 16), strip - 4);
  const top =
    canvasBottom - strip + Math.max(2, Math.floor((strip - usedHeight) / 2));

  const minLeft = canvasRect.left + 4;
  const maxRight = canvasRect.left + canvasRect.width - 4;
  const maxWidth = Math.max(80, maxRight - minLeft);

  if (screenWidth <= 0 || screenHeight <= 0 || (chatRect && chatRect.width > 0)) {
    return {
      left: minLeft,
      top: Math.max(canvasRect.top + 2, top),
      maxWidth,
    };
  }

  const scaleX = canvasRect.width / screenWidth;
  const centerX =
    canvasRect.left + (modelBounds.x + modelBounds.width / 2) * scaleX;
  const usedWidth = Math.min(Math.max(hudWidth, 80), maxWidth);
  const left = clamp(centerX - usedWidth / 2, minLeft, maxRight - usedWidth);

  return {
    left,
    top: Math.max(canvasRect.top + 2, top),
    maxWidth,
  };
}
