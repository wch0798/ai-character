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

export async function getAutomaticProviderStatuses(): Promise<AutomaticProviderStatus[]> {
  return invoke<AutomaticProviderStatus[]>("get_automatic_provider_status");
}

export async function runAutomaticProvider(
  provider: AutomaticApiTarget,
  prompt: string
): Promise<string> {
  return invoke<string>("run_automatic_provider", { provider, prompt });
}

export function classifyAutomaticProviderError(error: unknown): AutomaticProviderHealth {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (text.includes("provider_limited|") || text.includes("resource_exhausted") || text.includes("429")) {
    return "limited";
  }
  if (
    text.includes("provider_not_configured|") ||
    text.includes("provider_disabled|") ||
    text.includes("provider_auth|")
  ) {
    return "unavailable";
  }
  return "unknown";
}
