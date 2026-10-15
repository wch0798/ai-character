import { invoke } from "@tauri-apps/api/core";

export type AlertSettings = {
  desktop: boolean;
  dailyCostLimitUsd: number;
  dailyCallWarn: number;
  blockPaidOverLimit: boolean;
};

export type UsageAlerts = {
  calls: number;
  paidCalls: number;
  costUsd: number;
  dailyCostLimitUsd: number;
  dailyCallWarn: number;
  level: "ok" | "warn" | "over";
  message: string;
  paidBlocked: boolean;
};

export const USAGE_ALERT_EVENT = "ai-character:usage-alert";
export const LONG_TASK_MS = 20_000;

export function getUsageAlerts(): Promise<UsageAlerts> {
  return invoke<UsageAlerts>("get_usage_alerts");
}

export function getAlertSettings(): Promise<AlertSettings> {
  return invoke<AlertSettings>("get_alert_settings");
}

export function setAlertSettings(value: AlertSettings): Promise<AlertSettings> {
  return invoke<AlertSettings>("set_alert_settings", { value });
}

export function notifyDesktop(title: string, body: string): void {
  void invoke("notify_desktop", { title, body }).catch(() => undefined);
}

/** Only interrupt the user when the work was long and they are looking elsewhere. */
export function shouldNotifyCompletion(elapsedMs: number, focused: boolean, chatOpen: boolean): boolean {
  return elapsedMs >= LONG_TASK_MS && (!focused || !chatOpen);
}

/** Plain-text preview for a notification body: drops markdown syntax and collapses whitespace. */
export function notificationPreview(text: string, max = 120): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " [코드] ")
    .replace(/[`*_#>]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** Task ids that moved into `waiting_web` since the previous snapshot. */
export function newlyWaitingWeb(
  previous: ReadonlyArray<{ id: string; status: string }>,
  next: ReadonlyArray<{ id: string; status: string; title: string }>
): string[] {
  const before = new Map(previous.map((task) => [task.id, task.status]));
  return next.filter((task) => task.status === "waiting_web" && before.get(task.id) !== "waiting_web").map((task) => task.title);
}

/** Bar fill (0..1) and tone for one usage meter. */
export function usageMeter(value: number, limit: number): { ratio: number; tone: "ok" | "warn" | "over" } {
  if (!(limit > 0)) {
    return { ratio: 0, tone: "ok" };
  }
  const ratio = Math.min(1, Math.max(0, value / limit));
  return { ratio, tone: value >= limit ? "over" : ratio >= 0.8 ? "warn" : "ok" };
}
