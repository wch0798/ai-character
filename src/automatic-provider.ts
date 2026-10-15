import { invoke } from "@tauri-apps/api/core";
import type { AutomaticApiTarget } from "./orchestration-types";

export type AutomaticProviderStatus = {
  provider: AutomaticApiTarget;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  model: string;
  costClass: "free_first" | "paid_opt_in" | string;
  reason: string | null;
};

export type AutomaticProviderHealth = "unknown" | "available" | "limited" | "unavailable";

export type AutomaticCallContext = {
  sessionId?: string | null;
  taskId?: string | null;
  role?: string | null;
  cacheFingerprint?: string | null;
  /** When set, free providers stream partial text as `provider-stream` events with this id. */
  streamId?: string | null;
};

export type ProviderStreamEvent = {
  streamId: string;
  reset: boolean;
  text: string;
};

export type PolicySettings = {
  openrouterEnabled: boolean;
  maxCallsPerSession: number;
  maxRetriesPerCall: number;
  paidMaxCallsPerApproval: number;
  paidApprovalMinutes: number;
  promptCacheEnabled: boolean;
  estimatedPaidUsdPer1kTokens: number;
};

export const FREE_AUTOMATIC_PROVIDERS: readonly AutomaticApiTarget[] = ["gemini_api", "openrouter_api", "free_pool_api"];

export function isFreeAutomaticProvider(provider: AutomaticApiTarget): boolean {
  return FREE_AUTOMATIC_PROVIDERS.includes(provider);
}

export async function getAutomaticProviderStatuses(): Promise<AutomaticProviderStatus[]> {
  return invoke<AutomaticProviderStatus[]>("get_automatic_provider_status");
}

export async function runAutomaticProvider(
  provider: AutomaticApiTarget,
  prompt: string,
  context: AutomaticCallContext = {}
): Promise<string> {
  return invoke<string>("run_automatic_provider", {
    provider,
    prompt,
    sessionId: context.sessionId ?? null,
    taskId: context.taskId ?? null,
    role: context.role ?? null,
    cacheFingerprint: context.cacheFingerprint ?? null,
    streamId: context.streamId ?? null,
  });
}

/** Shows a native confirmation dialog; resolves true only when the user approves the paid call. */
export async function requestPaidApproval(
  provider: AutomaticApiTarget,
  reason: string,
  sessionId: string | null
): Promise<boolean> {
  try {
    return await invoke<boolean>("request_paid_approval", { provider, reason, sessionId });
  } catch (error) {
    console.warn("유료 API 승인 요청 실패", error);
    return false;
  }
}

export async function requestRiskyActionApproval(action: string, detail: string): Promise<boolean> {
  try {
    return await invoke<boolean>("request_risky_action_approval", { action, detail });
  } catch (error) {
    console.warn("고위험 동작 승인 요청 실패", error);
    return false;
  }
}

export async function getPolicySettings(): Promise<PolicySettings> {
  return invoke<PolicySettings>("get_policy_settings");
}

export async function setPolicySettings(policy: PolicySettings): Promise<PolicySettings> {
  return invoke<PolicySettings>("set_policy_settings", { policy });
}

export async function refreshFreeModels(force = false): Promise<unknown> {
  return invoke("refresh_free_models", { force });
}

export function classifyAutomaticProviderError(error: unknown): AutomaticProviderHealth {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    text.includes("provider_limited|") ||
    text.includes("budget_exceeded|") ||
    text.includes("resource_exhausted") ||
    text.includes("429")
  ) {
    return "limited";
  }
  if (
    text.includes("provider_not_configured|") ||
    text.includes("provider_disabled|") ||
    text.includes("provider_auth|") ||
    text.includes("paid_approval_required|")
  ) {
    return "unavailable";
  }
  return "unknown";
}
