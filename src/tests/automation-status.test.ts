import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  buildUpcoming,
  cradleStages,
  formatRelative,
  jobNextRunAt,
  overallState,
  recentFeed,
  type JobRuntime,
} from "../automation-status";
import type { ScheduledJob } from "../scheduled-jobs-ui";
import type { UpdateRunStatus } from "../update-client";

const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);
const MIN = 60_000;

const job = (patch: Partial<ScheduledJob>): ScheduledJob => ({
  id: "j",
  kind: "usage_report",
  title: "보고서",
  intervalMinutes: 60,
  enabled: true,
  config: {},
  lastRunAt: null,
  lastStatus: null,
  lastOutput: null,
  ...patch,
});

const idleUpdate: UpdateRunStatus = {
  running: false,
  current: null,
  completed: 0,
  startedAt: null,
  cancelRequested: false,
  lastFinishedAt: NOW - 60 * MIN,
  nextCheckAt: NOW + 60 * MIN,
  pendingRestart: false,
  cradleActive: false,
};

const runtime: JobRuntime = { running: [], nextScanAt: NOW + 5 * MIN, pausedForCradle: false };

describe("formatRelative", () => {
  it("speaks in minutes, hours and days", () => {
    expect(formatRelative(NOW + 10_000, NOW)).toBe("곧");
    expect(formatRelative(NOW - 10_000, NOW)).toBe("방금");
    expect(formatRelative(NOW + 5 * MIN, NOW)).toBe("5분 후");
    expect(formatRelative(NOW - 90 * MIN, NOW)).toBe("1시간 30분 전");
    expect(formatRelative(NOW + 10 * 60 * MIN, NOW)).toBe("10시간 후");
    expect(formatRelative(NOW + 120 * MIN - 5_000, NOW)).toBe("2시간 후");
    expect(formatRelative(NOW + 60 * MIN - 5_000, NOW)).toBe("1시간 후");
    expect(formatRelative(NOW + 3 * 24 * 60 * MIN, NOW)).toBe("3일 후");
  });
});

describe("jobNextRunAt", () => {
  it("waits for the next scan when the job is already due", () => {
    expect(jobNextRunAt(job({ lastRunAt: NOW - 120 * MIN }), runtime, NOW)).toBe(NOW + 5 * MIN);
    expect(jobNextRunAt(job({}), runtime, NOW)).toBe(NOW + 5 * MIN);
  });

  it("uses the due time when it is later than the next scan", () => {
    expect(jobNextRunAt(job({ lastRunAt: NOW - 10 * MIN }), runtime, NOW)).toBe(NOW + 50 * MIN);
  });

  it("returns null for disabled jobs", () => {
    expect(jobNextRunAt(job({ enabled: false }), runtime, NOW)).toBeNull();
  });
});

describe("buildUpcoming", () => {
  it("orders running first, then soonest, and disabled last", () => {
    const jobs = [
      job({ id: "off", title: "꺼진 작업", enabled: false }),
      job({ id: "later", title: "나중", lastRunAt: NOW - 10 * MIN }),
      job({ id: "busy", title: "실행 중" }),
    ];
    const items = buildUpcoming(jobs, { ...runtime, running: ["busy"] }, idleUpdate, true, NOW);
    expect(items.map((item) => item.id)).toEqual(["busy", "later", "updates", "off"]);
    expect(items.find((item) => item.id === "updates")?.progress).toBeCloseTo(0.5);
    expect(items.find((item) => item.id === "later")?.note).toBe("50분 후");
  });

  it("shows updates as paused during CRADLE work and off when every category is disabled", () => {
    const paused = buildUpcoming([], runtime, { ...idleUpdate, cradleActive: true }, true, NOW)[0];
    expect(paused.state).toBe("paused");
    const off = buildUpcoming([], runtime, idleUpdate, false, NOW)[0];
    expect(off).toMatchObject({ state: "off", at: null, note: "꺼짐" });
  });
});

describe("cradleStages", () => {
  const task = (status: string) => ({ status }) as never;

  it("marks the active stage and counts finished work", () => {
    const stages = cradleStages({ status: "running", tasks: [task("completed"), task("running")] });
    expect(stages.map((stage) => stage.state)).toEqual(["done", "active", "todo", "todo"]);
    expect(stages[1].label).toBe("작업 1/2");
  });

  it("flags a failed synthesis after all work finished", () => {
    const stages = cradleStages({ status: "failed", tasks: [task("completed")] });
    expect(stages.map((stage) => stage.state)).toEqual(["done", "done", "failed", "failed"]);
  });

  it("labels a cancelled session", () => {
    const stages = cradleStages({ status: "cancelled", tasks: [task("completed"), task("cancelled")] });
    expect(stages[3]).toMatchObject({ label: "중지됨", state: "failed" });
  });
});

describe("overallState and recentFeed", () => {
  it("prefers running over attention", () => {
    expect(overallState({ running: true, pendingRestart: true }, runtime, [], false)).toBe("running");
    expect(overallState({ running: false, pendingRestart: true }, runtime, [], false)).toBe("attention");
    expect(overallState(idleUpdate, runtime, [job({ lastStatus: "needs_approval" })], false)).toBe("attention");
    expect(overallState(idleUpdate, runtime, [job({ enabled: false, lastStatus: "failed" })], false)).toBe("idle");
  });

  it("merges update history and job runs newest first", () => {
    const feed = recentFeed(
      [
        { id: 1, category: "cli", target: "claude", fromVersion: "1", toVersion: "2", status: "updated", message: null, createdAt: NOW - 30 * MIN },
        { id: 2, category: "cli", target: "gemini", fromVersion: "1", toVersion: "2", status: "rolled_back", message: "boom", createdAt: NOW - 60 * MIN },
      ],
      [job({ title: "보고서", lastRunAt: NOW - 5 * MIN, lastStatus: "needs_approval" })]
    );
    expect(feed.map((item) => [item.label, item.tone, item.detail])).toEqual([
      ["예약 · 보고서", "warn", "승인 필요"],
      ["업데이트 · claude", "ok", "1 → 2"],
      ["업데이트 · gemini", "fail", "실패 · 이전 버전 유지"],
    ]);
  });
});
