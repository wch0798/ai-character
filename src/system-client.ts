import { invoke } from "@tauri-apps/api/core";

/** The show/hide shortcut, e.g. "ctrl+shift+space". */
export async function getToggleShortcut(): Promise<string> {
  return invoke<string>("get_toggle_shortcut");
}

/** Registers a new show/hide shortcut (null = default); rejects with a Korean reason. */
export async function setToggleShortcut(shortcut: string | null): Promise<string> {
  return invoke<string>("set_toggle_shortcut", { shortcut });
}

export async function getAutostart(): Promise<boolean> {
  return invoke<boolean>("get_autostart");
}

export async function setAutostart(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_autostart", { enabled });
}

export async function logFrontendError(message: string): Promise<void> {
  await invoke("log_frontend_error", { message });
}

export async function openLogFolder(): Promise<string> {
  return invoke<string>("open_log_folder");
}

/** A summary (version, OS, sign-ins, recent log) without any keys, to paste when asking for help. */
export async function getDiagnostics(): Promise<string> {
  const result = await invoke<{ text: string }>("get_diagnostics");
  return result.text;
}

/** Opens Windows voice typing (Win+H) for the focused input. */
export async function startVoiceTyping(): Promise<void> {
  await invoke("start_voice_typing");
}
