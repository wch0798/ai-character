import { describe, expect, it } from "vitest";
import {
  compactWorkerOutput,
  parseWorkerResultEnvelope,
} from "../worker-result";

describe("worker result envelope", () => {
  it("웹/API JSON 결과를 짧은 envelope로 유지한다", () => {
    const raw = JSON.stringify({
      summary: "Gemini API가 무료 우선 경로다",
      findings: ["공식 API를 먼저 쓴다", "웹 복사는 최후 수단"],
      sources: ["https://example.com"],
      nextAction: null,
    });
    const compact = compactWorkerOutput(raw);
    const parsed = parseWorkerResultEnvelope(compact);
    expect(parsed?.summary).toContain("무료 우선");
    expect(parsed?.findings).toHaveLength(2);
    expect(compact.length).toBeLessThan(raw.length + 20);
  });

  it("긴 산문을 JSON summary로 축약한다", () => {
    const prose = "결과입니다. ".repeat(400);
    const compact = compactWorkerOutput(prose, "analyze", 200);
    const parsed = parseWorkerResultEnvelope(compact);
    expect(parsed).not.toBeNull();
    expect(parsed?.summary.length).toBeLessThanOrEqual(200);
  });

  it("파일 수정 결과는 패치를 버리지 않는다", () => {
    const patch = "diff --git a/src/main.ts\n@@\n+const x = 1;\n".repeat(20);
    const compact = compactWorkerOutput(patch, "modify");
    expect(compact).toContain("diff --git");
    expect(compact.startsWith("{")).toBe(false);
  });
});
