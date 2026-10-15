import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { newlyWaitingWeb, notificationPreview, shouldNotifyCompletion, usageMeter } from "../alerts-client";
import { parseCostLimit } from "../alerts-ui";

describe("alerts", () => {
  it("notifies only for long work while the user looks elsewhere", () => {
    expect(shouldNotifyCompletion(5_000, false, false)).toBe(false);
    expect(shouldNotifyCompletion(25_000, true, true)).toBe(false);
    expect(shouldNotifyCompletion(25_000, false, true)).toBe(true);
    expect(shouldNotifyCompletion(25_000, true, false)).toBe(true);
  });

  it("strips markdown from notification text", () => {
    expect(notificationPreview("## 결과\n**완료** [링크](https://x)\n```ts\ncode\n```")).toBe("결과 완료 링크 [코드]");
    expect(notificationPreview("a".repeat(200), 10)).toHaveLength(10);
  });

  it("detects tasks that just started waiting for the web", () => {
    const before = [{ id: "a", status: "running" }, { id: "b", status: "waiting_web" }];
    const after = [
      { id: "a", status: "waiting_web", title: "A" },
      { id: "b", status: "waiting_web", title: "B" },
      { id: "c", status: "queued", title: "C" },
    ];
    expect(newlyWaitingWeb(before, after)).toEqual(["A"]);
  });

  it("colors usage meters by ratio", () => {
    expect(usageMeter(0.5, 1)).toEqual({ ratio: 0.5, tone: "ok" });
    expect(usageMeter(0.8, 1).tone).toBe("warn");
    expect(usageMeter(3, 1)).toEqual({ ratio: 1, tone: "over" });
    expect(usageMeter(5, 0)).toEqual({ ratio: 0, tone: "ok" });
  });

  it("keeps cents in the cost limit", () => {
    expect(parseCostLimit("2.345", 1)).toBe(2.35);
    expect(parseCostLimit("abc", 1)).toBe(1);
    expect(parseCostLimit("-3", 1)).toBe(0);
  });
});
