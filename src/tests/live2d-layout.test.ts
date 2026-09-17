import { describe, expect, it } from "vitest";
import { fitModelToWindow } from "../live2d-layout";

describe("fitModelToWindow", () => {
  it("모델이 창 안에 들어가도록 비율을 계산한다", () => {
    const result = fitModelToWindow(
      1000,
      2000,
      420,
      680
    );

    expect(result.scale).toBeCloseTo(0.306);
    expect(result.x).toBe(210);
    expect(result.y).toBe(680);
  });
});
