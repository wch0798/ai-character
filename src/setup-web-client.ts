import { invoke } from "@tauri-apps/api/core";

export type SetupWebSection = "welcome" | "folder" | "keys" | "accounts" | "behavior" | "alerts" | "updates" | "finish" | "usage" | "local" | "remote" | "help";

/** Opens the browser setup page served by the app; resolves to its base URL. */
export function openSetupWeb(section?: SetupWebSection): Promise<string> {
  return invoke<string>("open_setup_web", { section: section ?? null });
}
