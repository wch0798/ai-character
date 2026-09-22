import {
  describe,
  expect,
  it,
} from "vitest";

import {
  characterHitLayerBox,
  pickCharacterDragBox,
  pointInRect,
} from "../click-through";

describe("pointInRect", () => {
  const rect = {
    x: 100,
    y: 200,
    width: 50,
    height: 80,
  };

  it("사각형 안의 점을 감지한다", () => {
    expect(
      pointInRect(
        120,
        230,
        rect
      )
    ).toBe(true);

    expect(
      pointInRect(
        10,
        10,
        rect
      )
    ).toBe(false);
  });

  it("padding 영역도 포함할 수 있다", () => {
    expect(
      pointInRect(
        95,
        230,
        rect,
        10
      )
    ).toBe(true);
  });
});

describe("characterHitLayerBox", () => {
  it("발 기준 중심에서 보이는 몸 영역만 잡는다", () => {
    expect(
      characterHitLayerBox(110, 400, 144, 300, { padding: 4 })
    ).toEqual({
      x: 34,
      y: 96,
      width: 152,
      height: 308,
    });
  });

  it("창 밖으로 나가지 않게 자른다", () => {
    expect(
      characterHitLayerBox(20, 80, 80, 100, {
        padding: 4,
        windowWidth: 50,
        windowHeight: 70,
      })
    ).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 70,
    });
  });
});

describe("pickCharacterDragBox", () => {
  it("캔버스나 창이 아니라 보이는 몸 박스만 쓴다", () => {
    const box = pickCharacterDragBox({
      centerX: 140,
      footY: 400,
      displayWidth: 240,
      displayHeight: 380,
      visible: { x: 96, y: 90, width: 88, height: 300 },
      windowWidth: 272,
      windowHeight: 420,
    });
    expect(box.width).toBeLessThan(120);
    expect(box.height).toBeLessThan(320);
    expect(box.width).toBeGreaterThan(80);
    expect(box.x).toBeGreaterThan(80);
  });

  it("창을 거의 채운 박스는 버리고 몸통 비율로 줄인다", () => {
    const box = pickCharacterDragBox({
      centerX: 136,
      footY: 412,
      displayWidth: 240,
      displayHeight: 380,
      visible: { x: 0, y: 0, width: 260, height: 400 },
      windowWidth: 272,
      windowHeight: 420,
    });
    expect(box.width).toBeLessThan(272 * 0.62);
    expect(box.height).toBeLessThan(420 * 0.92);
  });

  it("고DPI로 부푼 박스는 쓰지 않는다", () => {
    const box = pickCharacterDragBox({
      centerX: 120,
      footY: 360,
      displayWidth: 200,
      displayHeight: 320,
      visible: { x: 0, y: 0, width: 300, height: 480 },
      windowWidth: 232,
      windowHeight: 360,
      devicePixelRatio: 1.5,
    });
    expect(box.width).toBeLessThan(130);
  });
});
