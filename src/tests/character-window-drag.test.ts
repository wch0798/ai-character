import { describe, expect, it } from "vitest";
import {
  clampWindowForCharacter,
  windowPositionForGrab,
} from "../character-window-drag";

describe("character window drag", () => {
  it("follows cursor by grab offset", () => {
    expect(windowPositionForGrab(500, 200, 100, 150)).toEqual({
      x: 400,
      y: 50,
    });
  });

  it("allows character head to reach the top of the monitor", () => {
    // 680-tall window, character near bottom (top at y=400 inside window)
    const clamped = clampWindowForCharacter(
      100,
      -400, // window pushed up so character top would be at monitor y=0
      { x: 50, y: 400, width: 200, height: 260 },
      { x: 0, y: 0, width: 1512, height: 982 },
      48
    );
    expect(clamped.y).toBe(-400);
    // character top = -400 + 400 = 0
  });

  it("keeps a sliver of character on screen when dragged too far up", () => {
    const clamped = clampWindowForCharacter(
      100,
      -700,
      { x: 50, y: 400, width: 200, height: 260 },
      { x: 0, y: 0, width: 1512, height: 982 },
      48
    );
    // charBottom = -700 + 400 + 260 = -40 → push down so bottom is 48
    expect(clamped.y).toBe(-700 + (48 - -40));
  });
});
