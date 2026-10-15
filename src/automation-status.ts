import type { CradleSession } from "./orchestration-types";
import type { ScheduledJob } from "./scheduled-jobs-ui";
import type { UpdateRecord, UpdateRunStatus } from "./update-client";

export type JobRuntime = {
  running: string[];
  nextScanAt: number | null;
  pausedForCradle: boolean;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelative(target: number, now: number): string {
  const diff = target - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) {
    return diff >= 0 ? "곧" : "방금";
  }
  let amount: string;
  const totalMinutes = Math.max(1, Math.round(abs / MINUTE));
  if (totalMinutes < 60) {
    amount = `${totalMinutes}분`;
  } else if (abs < DAY) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    amount = minutes > 0 && hours < 6 ? `${hours}시간 ${minutes}분` : `${Math.round(abs / HOUR)}시간`;
  } else {
    amount = `${Math.round(abs / DAY)}일`;
  }
  return diff >= 0 ? `${amount} 후` : `${amount} 전`;
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** The scheduler only looks for due jobs at each scan, so a due job runs at the next scan. */
export function jobNextRunAt(job: ScheduledJob, runtime: JobRuntime, now: number): number | null {
  if (!job.enabled) {
    return null;
  }
  const due = job.lastRunAt ? job.lastRunAt + job.intervalMinutes * MINUTE : now;
  const scan = runtime.nextScanAt ?? due;
  return due <= scan ? scan : due;
}

export type UpcomingState = "running" | "waiting" | "paused" | "off";

export type UpcomingItem = {
  id: string;
  kind: "update" | "job";
  label: string;
  state: UpcomingState;
  at: number | null;
  progress: number | null;
  note: string;
};

export function buildUpcoming(
  jobs: ScheduledJob[],
  runtime: JobRuntime,
  update: UpdateRunStatus,
  updatesEnabled: boolean,
  now: number
): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  const updateSpan =
    update.nextCheckAt && update.lastFinishedAt && update.nextCheckAt > update.lastFinishedAt
      ? clampRatio((now - update.lastFinishedAt) / (update.nextCheckAt - update.lastFinishedAt))
      : null;
  items.push({
    id: "updates",
    kind: "update",
    label: "자동 업데이트 확인",
    state: update.running ? "running" : !updatesEnabled ? "off" : update.cradleActive ? "paused" : "waiting",
    at: update.running || !updatesEnabled ? null : update.nextCheckAt,
    progress: update.running ? null : updateSpan,
    note: update.running
      ? "확인 중"
      : !updatesEnabled
        ? "꺼짐"
        : update.cradleActive
          ? "코딩 작업이 끝나면 확인"
          : update.nextCheckAt
            ? formatRelative(update.nextCheckAt, now)
            : "앱 시작 후 잠시 뒤",
  });
  for (const job of jobs) {
    const running = runtime.running.includes(job.id);
    const at = running ? null : jobNextRunAt(job, runtime, now);
    const progress =
      !running && job.enabled && job.lastRunAt
        ? clampRatio((now - job.lastRunAt) / (job.intervalMinutes * MINUTE))
        : null;
    const state: UpcomingState = running
      ? "running"
      : !job.enabled
        ? "off"
        : runtime.pausedForCradle
          ? "paused"
          : "waiting";
    items.push({
      id: job.id,
      kind: "job",
      label: job.title,
      state,
      at,
      progress,
      note:
        state === "running"
          ? "실행 중"
          : state === "off"
            ? "꺼짐"
            : state === "paused"
              ? "코딩 작업이 끝나면 실행"
              : at
                ? formatRelative(at, now)
                : "",
    });
  }
  const rank: Record<UpcomingState, number> = { running: 0, paused: 1, waiting: 1, off: 2 };
  return items.sort((a, b) => rank[a.state] - rank[b.state] || (a.at ?? Infinity) - (b.at ?? Infinity));
}

export type StageState = "done" | "active" | "todo" | "failed";
export type Stage = { key: string; label: string; state: StageState };

const FINISHED_TASK = new Set(["completed", "failed", "cancelled"]);

