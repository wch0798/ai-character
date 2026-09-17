import {
  describe,
  expect,
  it,
} from "vitest";

import {
  getPerformanceHudPosition,
  readPerformanceHudVisible,
} from "../performance-hud";

describe("performance HUD", () => {
  it("저장값이 없으면 기본으로 표시한다", () => {
    expect(
      readPerformanceHudVisible(null)
    ).toBe(true);

    expect(
      readPerformanceHudVisible("false")
    ).toBe(false);

    expect(
      readPerformanceHudVisible("true")
    ).toBe(true);
  });

  it("캐릭터 아래 중앙(왼쪽 기준)에 배치한다", () => {
    const position =
      getPerformanceHudPosition(
        {
          x: 100,
          y: 100,
          width: 200,
          height: 300,
        },
        {
          left: 0,
          top: 0,
          width: 400,
          height: 600,
        },
        400,
        600,
        180,
        20,
        null
      );

    // center 200 - half 90 = 110
    expect(position.left).toBe(110);
    expect(position.top).toBe(406);
  });

  it("좁은 창에서도 HUD 전체가 창 안에 들어온다", () => {
    const position =
      getPerformanceHudPosition(
        {
          x: 10,
          y: 40,
          width: 80,
          height: 200,
        },
        {
          left: 0,
          top: 0,
          width: 160,
          height: 400,
        },
        160,
        400,
        140,
        20,
        null
      );

    expect(position.left).toBeGreaterThanOrEqual(4);
    expect(position.left + 140).toBeLessThanOrEqual(156);
  });

  it("채팅창이 있으면 그 위를 넘지 않는다", () => {
    const position =
      getPerformanceHudPosition(
        {
          x: 100,
          y: 100,
          width: 200,
          height: 300,
        },
        {
          left: 0,
          top: 0,
          width: 400,
          height: 600,
        },
        400,
        600,
        180,
        20,
        420
      );

    expect(position.top).toBe(396);
  });

  it("채팅창이 닫혀도 HUD가 화면 아래로 잘리지 않는다", () => {
    const position =
      getPerformanceHudPosition(
        {
          x: 100,
          y: 300,
          width: 200,
          height: 290,
        },
        {
          left: 0,
          top: 0,
          width: 400,
          height: 600,
        },
        400,
        600,
        180,
        20,
        null
      );

    expect(position.top).toBe(576);
  });
});
