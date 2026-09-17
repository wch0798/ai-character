export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function windowPositionForGrab(
  cursorX: number,
  cursorY: number,
  grabOffsetX: number,
  grabOffsetY: number
): { x: number; y: number } {
  return {
    x: Math.round(cursorX - grabOffsetX),
    y: Math.round(cursorY - grabOffsetY),
  };
}

/**
 * 창이 아니라 캐릭터 기준으로 화면 안에 남긴다.
 * 캐릭터 머리는 monitor.y 까지 올라갈 수 있고,
 * 완전히 화면 밖으로만 나가지 않게 minVisible 만큼은 남긴다.
 */
export function clampWindowForCharacter(
  windowX: number,
  windowY: number,
  characterInWindow: Rect,
  monitor: Rect,
  minVisible = 48
): { x: number; y: number } {
  const charLeft = windowX + characterInWindow.x;
  const charTop = windowY + characterInWindow.y;
  const charRight = charLeft + characterInWindow.width;
  const charBottom = charTop + characterInWindow.height;

  let x = windowX;
  let y = windowY;

  if (charRight < monitor.x + minVisible) {
    x += monitor.x + minVisible - charRight;
  } else if (charLeft > monitor.x + monitor.width - minVisible) {
    x += monitor.x + monitor.width - minVisible - charLeft;
  }

  if (charBottom < monitor.y + minVisible) {
    y += monitor.y + minVisible - charBottom;
  } else if (charTop > monitor.y + monitor.height - minVisible) {
    y += monitor.y + monitor.height - minVisible - charTop;
  }

  return { x: Math.round(x), y: Math.round(y) };
}
