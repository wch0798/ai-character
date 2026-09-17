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
