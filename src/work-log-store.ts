export type WorkLogSnapshot = {
  title: string;
  status: string;
  output: string;
  technical: string;
  updatedAt: number;
};

export const WORK_LOG_STORAGE_KEY = "ai-character-work-log";
const OUTPUT_LIMIT = 20_000;

const emptyLog = (): WorkLogSnapshot => ({
  title: "기술 로그",
  status: "대기",
  output: "",
  technical: "",
  updatedAt: 0,
});

let snapshot = emptyLog();

export function getWorkLogSnapshot(): WorkLogSnapshot {
  return { ...snapshot };
}

export function formatWorkLog(snapshot: WorkLogSnapshot): string {
  const parts = [
    snapshot.status && `상태: ${snapshot.status}`,
    snapshot.output && `진행 로그:\n${snapshot.output.trim()}`,
    snapshot.technical && `기술 상세:\n${snapshot.technical.trim()}`,
  ].filter(Boolean);
  return parts.join("\n\n") || "아직 기록된 로그가 없습니다.";
}

function persist(): void {
  snapshot.updatedAt = Date.now();
  const next = getWorkLogSnapshot();
  try {
    localStorage.setItem(WORK_LOG_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // quota / private mode
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("ai-character:work-log-changed", { detail: next })
    );
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_work_log", { snapshot: next }))
      .catch(() => undefined);
  }
}

export function loadWorkLogSnapshot(): WorkLogSnapshot {
  try {
    const raw = localStorage.getItem(WORK_LOG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WorkLogSnapshot>;
      snapshot = {
        ...emptyLog(),
        ...parsed,
        title: parsed.title?.trim() || "기술 로그",
        status: parsed.status ?? "",
        output: parsed.output ?? "",
        technical: parsed.technical ?? "",
      };
    }
  } catch {
    snapshot = emptyLog();
  }
  return getWorkLogSnapshot();
}

export function resetWorkLog(status = "진행 중"): void {
  snapshot = { ...emptyLog(), status, updatedAt: Date.now() };
  persist();
}

export function setWorkLogStatus(status: string): void {
  snapshot = { ...snapshot, status };
  persist();
}

export function appendWorkLogOutput(text: string): void {
  const next = `${snapshot.output}${text}`;
  snapshot = {
    ...snapshot,
    output: next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next,
  };
  persist();
}

export function setWorkLogTechnical(technical: string): void {
  snapshot = { ...snapshot, technical };
  persist();
}
