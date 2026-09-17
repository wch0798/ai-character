import {
  describe,
  expect,
  it,
} from "vitest";

import {
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
