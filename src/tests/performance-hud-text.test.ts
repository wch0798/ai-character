import { describe, expect, it } from "vitest";
import { patchPerformanceHudActivity } from "../performance-hud-text";

describe("patchPerformanceHudActivity", () => {
  it("상태만 바꾸고 RAM을 유지한다", () => {
    expect(
      patchPerformanceHudActivity(
        "FPS 60 · CPU 3.4% · RAM 128 MB",
        "쉬는 중"
      )
    ).toBe("FPS 60 · CPU 3.4% · 쉬는 중 · RAM 128 MB");
  });

  it("이미 상태가 있어도 RAM을 상태 라벨로 덮어쓰지 않는다", () => {
    expect(
      patchPerformanceHudActivity(
        "FPS 60 · CPU 3.4% · 일하는 중 · RAM 128 MB",
        "쉬는 중"
      )
    ).toBe("FPS 60 · CPU 3.4% · 쉬는 중 · RAM 128 MB");
  });

  it("RAM이 빠진 문자열이면 RAM -- 로 복구한다", () => {
    expect(
      patchPerformanceHudActivity(
        "FPS 60 · CPU 3.4% · 쉬는 중",
        "쉬는 중"
      )
    ).toBe("FPS 60 · CPU 3.4% · 쉬는 중 · RAM --");
  });
});
