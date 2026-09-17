import { describe, expect, it } from "vitest";
import {
  characterBodyWidth,
  characterCenterXForChat,
  characterDisplaySize,
  chatLeftForCharacterLayout,
  compactWindowSizeForCharacter,
  maxCharacterScaleForMonitor,
} from "../window-layout";

describe("character / chat layout", () => {
  it("sizes compact window from display size and caps to monitor", () => {
    expect(
      compactWindowSizeForCharacter(180, 320, {
        padding: 16,
        hudExtra: 30,
        maxWidth: 400,
        maxHeight: 500,
      })
    ).toEqual({ width: 220, height: 382 });

    expect(
      compactWindowSizeForCharacter(800, 900, {
        padding: 16,
        maxWidth: 400,
        maxHeight: 500,
      })
    ).toEqual({ width: 400, height: 500 });
  });

  it("attaches chat to visible body, not full Live2D canvas", () => {
    const display = characterDisplaySize(2000, 3000, 0.1);
    expect(display).toEqual({ width: 200, height: 300 });
    const body = characterBodyWidth(display.width, 0.72);
    expect(body).toBeCloseTo(144);
    const center = characterCenterXForChat(display.width, 10);
    // full model starts at x=10, center=110
    expect(center).toBe(110);
    // body right = 110 + 72 = 182, chat at 188
    expect(chatLeftForCharacterLayout(center, body, 6, 980)).toBe(188);
  });

  it("limits scale so enlarged character still fits", () => {
    expect(maxCharacterScaleForMonitor(2000, 3000, 400, 600)).toBeCloseTo(0.2);
  });
});
