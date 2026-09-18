import { describe, expect, it } from "vitest";

import {
  getPerformanceHudPosition,
  readPerformanceHudVisible,
} from "../performance-hud";

describe("performance HUD", () => {
  it("저장값이 없으면 기본으로 표시한다", () => {
    expect(readPerformanceHudVisible(null)).toBe(true);
    expect(readPerformanceHudVisible("false")).toBe(false);
    expect(readPerformanceHudVisible("true")).toBe(true);
  });

  it("창 맨 아래 스트립, 캐릭터 아래 중앙에 둔다", () => {
    const position = getPerformanceHudPosition(
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

    expect(position.left).toBe(110);
    expect(position.top).toBe(570);
  });

  it("좁은 창에서도 HUD 전체가 창 안에 들어온다", () => {
    const position = getPerformanceHudPosition(
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
    expect(position.top).toBe(370);
  });

  it("채팅이 켜져도 발 아래 스트립에서 한 줄이 창 가로를 쓴다", () => {
    const position = getPerformanceHudPosition(
      {
        x: 40,
        y: 40,
        width: 140,
        height: 300,
      },
      {
        left: 0,
        top: 0,
        width: 500,
        height: 420,
      },
      500,
      420,
      260,
      20,
      {
        left: 160,
        top: 40,
        width: 320,
        height: 360,
      }
    );

    expect(position.top).toBe(390);
    expect(position.left).toBe(4);
    expect(position.maxWidth).toBe(492);
  });
});
