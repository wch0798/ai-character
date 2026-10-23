import { describe, expect, it } from "vitest";
import { rectsFromBoxes, silhouetteFits } from "../character-silhouette";

describe("character outline for click-through", () => {
  it("covers each part and leaves the space between parts open", () => {
    // A head above a body, with empty space to the right of the head.
    const rects = rectsFromBoxes([
      { x: 100, y: 0, width: 40, height: 40 },
      { x: 80, y: 60, width: 80, height: 100 },
    ], 10, 0);
    const covers = (x: number, y: number) => rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
    expect(covers(120, 20)).toBe(true);
    expect(covers(100, 100)).toBe(true);
    expect(covers(200, 20)).toBe(false);
    expect(covers(85, 20)).toBe(false);
    expect(rects.length).toBeLessThan(6);
  });

  it("ignores broken boxes", () => {
    expect(rectsFromBoxes([{ x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 5 }])).toEqual([]);
  });

  it("only trusts an outline that sits inside the old box", () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    expect(silhouetteFits([{ x: 10, y: 10, width: 50, height: 50 }], box)).toBe(true);
    expect(silhouetteFits([{ x: 500, y: 500, width: 50, height: 50 }], box)).toBe(false);
    expect(silhouetteFits([], box)).toBe(false);
  });
});
