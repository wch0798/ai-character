import { describe, expect, it } from "vitest";
import {
  managerProviderOrder,
  normalizePlanForAutomaticProviders,
  usableAutomaticProviders,
} from "../orchestration-engine";
import {
  classifyAutomaticProviderError,
  isFreeAutomaticProvider,
  type AutomaticProviderStatus,
} from "../automatic-provider";
import { parseOrchestrationPlan } from "../orchestration-plan";
import type { AutomaticApiTarget, OrchestrationPlan, WebAvailability } from "../orchestration-types";

const availability: Record<string, WebAvailability> = {
  claude_web: "unknown",
  chatgpt_web: "unknown",
  gemini_web: "unknown",
};

function status(provider: AutomaticApiTarget, available: boolean): AutomaticProviderStatus {
  return { provider, enabled: available, configured: available, available, model: "m", costClass: "free_first", reason: null };
}

const freshHealth = () => ({
  gemini_api: "unknown",
  openrouter_api: "unknown",
  free_pool_api: "unknown",
  openai_api: "unknown",
}) as const;

describe("Cloud-First 무료 우선 라우팅", () => {
  it("무료 Provider를 유료보다 먼저 고른다", () => {
    const providers = usableAutomaticProviders(
      [status("openai_api", true), status("openrouter_api", true), status("gemini_api", true)],
      { geminiApiEnabled: true, allowPaidOpenAiApi: true },
      { ...freshHealth() }
    );
    expect(providers).toEqual(["gemini_api", "openrouter_api", "openai_api"]);
  });

  it("유료 허용이 꺼져 있으면 OpenAI를 제외한다", () => {
    const providers = usableAutomaticProviders(
      [status("openai_api", true), status("openrouter_api", true)],
      { geminiApiEnabled: true, allowPaidOpenAiApi: false },
      { ...freshHealth() }
    );
    expect(providers).toEqual(["openrouter_api"]);
  });

  it("한도 초과로 기억된 Provider는 건너뛴다", () => {
    const providers = usableAutomaticProviders(
      [status("gemini_api", true), status("openrouter_api", true)],
      { geminiApiEnabled: true, allowPaidOpenAiApi: false },
      { ...freshHealth(), gemini_api: "limited" }
    );
    expect(providers).toEqual(["openrouter_api"]);
  });

  it("총괄 순서는 무료 API → Claude CLI → 유료 API", () => {
    expect(managerProviderOrder(["gemini_api", "openrouter_api", "openai_api"], true)).toEqual([
      "gemini_api",
      "openrouter_api",
      "claude_cli",
      "openai_api",
    ]);
    expect(managerProviderOrder(["openai_api"], false)).toEqual(["openai_api"]);
  });

  it("무료 Provider 판별", () => {
    expect(isFreeAutomaticProvider("gemini_api")).toBe(true);
    expect(isFreeAutomaticProvider("openrouter_api")).toBe(true);
    expect(isFreeAutomaticProvider("free_pool_api")).toBe(true);
    expect(isFreeAutomaticProvider("openai_api")).toBe(false);
  });

  it("추가 무료 AI 모음은 OpenRouter 다음, 유료 OpenAI 앞에 온다", () => {
    const providers = usableAutomaticProviders(
      [status("openai_api", true), status("free_pool_api", true), status("openrouter_api", true), status("gemini_api", true)],
      { geminiApiEnabled: true, allowPaidOpenAiApi: true },
      { ...freshHealth() }
    );
    expect(providers).toEqual(["gemini_api", "openrouter_api", "free_pool_api", "openai_api"]);
    expect(managerProviderOrder(providers, true)).toEqual([
      "gemini_api",
      "openrouter_api",
      "free_pool_api",
      "claude_cli",
      "openai_api",
    ]);
  });

  it("Gemini·OpenRouter가 한도에 걸려도 추가 무료 AI로 이어 간다", () => {
    const providers = usableAutomaticProviders(
      [status("gemini_api", true), status("openrouter_api", true), status("free_pool_api", true)],
      { geminiApiEnabled: true, allowPaidOpenAiApi: false },
      { ...freshHealth(), gemini_api: "limited", openrouter_api: "limited" }
    );
    expect(providers).toEqual(["free_pool_api"]);
  });

  it("예산 초과·승인 필요 오류를 분류한다", () => {
    expect(classifyAutomaticProviderError("BUDGET_EXCEEDED|session|x")).toBe("limited");
    expect(classifyAutomaticProviderError("PAID_APPROVAL_REQUIRED|openai_api|x")).toBe("unavailable");
  });

  it("계획에서 openai_api 분석 작업은 무료 Provider로 옮긴다", () => {
    const plan: OrchestrationPlan = {
      summary: "분석",
      tasks: [
        { id: "a", title: "a", target: "openai_api", mode: "analyze", prompt: "p", dependsOn: [] },
        { id: "b", title: "b", target: "gemini_api", mode: "analyze", prompt: "p", dependsOn: [] },
      ],
    };
    const normalized = normalizePlanForAutomaticProviders(plan, ["openrouter_api", "openai_api"], [], availability);
    expect(normalized.tasks[0]?.target).toBe("openrouter_api");
    expect(normalized.tasks[1]?.target).toBe("openrouter_api");
  });

  it("계획 파서가 openrouter_api 대상을 허용한다", () => {
    const plan = parseOrchestrationPlan(
      JSON.stringify({
        summary: "s",
        tasks: [{ id: "t1", title: "t", target: "openrouter_api", mode: "analyze", prompt: "p", dependsOn: [] }],
      })
    );
    expect(plan.tasks[0]?.target).toBe("openrouter_api");
  });
});
