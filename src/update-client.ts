import { invoke } from "@tauri-apps/api/core";

export type UpdateSettings = {
  app: boolean;
  clis: boolean;
  plugins: boolean;
  models: boolean;
  intervalHours: number;
};

export type UpdateOutcome = {
  category: string;
  target: string;
  fromVersion: string | null;
  toVersion: string | null;
  status: "updated" | "current" | "failed" | "rolled_back" | "skipped" | "pending_restart";
  message: string | null;
};

export type UpdateRecord = {
  id: number;
  category: string;
  target: string;
  fromVersion: string | null;
  toVersion: string | null;
  status: string;
  message: string | null;
  createdAt: number;
};

export type UpdateNotice = { title: string; lines: string[] };

export const UPDATE_NOTICE_EVENT = "ai-character:update-notice";

export async function setCradleActivity(active: boolean): Promise<void> {
  try {
    await invoke("set_cradle_activity", { active });
  } catch {
    // The scheduler only uses this to postpone updates; losing a signal is harmless.
  }
}

export function getUpdateSettings(): Promise<UpdateSettings> {
  return invoke<UpdateSettings>("get_update_settings");
}

export function setUpdateSettings(value: UpdateSettings): Promise<UpdateSettings> {
  return invoke<UpdateSettings>("set_update_settings", { value });
}

export function runUpdatesNow(categories?: string[]): Promise<UpdateOutcome[]> {
  return invoke<UpdateOutcome[]>("run_updates_now", { categories: categories ?? null });
}

export function hasPendingAppUpdate(): Promise<boolean> {
  return invoke<boolean>("has_pending_app_update");
}

/** Applies a downloaded app update (if any) and restarts the app. */
export function restartToApplyUpdate(): Promise<void> {
  return invoke("restart_to_apply_update");
}

export type UpdateRunStatus = {
  running: boolean;
  current: string | null;
  completed: number;
  startedAt: number | null;
  cancelRequested: boolean;
  lastFinishedAt: number | null;
  nextCheckAt: number | null;
  pendingRestart: boolean;
  cradleActive: boolean;
};

export function getUpdateStatus(): Promise<UpdateRunStatus> {
  return invoke<UpdateRunStatus>("get_update_status");
}

/** Asks the running cycle to stop after the current item; false when nothing is running. */
export function cancelUpdates(): Promise<boolean> {
  return invoke<boolean>("cancel_updates");
}

const STEP_CATEGORY_LABELS: Record<string, string> = {
  cli: "CLI",
  plugin: "Claude 플러그인",
  models: "무료 모델 목록",
  app: "앱",
};

/** "cli:claude" → "CLI · claude" */
export function describeUpdateStep(step: string | null): string {
  if (!step) {
    return "준비 중";
  }
  const [category, target] = step.split(":", 2);
  const label = STEP_CATEGORY_LABELS[category] ?? category;
  return target && target !== category && target !== "claude-plugins" && target !== "models" && target !== "app"
    ? `${label} · ${target}`
    : label;
}

export function needsRestart(outcomes: Array<Pick<UpdateOutcome, "status">>): boolean {
  return outcomes.some((outcome) => outcome.status === "pending_restart");
}

export function listUpdateHistory(limit = 20): Promise<UpdateRecord[]> {
  return invoke<UpdateRecord[]>("list_update_history", { limit });
}

const STATUS_LABELS: Record<string, string> = {
  updated: "업데이트 완료",
  current: "최신",
  failed: "실패",
  rolled_back: "실패하여 이전 버전 유지",
  skipped: "건너뜀",
  pending_restart: "설치됨, 재시작하면 적용",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function describeOutcome(outcome: Pick<UpdateOutcome, "target" | "fromVersion" | "toVersion" | "status" | "message">): string {
  const versions =
    outcome.fromVersion && outcome.toVersion && outcome.fromVersion !== outcome.toVersion
      ? ` ${outcome.fromVersion} → ${outcome.toVersion}`
      : outcome.toVersion
        ? ` ${outcome.toVersion}`
        : "";
  const detail = outcome.message && outcome.status !== "updated" ? ` (${outcome.message.split("\n")[0]})` : "";
  return `${outcome.target}${versions}: ${statusLabel(outcome.status)}${detail}`;
}

export function summarizeOutcomes(outcomes: UpdateOutcome[]): string {
  if (outcomes.length === 0) {
    return "확인할 대상이 없습니다.";
  }
  const count = (status: string) => outcomes.filter((outcome) => outcome.status === status).length;
  const parts = [`업데이트 ${count("updated") + count("pending_restart")}건`, `최신 ${count("current")}건`];
  const failed = count("failed") + count("rolled_back");
  if (failed > 0) {
    parts.push(`실패 ${failed}건(이전 버전 유지)`);
  }
  if (count("skipped") > 0) {
    parts.push(`건너뜀 ${count("skipped")}건`);
  }
  return parts.join(" · ");
}
