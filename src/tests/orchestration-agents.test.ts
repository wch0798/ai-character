import { describe, expect, it } from "vitest";
import {
  availableModifyCliTargets,
  normalizePlanForAutomaticProviders,
} from "../orchestration-engine";
import type { OrchestrationPlan, WebAvailability } from "../orchestration-types";

const availability: Record<string, WebAvailability> = {
  claude_web: "unknown",
  chatgpt_web: "unknown",
  gemini_web: "unknown",
};

describe("multi-agent modify assignment", () => {
  it("설치된 CLI를 Cursor부터 나눠 준다", () => {
    expect(
      availableModifyCliTargets(["claude", "cursor", "codex"])
    ).toEqual(["cursor", "codex", "claude"]);
  });

  it("파일 작업을 Cursor와 Codex에 번갈아 맡긴다", () => {
    const plan: OrchestrationPlan = {
      summary: "페이지 만들기",
      tasks: [
        {
          id: "t1",
          title: "HTML",
          target: "gemini_api",
          mode: "modify",
          prompt: "html",
          dependsOn: [],
        },
        {
          id: "t2",
          title: "CSS",
          target: "claude",
          mode: "modify",
          prompt: "css",
          dependsOn: [],
        },
        {
          id: "t3",
          title: "조사",
          target: "gemini_api",
          mode: "analyze",
          prompt: "research",
          dependsOn: [],
        },
      ],
    };

    const normalized = normalizePlanForAutomaticProviders(
      plan,
      ["gemini_api"],
      ["cursor", "codex", "claude"],
      availability
    );

    expect(normalized.tasks[0]?.target).toBe("cursor");
    expect(normalized.tasks[1]?.target).toBe("codex");
    expect(normalized.tasks[2]?.target).toBe("gemini_api");
  });
});
