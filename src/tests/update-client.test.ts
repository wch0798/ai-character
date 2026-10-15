import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));

import {
  describeOutcome,
  needsRestart,
  runUpdatesNow,
  setCradleActivity,
  summarizeOutcomes,
  type UpdateOutcome,
} from "../update-client";
import { UPDATE_CATEGORIES } from "../update-ui";

function outcome(status: UpdateOutcome["status"], extra: Partial<UpdateOutcome> = {}): UpdateOutcome {
  return { category: "cli", target: "codex", fromVersion: null, toVersion: null, status, message: null, ...extra };
}

describe("update client", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("swallows errors when signalling CRADLE activity", async () => {
    invokeMock.mockRejectedValueOnce(new Error("not ready"));
    await expect(setCradleActivity(true)).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("set_cradle_activity", { active: true });
  });

  it("passes selected categories to run_updates_now", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await runUpdatesNow(["clis"]);
    expect(invokeMock).toHaveBeenCalledWith("run_updates_now", { categories: ["clis"] });
  });

  it("describes version changes and failure reasons", () => {
    expect(describeOutcome(outcome("updated", { fromVersion: "1.0", toVersion: "1.1" }))).toBe(
      "codex 1.0 → 1.1: 업데이트 완료"
    );
    expect(describeOutcome(outcome("rolled_back", { message: "npm error\ndetails" }))).toBe(
      "codex: 실패하여 이전 버전 유지 (npm error)"
    );
  });

  it("summarizes outcomes by status", () => {
    const summary = summarizeOutcomes([
      outcome("updated"),
      outcome("pending_restart"),
      outcome("current"),
      outcome("failed"),
      outcome("skipped"),
    ]);
    expect(summary).toBe("업데이트 2건 · 최신 1건 · 실패 1건(이전 버전 유지) · 건너뜀 1건");
    expect(summarizeOutcomes([])).toBe("확인할 대상이 없습니다.");
  });

  it("offers a restart only when an app update is waiting", () => {
    expect(needsRestart([outcome("updated"), outcome("current")])).toBe(false);
    expect(needsRestart([outcome("pending_restart")])).toBe(true);
  });

  it("lists every auto-update category in the settings UI", () => {
    expect(UPDATE_CATEGORIES.map((category) => category.key)).toEqual(["app", "clis", "plugins", "models"]);
  });
});
