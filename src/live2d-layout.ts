export type ModelLayout = {
  scale: number;
  x: number;
  y: number;
};

export function fitModelToWindow(
  modelWidth: number,
  modelHeight: number,
  windowWidth: number,
  windowHeight: number
): ModelLayout {
  const usableWidth = windowWidth * 0.9;
  const usableHeight = windowHeight * 0.9;

  const scale = Math.min(
    usableWidth / modelWidth,
    usableHeight / modelHeight
  );

  return {
    scale,
    x: windowWidth / 2,
    y: windowHeight,
  };
}
