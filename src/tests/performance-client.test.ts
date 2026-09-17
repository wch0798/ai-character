import {
  describe,
  expect,
  it,
} from "vitest";

import {
  formatPerformanceText,
  readProcessStats,
} from "../performance-client";

describe("performance client", () => {
  it("Tauri 성능 정보를 읽는다", async () => {
    const fakeInvoke = async (
      command: string
    ) => {
      expect(command).toBe(
        "get_process_stats"
      );

      return [
        3.4,
        128.25,
      ];
    };

    const result =
      await readProcessStats(
        fakeInvoke
      );

    expect(
      result.cpuPercent
    ).toBe(3.4);

    expect(
      result.memoryMb
    ).toBe(128.25);
  });

  it("HUD 문자를 만든다", () => {
    expect(
      formatPerformanceText(
        59.7,
        3.4,
        128.25
      )
    ).toBe(
      "FPS 60 · CPU 3.4% · RAM 128 MB"
    );
  });

  it("캐릭터 상태를 RAM 앞에 넣는다", () => {
    expect(
      formatPerformanceText(
        59.7,
        3.4,
        128.25,
        "쉬는 중"
      )
    ).toBe(
      "FPS 60 · CPU 3.4% · 쉬는 중 · RAM 128 MB"
    );
  });
});