export function cradleStages(session: Pick<CradleSession, "status" | "tasks">): Stage[] {
  const total = session.tasks.length;
  const finished = session.tasks.filter((task) => FINISHED_TASK.has(task.status)).length;
  const status = session.status;
  const allTasksDone = total > 0 && finished === total;

  const plan: StageState = status === "planning" ? "active" : total > 0 || status !== "failed" ? "done" : "failed";
  let work: StageState = "todo";
  if (status === "running" || status === "waiting_web") work = "active";
  else if (status === "synthesizing" || status === "completed") work = "done";
  else if (status === "failed" || status === "cancelled") work = total === 0 ? "todo" : allTasksDone ? "done" : "failed";

  let synth: StageState = "todo";
  if (status === "synthesizing") synth = "active";
  else if (status === "completed") synth = "done";
  else if (status === "failed" && allTasksDone) synth = "failed";

  const done: StageState = status === "completed" ? "done" : status === "cancelled" || status === "failed" ? "failed" : "todo";

  return [
    { key: "plan", label: "계획", state: plan },
    { key: "work", label: total > 0 ? `작업 ${finished}/${total}` : "작업", state: work },
    { key: "synth", label: "답 정리", state: synth },
    {
      key: "done",
      label: status === "cancelled" ? "중지됨" : status === "failed" ? "실패" : "완료",
      state: done,
    },
  ];
}

export function isCradleRunning(session: Pick<CradleSession, "status"> | null): boolean {
  return Boolean(session && ["planning", "running", "waiting_web", "synthesizing"].includes(session.status));
}

export type OverallState = "running" | "attention" | "idle";

export function overallState(
  update: Pick<UpdateRunStatus, "running" | "pendingRestart">,
  runtime: Pick<JobRuntime, "running">,
  jobs: Array<Pick<ScheduledJob, "enabled" | "lastStatus">>,
  cradleRunning: boolean
): OverallState {
  if (update.running || runtime.running.length > 0 || cradleRunning) {
    return "running";
  }
  if (
    update.pendingRestart ||
    jobs.some((job) => job.enabled && (job.lastStatus === "needs_approval" || job.lastStatus === "failed"))
  ) {
    return "attention";
  }
  return "idle";
}

export type FeedTone = "ok" | "warn" | "fail" | "info";
export type FeedItem = { at: number; label: string; detail: string; tone: FeedTone };

const UPDATE_TONES: Record<string, FeedTone> = {
  updated: "ok",
  pending_restart: "warn",
  failed: "fail",
  rolled_back: "fail",
};

const JOB_TONES: Record<string, FeedTone> = {
  ok: "ok",
  skipped: "info",
  needs_approval: "warn",
  cancelled: "info",
  failed: "fail",
};

const JOB_STATUS_TEXT: Record<string, string> = {
  ok: "완료",
  skipped: "건너뜀",
  needs_approval: "승인 필요",
  cancelled: "중지됨",
  failed: "실패",
};

export function recentFeed(history: UpdateRecord[], jobs: ScheduledJob[], limit = 8): FeedItem[] {
  const items: FeedItem[] = history.map((record) => {
    const firstLine = (record.message ?? "").split("\n")[0];
    let detail: string;
    if (record.status === "rolled_back") {
      detail = "실패 · 이전 버전 유지";
    } else if (record.status === "failed") {
      detail = firstLine || "실패";
    } else if (record.fromVersion && record.toVersion && record.fromVersion !== record.toVersion) {
      detail = `${record.fromVersion} → ${record.toVersion}`;
    } else {
      detail = record.status === "pending_restart" ? "재시작하면 적용" : firstLine;
    }
    return {
      at: record.createdAt,
      label: `업데이트 · ${record.target}`,
      detail,
      tone: UPDATE_TONES[record.status] ?? "info",
    };
  });
  for (const job of jobs) {
    if (!job.lastRunAt) continue;
    items.push({
      at: job.lastRunAt,
      label: `예약 · ${job.title}`,
      detail: JOB_STATUS_TEXT[job.lastStatus ?? ""] ?? "실패",
      tone: JOB_TONES[job.lastStatus ?? ""] ?? "fail",
    });
  }
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}
