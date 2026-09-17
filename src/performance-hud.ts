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

/**
 * HUD의 **왼쪽 위** 좌표를 반환한다.
 * (CSS transform 중앙정렬을 쓰지 않아 Windows DPI/좁은 창에서 RAM이 잘리지 않게 함)
 */
export function getPerformanceHudPosition(
  modelBounds: BoundsLike,
  canvasRect: DomRectLike,
  screenWidth: number,
  screenHeight: number,
  hudWidth: number,
  hudHeight: number,
  chatTop: number | null,
  gap = 6
): {
  left: number;
  top: number;
} {
  if (
    screenWidth <= 0 ||
    screenHeight <= 0
  ) {
    return {
      left: canvasRect.left + 4,
      top: canvasRect.top + 4,
    };
  }

  const scaleX =
    canvasRect.width / screenWidth;

  const scaleY =
    canvasRect.height / screenHeight;

  const centerX =
    canvasRect.left +
    (
      modelBounds.x +
      modelBounds.width / 2
    ) * scaleX;

  let left = centerX - hudWidth / 2;

  let top =
    canvasRect.top +
    (
      modelBounds.y +
      modelBounds.height
    ) * scaleY +
    gap;

  const minLeft = canvasRect.left + 4;
  const maxLeft =
    canvasRect.left +
    canvasRect.width -
    hudWidth -
    4;

  if (maxLeft < minLeft) {
    left = minLeft;
  } else {
    left = Math.max(
      minLeft,
      Math.min(left, maxLeft)
    );
  }

  if (chatTop !== null) {
    top = Math.min(
      top,
      chatTop - hudHeight - 4
    );
  }

  const canvasBottom =
    canvasRect.top + canvasRect.height;

  top = Math.min(
    top,
    canvasBottom - hudHeight - 4
  );

  top = Math.max(
    canvasRect.top + 4,
    top
  );

  return {
    left,
    top,
  };
}
