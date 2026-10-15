import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { compactNumber, providerLabel, usageBrief, type UsageReport } from "../usage-brief";

const base: UsageReport = { days: 1, today: "2026-10-14", generatedAt: 0 };

describe("usage brief", () => {
  it("shows cost against the daily limit with a meter", () => {
    const lines = usageBrief({
      ...base,
      alerts: { calls: 12, paidCalls: 2, costUsd: 0.85, dailyCostLimitUsd: 1, level: "warn" },
    });
    expect(lines[0]).toMatchObject({ label: "오늘 유료 비용", value: "$0.85 / $1", tone: "warn" });
    expect(lines[0].pct).toBeCloseTo(85);
    expect(lines[1].value).toBe("12회 (유료 2)");
  });

  it("marks a blocked day as over and handles no limit", () => {
    expect(usageBrief({ ...base, alerts: { calls: 1, paidCalls: 0, costUsd: 0, dailyCostLimitUsd: 1, level: "ok", paidBlocked: true } })[0].tone).toBe("over");
    const unlimited = usageBrief({ ...base, alerts: { calls: 0, paidCalls: 0, costUsd: 0, dailyCostLimitUsd: 0, level: "ok" } })[0];
    expect(unlimited.value).toContain("한도 없음");
    expect(unlimited.pct).toBeUndefined();
  });

  it("lists the busiest providers, Claude today and Codex limits", () => {
    const lines = usageBrief({
      ...base,
      app: { available: true, summary: { providers: [{ provider: "openrouter_api", calls: 3, errors: 0 }, { provider: "gemini_api", calls: 9, errors: 1 }, { provider: "openai_api", calls: 0, errors: 0 }] } },
      claude: { available: true, today: { total: 1_250_000, count: 40 } },
      codex: { available: true, meters: [{ label: "주간 한도", pct: 92.4 }] },
    });
    expect(lines.find((l) => l.label === "가장 많이 쓴 AI")?.value).toBe("Gemini 9 · OpenRouter 3");
    expect(lines.find((l) => l.label === "Claude 구독 (오늘)")?.value).toBe("응답 40회 · 1.3M 토큰");
    expect(lines.find((l) => l.label === "Codex 주간 한도")).toMatchObject({ value: "92% 사용", tone: "over" });
  });

  it("formats numbers and provider ids", () => {
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(1500)).toBe("1.5K");
    expect(providerLabel("gemini_api")).toBe("Gemini");
    expect(providerLabel("mystery_api")).toBe("mystery");
  });
});
