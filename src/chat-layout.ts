export function getModelYForChat(
  originalY: number,
  chatTopY: number,
  gap = 12
): number {
  return Math.min(
    originalY,
    chatTopY - gap
  );
}

export type CharacterBoundsLike = {
  y: number;
  height: number;
};

export function getModelYFromBounds(
  originalModelY: number,
  bounds: CharacterBoundsLike,
  chatTopY: number,
  gap = 14,
  topMargin = 8
): number {
  const desiredBottom =
    chatTopY - gap;

  const currentBottom =
    bounds.y + bounds.height;

  let shift =
    Math.min(
      0,
      desiredBottom - currentBottom
    );

  /*
   * 캐릭터 머리가 화면 위로 나가지 않게 한다.
   */
  if (
    bounds.y + shift <
    topMargin
  ) {
    shift =
      topMargin - bounds.y;
  }

  return originalModelY + shift;
}

export function getMaxChatHeightForCharacter(
  viewportHeight: number,
  bottomInset: number,
  modelHeight: number,
  gap: number,
  topMargin = 8,
  absoluteMax = 520,
  minimum = 160
): number {
  const available =
    Math.floor(
      viewportHeight -
      bottomInset -
      topMargin -
      modelHeight -
      gap
    );

  return Math.max(
    minimum,
    Math.min(
      absoluteMax,
      available
    )
  );
}
