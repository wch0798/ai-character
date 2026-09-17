import { invoke } from "@tauri-apps/api/core";

export type WebAccountProvider = "claude" | "chatgpt" | "gemini";

export type WebAccountSlot = {
  id: string;
  provider: WebAccountProvider;
  label: string;
  enabled: boolean;
  preferred: boolean;
  open: boolean;
};

export const WEB_ACCOUNT_PROVIDER_LABELS: Record<WebAccountProvider, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
};

export async function listWebAccounts(): Promise<WebAccountSlot[]> {
  return invoke<WebAccountSlot[]>("list_web_accounts");
}

export async function updateWebAccounts(
  accounts: WebAccountSlot[]
): Promise<WebAccountSlot[]> {
  return invoke<WebAccountSlot[]>("update_web_accounts", { accounts });
}

export async function openWebAccount(accountId: string): Promise<WebAccountSlot> {
  return invoke<WebAccountSlot>("open_web_account", { accountId });
}

export async function openAllWebAccounts(): Promise<WebAccountSlot[]> {
  return invoke<WebAccountSlot[]>("open_all_web_accounts");
}

export async function closeWebAccount(accountId: string): Promise<void> {
  await invoke<void>("close_web_account", { accountId });
}

export async function closeWebAccounts(accountIds: string[]): Promise<void> {
  await invoke<void>("close_web_accounts", { accountIds });
}
