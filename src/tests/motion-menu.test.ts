import { describe, expect, it } from "vitest";
import { buildMotionChoices } from "../motion-menu";

describe("buildMotionChoices", () => {
  it("모션 그룹과 개별 행동 목록을 만든다", () => {
    expect(
      buildMotionChoices({
        Idle: 2,
        TapBody: 1,
      })
    ).toEqual([
      {
        label: "Idle 랜덤",
        group: "Idle",
      },
      {
        label: "Idle 1",
        group: "Idle",
        index: 0,
      },
      {
        label: "Idle 2",
        group: "Idle",
        index: 1,
      },
      {
        label: "TapBody 랜덤",
        group: "TapBody",
      },
      {
        label: "TapBody 1",
        group: "TapBody",
        index: 0,
      },
    ]);
  });
});
