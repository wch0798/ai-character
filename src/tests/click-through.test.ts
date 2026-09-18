import {
  describe,
  expect,
  it,
} from "vitest";

import {
  characterHitLayerBox,
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
