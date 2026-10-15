import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { customShellJob, describeInterval, describeJobStatus, describeRun, formatDuration, intervalChoices } from "../scheduled-jobs-ui";

describe("job run history", () => {
  it("formats durations and run summaries", () => {
    expect(formatDuration(400)).toBe("1초 미만");
    expect(formatDuration(3_240)).toBe("3.2초");
    expect(formatDuration(42_000)).toBe("42초");
    expect(formatDuration(125_000)).toBe("2분 5초");
    expect(formatDuration(120_000)).toBe("2분");
    expect(describeRun({ status: "cancelled", output: "", startedAt: 0, durationMs: 1_500 })).toMatch(/중지됨 · 1\.5초$/);
    expect(describeRun({ status: "weird", output: "", startedAt: 0, durationMs: 0 })).toMatch(/실패/);
  });
});

describe("scheduled jobs UI helpers", () => {
  it("describes intervals in the largest whole unit", () => {
    expect(describeInterval(1440)).toBe("1일마다");
    expect(describeInterval(10080)).toBe("7일마다");
    expect(describeInterval(120)).toBe("2시간마다");
    expect(describeInterval(45)).toBe("45분마다");
  });

  it("describes job status", () => {
    expect(describeJobStatus({ enabled: false, lastStatus: null, lastRunAt: null })).toBe("꺼짐");
    expect(describeJobStatus({ enabled: true, lastStatus: null, lastRunAt: null })).toBe("아직 실행 안 함");
    expect(describeJobStatus({ enabled: true, lastStatus: "failed", lastRunAt: 1 })).toMatch(/실패$/);
    expect(describeJobStatus({ enabled: true, lastStatus: "needs_approval", lastRunAt: 1 })).toMatch(/승인 필요$/);
    expect(describeJobStatus({ enabled: true, lastStatus: "cancelled", lastRunAt: 1 })).toMatch(/중지됨$/);
  });

  it("offers interval presets and keeps a custom current value", () => {
    expect(intervalChoices(1440)).toEqual([60, 360, 720, 1440, 10080]);
    expect(intervalChoices(90)).toEqual([60, 90, 360, 720, 1440, 10080]);
  });

  it("builds custom shell jobs with a safe id and minimum interval", () => {
    const job = customShellJob("", "  npm run lint  ", 1);
    expect(job.id).toMatch(/^custom-[0-9a-z]+$/);
    expect(job.kind).toBe("shell");
    expect(job.title).toBe("npm run lint");
    expect(job.intervalMinutes).toBe(5);
    expect(job.config).toEqual({ command: "npm run lint" });
  });
});
