import { describe, expect, it } from "vitest";
import {
  CHARACTER_ACTIVITY_LABELS,
  activityFromCradleStatus,
  motionCueForActivity,
  workSway,
} from "../character-activity";

describe("character activity", () => {
  it("쉬는 중 / 일하는 중 / 끝났다는 라벨이 있다", () => {
    expect(CHARACTER_ACTIVITY_LABELS.idle).toBe("쉬는 중");
    expect(CHARACTER_ACTIVITY_LABELS.working).toBe("일하는 중");
    expect(CHARACTER_ACTIVITY_LABELS.done).toBe("끝났다");
  });

  it("CRADLE 진행 상태를 캐릭터 활동으로 바꾼다", () => {
    expect(activityFromCradleStatus("planning")).toBe("working");
    expect(activityFromCradleStatus("running")).toBe("working");
    expect(activityFromCradleStatus("synthesizing")).toBe("working");
    expect(activityFromCradleStatus("completed")).toBe("done");
    expect(activityFromCradleStatus("failed")).toBe("error");
    expect(activityFromCradleStatus("idle")).toBeNull();
  });

  it("일하는 중에는 반복 모션, 쉴 때는 Idle을 쓴다", () => {
    expect(motionCueForActivity("idle")).toEqual({
      group: "Idle",
      priority: 1,
      loopMs: null,
    });
    expect(motionCueForActivity("working").group).toBe("TapBody");
    expect(motionCueForActivity("working").loopMs).toBe(2600);
    expect(motionCueForActivity("done").group).toBe("TapBody");
  });

  it("일하는 중 흔들림이 0이 아니다", () => {
    const sway = workSway(400);
    expect(Math.abs(sway.rotation) + Math.abs(sway.y)).toBeGreaterThan(0);
  });
});
