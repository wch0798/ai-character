export type CharacterActivity = "idle" | "working" | "done" | "error";

export const CHARACTER_ACTIVITY_LABELS: Record<CharacterActivity, string> = {
  idle: "쉬는 중",
  working: "일하는 중",
  done: "끝났다",
  error: "실패",
};

const WORKING_STATUSES = new Set([
  "planning",
  "running",
  "waiting_web",
  "synthesizing",
]);

export type MotionCue = {
  group: string;
  priority: number;
  loopMs: number | null;
};

export function activityFromCradleStatus(
  status: string | undefined | null
): CharacterActivity | null {
  if (!status) return null;
  if (WORKING_STATUSES.has(status)) return "working";
  if (status === "completed") return "done";
  if (status === "failed" || status === "cancelled") return "error";
  return null;
}

export function motionCueForActivity(activity: CharacterActivity): MotionCue {
  if (activity === "working") {
    return { group: "TapBody", priority: 2, loopMs: 2600 };
  }
  if (activity === "done" || activity === "error") {
    return { group: "TapBody", priority: 3, loopMs: null };
  }
  return { group: "Idle", priority: 1, loopMs: null };
}

export function workSway(elapsedMs: number): { rotation: number; y: number } {
  const t = elapsedMs / 1000;
  return {
    rotation: Math.sin(t * 3.1) * 0.05,
    y: Math.sin(t * 4.2) * 7,
  };
}

type ActivityControllerOptions = {
  canvas: HTMLElement;
  playMotion: (group: string, priority: number) => void;
  onChange?: (activity: CharacterActivity) => void;
};

export function createCharacterActivityController(
  options: ActivityControllerOptions
) {
  let current: CharacterActivity = "idle";
  let loopTimer: number | null = null;
  let settleTimer: number | null = null;
  let workingStartedAt = 0;

  const clearTimers = () => {
    if (loopTimer !== null) {
      window.clearInterval(loopTimer);
      loopTimer = null;
    }
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  const render = (activity: CharacterActivity) => {
    options.canvas.dataset.activity = activity;
    options.onChange?.(activity);
  };

  const setActivity = (activity: CharacterActivity) => {
    if (activity === current && activity === "working") {
      return;
    }

    current = activity;
    clearTimers();
    render(activity);

    if (activity === "working") {
      workingStartedAt = performance.now();
    }

    const cue = motionCueForActivity(activity);
    options.playMotion(cue.group, cue.priority);
    if (cue.loopMs) {
      loopTimer = window.setInterval(() => {
        options.playMotion(cue.group, cue.priority);
      }, cue.loopMs);
    }
    if (activity === "done" || activity === "error") {
      settleTimer = window.setTimeout(() => {
        setActivity("idle");
      }, activity === "done" ? 3200 : 2800);
    }
  };

  render("idle");

  return {
    setActivity,
    getActivity: () => current,
    workingElapsedMs: () =>
      current === "working" ? performance.now() - workingStartedAt : 0,
    destroy: clearTimers,
  };
}
