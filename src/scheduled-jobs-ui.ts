import { invoke } from "@tauri-apps/api/core";
import { confirmOnSecondClick, errorText, sectionShell, withBusy, type MakeButton } from "./settings-controls";

export type ScheduledJob = {
  id: string;
  kind: "usage_report" | "gh_pr_summary" | "shell";
  title: string;
  intervalMinutes: number;
  enabled: boolean;
  config: Record<string, unknown> | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastOutput: string | null;
};

const KIND_LABELS: Record<ScheduledJob["kind"], string> = {
  usage_report: "보고서",
  gh_pr_summary: "PR 요약",
  shell: "명령",
};

export function describeInterval(minutes: number): string {
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}일마다`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}시간마다`;
  }
  return `${minutes}분마다`;
}

export function describeJobStatus(job: Pick<ScheduledJob, "enabled" | "lastStatus" | "lastRunAt">): string {
  if (!job.enabled) {
    return "꺼짐";
  }
  if (!job.lastRunAt) {
    return "아직 실행 안 함";
  }
  const when = new Date(job.lastRunAt).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  switch (job.lastStatus) {
    case "ok":
      return `${when} 완료`;
    case "skipped":
      return `${when} 건너뜀`;
    case "needs_approval":
      return `${when} 승인 필요`;
    case "cancelled":
      return `${when} 중지됨`;
    default:
      return `${when} 실패`;
  }
}

export type JobRun = {
  status: string;
  output: string;
  startedAt: number;
  durationMs: number;
};

const RUN_STATUS_TEXT: Record<string, string> = {
  ok: "완료",
  skipped: "건너뜀",
  needs_approval: "승인 필요",
  cancelled: "중지됨",
  failed: "실패",
};

export function formatDuration(ms: number): string {
  if (ms < 1_000) return "1초 미만";
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}초`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

export function describeRun(run: JobRun): string {
  const when = new Date(run.startedAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${when} · ${RUN_STATUS_TEXT[run.status] ?? "실패"} · ${formatDuration(run.durationMs)}`;
}

/** Resolves true when the job was running and has been asked to stop; rejects when asking failed. */
export async function cancelScheduledJob(id: string): Promise<boolean> {
  return invoke<boolean>("cancel_scheduled_job", { id });
}

export const INTERVAL_PRESETS = [60, 360, 720, 1440, 10080];

/** Preset choices plus the job's current value when it is a custom interval. */
export function intervalChoices(current: number): number[] {
  return [...new Set([...INTERVAL_PRESETS, current])].sort((a, b) => a - b);
}

export function customShellJob(title: string, command: string, intervalMinutes: number): ScheduledJob {
  const slug = `custom-${Date.now().toString(36)}`;
  return {
    id: slug,
    kind: "shell",
    title: title.trim() || command.trim().slice(0, 40),
    intervalMinutes: Math.max(5, Math.round(intervalMinutes)),
    enabled: true,
    config: { command: command.trim() },
    lastRunAt: null,
    lastStatus: null,
    lastOutput: null,
  };
}

