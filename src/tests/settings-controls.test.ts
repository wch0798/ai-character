import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { describeRemoval, type ApiKeyStatus } from "../api-keys-ui";
import { clampNumber, withBusy } from "../settings-controls";

function key(extra: Partial<ApiKeyStatus>): ApiKeyStatus {
  return { name: "GEMINI_API_KEY", label: "Gemini", configured: false, source: null, testable: true, ...extra };
}

describe("settings controls", () => {
  it("rounds and clamps numbers because the backend stores integers", () => {
    expect(clampNumber("2.5", 1, 168, 6)).toBe(3);
    expect(clampNumber("0", 1, 168, 6)).toBe(1);
    expect(clampNumber("999", 1, 168, 6)).toBe(168);
    expect(clampNumber("abc", 1, 168, 6)).toBe(6);
  });

  it("re-enables buttons even when the task fails", async () => {
    const button = { disabled: false } as HTMLButtonElement;
    const seen: boolean[] = [];
    await expect(
      withBusy([button], async () => {
        seen.push(button.disabled);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(seen).toEqual([true]);
    expect(button.disabled).toBe(false);
  });

  it("explains when a removed key is still provided elsewhere", () => {
    expect(describeRemoval(key({}), "Gemini")).toBe("Gemini 키를 지웠습니다.");
    expect(describeRemoval(key({ configured: true, source: "/p/.env" }), "Gemini")).toContain("/p/.env에 남아");
    expect(describeRemoval(key({ configured: true, source: "환경변수" }), "Gemini")).toContain("시스템 환경변수");
  });
});
