import { invoke } from "@tauri-apps/api/core";
import type { WebAccountSlot } from "./web-accounts";
import type { WebAgentTarget } from "./orchestration-types";

export const WEB_AGENT_LABELS: Record<WebAgentTarget, string> = {
  claude_web: "Claude Web",
  chatgpt_web: "ChatGPT Web",
  gemini_web: "Gemini Web",
};

export async function openWebAgent(target: WebAgentTarget): Promise<WebAccountSlot> {
  return invoke<WebAccountSlot>("open_web_agent", { target });
}

export async function openAlternateWebAgent(
  target: WebAgentTarget,
  excludeAccountId: string
): Promise<WebAccountSlot> {
  return invoke<WebAccountSlot>("open_alternate_web_agent", {
    target,
    excludeAccountId,
  });
}

export async function copyWebAgentPrompt(prompt: string): Promise<void> {
  const text = prompt.trim();
  if (!text) {
    throw new Error("복사할 Web Agent 프롬프트가 없습니다.");
  }
  if (!navigator.clipboard?.writeText) {
    throw new Error("클립보드 쓰기를 사용할 수 없습니다. 프롬프트를 직접 복사해주세요.");
  }
  await navigator.clipboard.writeText(text);
}

/** 기본 계정 슬롯 창 열기 + 프롬프트 복사 */
export async function prepareWebAgentHandoff(
  target: WebAgentTarget,
  prompt: string
): Promise<WebAccountSlot> {
  await copyWebAgentPrompt(prompt);
  return openWebAgent(target);
}

/** 다른 계정 슬롯 창 열기 + 프롬프트 복사 */
export async function prepareAlternateWebAgentHandoff(
  target: WebAgentTarget,
  prompt: string,
  excludeAccountId: string
): Promise<WebAccountSlot> {
  await copyWebAgentPrompt(prompt);
  return openAlternateWebAgent(target, excludeAccountId);
}
