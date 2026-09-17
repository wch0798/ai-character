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
      left: canvasRect.left,
      top: canvasRect.top,
    };
  }

  const scaleX =
    canvasRect.width / screenWidth;

  const scaleY =
    canvasRect.height / screenHeight;

  let left =
    canvasRect.left +
    (
      modelBounds.x +
      modelBounds.width / 2
    ) * scaleX;

  let top =
    canvasRect.top +
    (
      modelBounds.y +
      modelBounds.height
    ) * scaleY +
    gap;

  const halfHud =
    hudWidth / 2;

  left =
    Math.max(
      halfHud + 4,
      Math.min(
        left,
        canvasRect.left +
          canvasRect.width -
          halfHud -
          4
      )
    );

  /*
   * 창이 HUD보다 좁으면 가운데 두고,
   * 왼쪽부터 보이게 해서 RAM이 잘리지 않게 한다.
   */
  if (hudWidth >= canvasRect.width - 8) {
    left = canvasRect.left + Math.min(halfHud, canvasRect.width - 4);
  }

  if (chatTop !== null) {
    top =
      Math.min(
        top,
        chatTop -
          hudHeight -
          4
      );
  }

  /*
   * 채팅창이 닫혀 있어도
   * HUD가 창 아래로 잘리지 않도록 제한
   */
  const canvasBottom =
    canvasRect.top +
    canvasRect.height;

  top =
    Math.min(
      top,
      canvasBottom -
        hudHeight -
        4
    );

  top =
    Math.max(
      canvasRect.top + 4,
      top
    );

  return {
    left,
    top,
  };
}
