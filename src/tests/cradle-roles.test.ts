import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));

const { parseOrchestrationPlan } = await import("../orchestration-plan");
const { testerResultWithoutModel } = await import("../orchestration-engine");
const { failingTestLogs, summarizeTestRun } = await import("../cradle-workspace-client");

function plan(task: Record<string, unknown>): string {
  return JSON.stringify({
    summary: "s",
    tasks: [{ id: "t1", title: "t", target: "gemini_api", prompt: "p", dependsOn: [], ...task }],
  });
}

describe("CRADLE 역할 분담", () => {
  it("역할이 없으면 mode에서 추론한다", () => {
    expect(parseOrchestrationPlan(plan({ mode: "modify", target: "codex" })).tasks[0]?.role).toBe("coder");
    expect(parseOrchestrationPlan(plan({ mode: "analyze" })).tasks[0]?.role).toBe("reviewer");
  });

  it("coder 역할은 항상 modify, tester/planner는 analyze로 맞춘다", () => {
    expect(parseOrchestrationPlan(plan({ role: "coder", mode: "analyze", target: "codex" })).tasks[0]?.mode).toBe("modify");
    expect(parseOrchestrationPlan(plan({ role: "tester", mode: "modify" })).tasks[0]?.mode).toBe("analyze");
    expect(parseOrchestrationPlan(plan({ role: "planner", mode: "modify" })).tasks[0]?.mode).toBe("analyze");
  });

  it("알 수 없는 역할은 거절한다", () => {
    expect(() => parseOrchestrationPlan(plan({ role: "hacker" }))).toThrow(/role/);
  });
});

describe("Tester 결과 전달", () => {
  const passed = { detected: true, passed: true, skipped: [], results: [{ command: "npm test", passed: true, exitCode: 0, timedOut: false, durationMs: 10, output: "ok" }] };
  const failed = { detected: true, passed: false, skipped: [], results: [{ command: "cargo test", passed: false, exitCode: 101, timedOut: false, durationMs: 20, output: "assertion failed" }] };

  it("통과하면 모델 호출 없이 결과를 만든다", () => {
    const result = testerResultWithoutModel(passed);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!).summary).toContain("통과");
  });

  it("실패하면 무료 API 분석으로 넘긴다", () => {
    expect(testerResultWithoutModel(failed)).toBeNull();
    expect(failingTestLogs(failed)).toContain("$ cargo test\nassertion failed");
  });

  it("요약은 로그 없이 JSON으로 넘긴다", () => {
    const summary = JSON.parse(summarizeTestRun(failed));
    expect(summary.tests).toBe("failed");
    expect(summary.commands[0]).toEqual({ command: "cargo test", passed: false, exitCode: 101, timedOut: false, durationMs: 20 });
    expect(JSON.parse(summarizeTestRun({ detected: false, passed: true, results: [], skipped: [] })).tests).toBe("not_detected");
  });
});
