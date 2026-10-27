import { describe, expect, it } from "vitest";
import { parseOrchestrationPlan } from "../orchestration-plan";
import { taskTimingText } from "../orchestration-ui";

const start = 1_000_000;
const minutes = (n: number) => start + n * 60_000;

describe("work runs without a time limit; the user sees the estimate", () => {
  it("reads the planner's estimate", () => {
    const plan = parseOrchestrationPlan(
      JSON.stringify({
        summary: "s",
        tasks: [
          { id: "t1", title: "t", target: "claude", mode: "modify", prompt: "p", dependsOn: [], estimateMinutes: 12 },
          { id: "t2", title: "t", target: "claude", mode: "analyze", prompt: "p", dependsOn: [], estimateMinutes: "x" },
        ],
      })
    );
    expect(plan.tasks.map((task) => task.estimateMinutes)).toEqual([12, undefined]);
  });

  it("shows estimate and elapsed time", () => {
    expect(taskTimingText(start, 10, minutes(0.5))).toBe("예상 약 10분 · 방금 시작");
    expect(taskTimingText(start, 10, minutes(12))).toBe("예상 약 10분 · 경과 12분");
    expect(taskTimingText(start, undefined, minutes(3))).toBe("경과 3분");
  });

  it("says when it runs past the estimate, without stopping it", () => {
    expect(taskTimingText(start, 10, minutes(14))).toBe("예상 약 10분 · 경과 14분");
    expect(taskTimingText(start, 10, minutes(16))).toBe("예상 약 10분 · 경과 16분 · 예상보다 오래 걸리는 중 (계속 진행합니다)");
    expect(taskTimingText(start, undefined, minutes(21))).toBe("경과 21분 · 예상보다 오래 걸리는 중 (계속 진행합니다)");
  });
});