export function createScheduledJobsSection(
  makeButton: MakeButton,
  setMessage: (text: string) => void
): { section: HTMLElement; refresh: () => Promise<void> } {
  const { section } = sectionShell("예약 작업");
  section.title =
    "명령은 등록할 때 한 번 승인받고, API 키 없이 실행됩니다. push·삭제 같은 위험한 명령은 자동 실행하지 않고 '실행'을 눌러 승인해야 합니다.";

  const list = document.createElement("div");
  list.className = "ai-job-list";
  const output = document.createElement("pre");
  output.className = "ai-settings-path ai-job-output";
  output.hidden = true;

  const addFold = document.createElement("details");
  addFold.className = "ai-settings-fold";
  const addSummary = document.createElement("summary");
  addSummary.textContent = "명령 예약 추가";
  const form = document.createElement("div");
  form.className = "ai-job-form";
  const titleInput = document.createElement("input");
  titleInput.className = "ai-settings-text";
  titleInput.placeholder = "이름";
  const commandInput = document.createElement("input");
  commandInput.className = "ai-settings-text";
  commandInput.placeholder = "명령 (예: npm run lint)";
  const intervalInput = document.createElement("input");
  intervalInput.type = "number";
  intervalInput.className = "ai-settings-number ai-settings-number-small";
  intervalInput.min = "5";
  intervalInput.value = "1440";
  intervalInput.title = "실행 간격(분)";
  const addButton = makeButton("추가", "ai-settings-action");
  form.append(titleInput, commandInput, intervalInput, addButton);
  addFold.append(addSummary, form);

  const footer = document.createElement("div");
  footer.className = "ai-settings-ghost-row";
  const reportsButton = makeButton("보고서 폴더 열기", "ai-settings-ghost");
  footer.append(reportsButton);

  section.append(list, addFold, footer, output);

  let jobs: ScheduledJob[] = [];

  const runList = document.createElement("div");
  runList.className = "ai-job-runs";
  runList.hidden = true;
  section.insertBefore(runList, output);

  const showRuns = (job: ScheduledJob, runs: JobRun[]) => {
    runList.hidden = false;
    const title = document.createElement("div");
    title.className = "ai-job-runs-title";
    title.textContent = `${job.title} · 최근 실행`;
    const close = makeButton("닫기", "ai-settings-ghost");
    close.addEventListener("click", () => {
      runList.hidden = true;
      output.hidden = true;
    });
    title.append(close);
    const rows = runs.map((run, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ai-job-run";
      row.dataset.status = run.status;
      row.textContent = describeRun(run);
      row.addEventListener("click", () => {
        runList.querySelectorAll(".ai-job-run.selected").forEach((node) => node.classList.remove("selected"));
        row.classList.add("selected");
        output.hidden = false;
        output.textContent = run.output || "출력이 없습니다.";
      });
      if (index === 0) {
        queueMicrotask(() => row.click());
      }
      return row;
    });
    if (rows.length === 0) {
      const empty = document.createElement("small");
      empty.className = "ai-settings-help";
      empty.textContent = "아직 실행 기록이 없습니다.";
      runList.replaceChildren(title, empty);
      output.hidden = true;
      return;
    }
    runList.replaceChildren(title, ...rows);
  };

  const save = async (job: ScheduledJob, controls: Array<HTMLInputElement | HTMLSelectElement>): Promise<boolean> => {
    controls.forEach((control) => (control.disabled = true));
    try {
      render(await invoke<ScheduledJob[]>("save_scheduled_job", { job }));
      return true;
    } catch (error) {
      setMessage(`예약 작업 저장 실패: ${errorText(error)}`);
      render(jobs);
      return false;
    }
  };

  const render = (next: ScheduledJob[]): void => {
    jobs = next;
    list.replaceChildren(
      ...next.map((job) => {
        const row = document.createElement("div");
        row.className = "ai-job-row";
        row.title = job.kind === "shell" ? `명령: ${String(job.config?.command ?? "")}` : KIND_LABELS[job.kind] ?? job.kind;
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = job.enabled;
        toggle.title = "켜기/끄기";
        const label = document.createElement("span");
        label.className = "ai-job-label";
        label.textContent = job.title;
        const interval = document.createElement("select");
        interval.className = "ai-job-interval";
        interval.title = "실행 간격";
        for (const minutes of intervalChoices(job.intervalMinutes)) {
          const option = document.createElement("option");
          option.value = String(minutes);
          option.textContent = describeInterval(minutes);
          option.selected = minutes === job.intervalMinutes;
          interval.append(option);
        }
        const status = document.createElement("small");
        status.className = "ai-settings-help";
        status.dataset.status = job.lastStatus ?? "";
        status.textContent = describeJobStatus(job);
        status.title = status.textContent;
        const runButton = makeButton("실행", "ai-settings-ghost");
        const showButton = makeButton("기록", "ai-settings-ghost");
        showButton.title = "최근 10회 실행 결과";
        showButton.disabled = !job.lastRunAt;
        const actions = document.createElement("div");
        actions.className = "ai-job-actions";
        actions.append(runButton, showButton);
        row.append(toggle, label, interval, status, actions);
        if (job.id.startsWith("custom-")) {
          const deleteButton = makeButton("삭제", "ai-settings-ghost");
          deleteButton.title = "한 번 더 누르면 삭제합니다.";
          confirmOnSecondClick(deleteButton, "정말 삭제?", () => {
            void withBusy([deleteButton], async () => {
              try {
                render(await invoke<ScheduledJob[]>("delete_scheduled_job", { id: job.id }));
              } catch (error) {
                setMessage(`예약 작업 삭제 실패: ${errorText(error)}`);
              }
            });
          });
          actions.append(deleteButton);
        }

        toggle.addEventListener("change", () => {
          void save({ ...job, enabled: toggle.checked }, [toggle, interval]);
        });
        interval.addEventListener("change", () => {
          void save({ ...job, intervalMinutes: Number(interval.value) }, [toggle, interval]).then((saved) => {
            if (saved) {
              setMessage(`'${job.title}' 간격을 ${describeInterval(Number(interval.value))}로 바꿨습니다.`);
            }
          });
        });
        let running = false;
        runButton.addEventListener("click", () => {
          if (running) {
            runButton.disabled = true;
            void cancelScheduledJob(job.id).then(
              (stopping) => {
                setMessage(stopping ? `'${job.title}' 중지하는 중…` : `'${job.title}'은 이미 끝났습니다.`);
              },
              (error) => {
                runButton.disabled = false;
                setMessage(`'${job.title}'을(를) 멈추지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
              }
            );
            return;
          }
          running = true;
          runButton.textContent = "중지";
          runButton.title = "실행 중인 명령을 중지합니다.";
          setMessage(`'${job.title}' 실행 중…`);
          void invoke<ScheduledJob>("run_scheduled_job_now", { id: job.id })
            .then(async (result) => {
              setMessage(`'${job.title}' ${describeJobStatus(result)}`);
              output.hidden = false;
              output.textContent = result.lastOutput ?? "";
              await refresh();
            })
            .catch((error) => setMessage(`예약 작업 실행 실패: ${errorText(error)}`))
            .finally(() => {
              running = false;
              runButton.disabled = false;
              runButton.textContent = "실행";
              runButton.title = "";
            });
        });
        showButton.addEventListener("click", () => {
          void withBusy([showButton], async () => {
            try {
              showRuns(job, await invoke<JobRun[]>("list_scheduled_job_runs", { id: job.id }));
            } catch (error) {
              setMessage(`실행 기록을 불러오지 못했습니다: ${errorText(error)}`);
            }
          });
        });
        return row;
      })
    );
  };

  const refresh = async (): Promise<void> => {
    render(await invoke<ScheduledJob[]>("list_scheduled_jobs"));
  };

  reportsButton.addEventListener("click", () => {
    void withBusy([reportsButton], async () => {
      try {
        setMessage(`보고서 폴더: ${await invoke<string>("open_reports_folder")}`);
      } catch (error) {
        setMessage(errorText(error));
      }
    });
  });

  addButton.addEventListener("click", () => {
    void withBusy([addButton], async () => {
      const command = commandInput.value.trim();
      if (!command) {
        setMessage("실행할 명령을 입력하세요.");
        return;
      }
      setMessage("명령 등록 승인 창을 확인하세요.");
      try {
        const job = customShellJob(titleInput.value, command, Number(intervalInput.value) || 1440);
        render(await invoke<ScheduledJob[]>("save_scheduled_job", { job }));
        titleInput.value = "";
        commandInput.value = "";
        setMessage("예약 작업을 추가했습니다.");
      } catch (error) {
        setMessage(`예약 작업 추가 실패: ${errorText(error)}`);
      }
    });
  });

  return { section, refresh };
}
