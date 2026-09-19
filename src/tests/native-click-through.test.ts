import { describe, expect, it } from "vitest";
import { toScreenRegion } from "../native-click-through";

describe("native click-through regions", () => {
  it("논리 좌표를 화면 좌표로 바꾼다", () => {
    expect(toScreenRegion(40, 80, 1.5, { x: 10, y: 20, width: 100, height: 50 })).toEqual({
      x: 55,
      y: 110,
      width: 150,
      height: 75,
    });
  });
});
