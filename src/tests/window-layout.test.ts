import { describe, expect, it } from "vitest";
import {
  characterBodyWidth,
  characterCenterXForChat,
  characterDisplaySize,
  characterPaneWidthForChat,
  chatLeftForCharacterLayout,
  compactWindowSizeForCharacter,
  maxCharacterScaleBesideChat,
  maxCharacterScaleForMonitor,
  stepCharacterScale,
  visualSizePercent,
  occupancyFromModelBounds,
  pickVisualModelBox,
  characterScaleForPreset,
  logicalWorkArea,
  scaleFromVisualPercent,
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

  it("attaches chat to the full visible character, not just the hit body", () => {
    const display = characterDisplaySize(2000, 3000, 0.1);
    expect(display).toEqual({ width: 200, height: 300 });
    const body = characterBodyWidth(display.width, 0.72);
    expect(body).toBeCloseTo(144);
    const center = characterCenterXForChat(display.width, 10);
    expect(center).toBe(110);
    expect(chatLeftForCharacterLayout(center, display.width, 6, 980)).toBe(216);
    expect(characterPaneWidthForChat(display.width)).toBe(216);
  });

  it("uses Live2D mesh bounds when they belong to the character", () => {
    const occupancy = occupancyFromModelBounds(200, 110, { x: 20, width: 240 });
    expect(occupancy.occupancyWidth).toBe(240);
    expect(occupancy.centerX).toBe(140);
    expect(chatLeftForCharacterLayout(occupancy.centerX, occupancy.occupancyWidth, 12, 980)).toBe(272);
  });

  it("ignores high-DPI bounds that look like physical pixels", () => {
    const occupancy = occupancyFromModelBounds(
      200,
      110,
      { x: 0, width: 300 },
      10,
      1.28,
      1.5
    );
    expect(occupancy.occupancyWidth).toBe(200);
    expect(occupancy.centerX).toBe(110);
  });

  it("ignores Cubism local boxes that are many times larger than the on-screen character", () => {
    const occupancy = occupancyFromModelBounds(180, 100, { x: 40, width: 1400 });
    expect(occupancy.occupancyWidth).toBe(180);
    expect(occupancy.centerX).toBe(100);
  });

  it("picks the bounds closest to the displayed character width", () => {
    expect(
      pickVisualModelBox(180, {
        x: 10,
        width: 190,
        rectangle: { x: 0, width: 2400 },
      })
    ).toEqual({ x: 10, width: 190 });
  });

  it("does not pull chat over a larger character when the window is still small", () => {
    const center = characterCenterXForChat(700, 10);
    expect(chatLeftForCharacterLayout(center, 700, 6, 760, 480)).toBe(716);
  });

  it("limits scale beside chat so both fit on the monitor", () => {
    expect(
      maxCharacterScaleBesideChat(2000, 3000, 1400, 900, 560)
    ).toBeCloseTo(0.296, 3);
  });

  it("limits scale so enlarged character still fits", () => {
    expect(maxCharacterScaleForMonitor(2000, 3000, 400, 600)).toBeCloseTo(0.2);
  });

  it("reports size against the large preset, not raw Live2D scale", () => {
    expect(visualSizePercent(0.045, 0.113)).toBe(40);
    expect(visualSizePercent(0.113, 0.113)).toBe(100);
  });

  it("steps wheel size by a slice of the large preset", () => {
    expect(stepCharacterScale(0.08, "up", 0.1, 1)).toBeCloseTo(0.09, 3);
    expect(stepCharacterScale(0.08, "down", 0.1, 1, 0.04)).toBeCloseTo(0.07, 3);
    expect(stepCharacterScale(0.5, "up", 0.1, 0.505)).toBeCloseTo(0.505, 3);
  });

  it("sizes presets from the monitor work area, not a fixed 980 window", () => {
    const laptop = characterScaleForPreset(2000, 3000, 0.28, 1280, 720);
    const fourK = characterScaleForPreset(2000, 3000, 0.28, 3840, 2160);
    expect(fourK).toBeGreaterThan(laptop * 2);
    expect(3000 * laptop).toBeLessThan(720 * 0.4);
  });

  it("maps visual percent onto this monitor's large preset", () => {
    expect(scaleFromVisualPercent(100, 0.2, 0.08, 0.3)).toBeCloseTo(0.2);
    expect(scaleFromVisualPercent(200, 0.2, 0.08, 0.22)).toBeCloseTo(0.22);
  });

  it("converts physical monitor pixels to CSS work area", () => {
    expect(
      logicalWorkArea({ size: { width: 1920, height: 1080 } }, 1.5)
    ).toEqual({ width: 1280, height: 720 });
  });
});
