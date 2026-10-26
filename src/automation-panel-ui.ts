import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  buildUpcoming,
  cradleStages,
  formatRelative,
  isCradleRunning,
  overallState,
  recentFeed,
  type JobRuntime,
  type OverallState,
} from "./automation-status";
import {
  getUsageAlerts,
  newlyWaitingWeb,
  notifyDesktop,
  usageMeter,
  USAGE_ALERT_EVENT,
  type UsageAlerts,
} from "./alerts-client";
import { getActiveCradleSession } from "./orchestration-engine";
import type { CradleSession } from "./orchestration-types";
import { cancelScheduledJob, type ScheduledJob } from "./scheduled-jobs-ui";
import { withBusy } from "./settings-controls";
import {
  cancelUpdates,
  describeUpdateStep,
  getUpdateSettings,
  getUpdateStatus,
  listUpdateHistory,
  restartToApplyUpdate,
  runUpdatesNow,
  summarizeOutcomes,
  type UpdateRecord,
  type UpdateRunStatus,
  type UpdateSettings,
} from "./update-client";

type Snapshot = {
  update: UpdateRunStatus;
  settings: UpdateSettings | null;
  jobs: ScheduledJob[];
  runtime: JobRuntime;
  history: UpdateRecord[];
  usage: UsageAlerts | null;
};

const OPEN_POLL_MS = 2_000;
const BADGE_POLL_MS = 20_000;

const TASK_STATUS_TEXT: Record<string, string> = {
  queued: "대기",
  running: "진행 중",
  waiting_web: "웹 응답 대기",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
};

const BADGE_TITLES: Record<OverallState, string> = {
  running: "자동 작업이 진행 중입니다",
  attention: "확인이 필요한 항목이 있습니다",
  idle: "자동화 현황",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className = "auto-btn"): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  return node;
}

async function loadSnapshot(): Promise<Snapshot> {
  const [update, settings, jobs, runtime, history, usage] = await Promise.all([
    getUpdateStatus(),
    getUpdateSettings().catch(() => null),
    invoke<ScheduledJob[]>("list_scheduled_jobs").catch(() => []),
    invoke<JobRuntime>("running_scheduled_jobs").catch(() => ({ running: [], nextScanAt: null, pausedForCradle: false })),
    listUpdateHistory(10).catch(() => []),
    getUsageAlerts().catch(() => null),
  ]);
  return { update, settings, jobs, runtime, history, usage };
}

function anyUpdatesEnabled(settings: UpdateSettings | null): boolean {
  return settings ? settings.app || settings.clis || settings.plugins || settings.models : true;
}

export function initializeAutomationPanel(options: { setChatOpen(open: boolean): void }): void {
  if (document.querySelector("#automation-panel")) {
    return;
  }
  const chatPanel = document.querySelector<HTMLElement>("#chat-panel");
  const usageButton = document.querySelector<HTMLButtonElement>("#usage-dashboard-button");
  const usagePanel = document.querySelector<HTMLElement>("#usage-dashboard-panel");
  if (!chatPanel || !usageButton) {
    return;
  }

  const launcher = button("", "");
  launcher.id = "automation-button";
  launcher.title = BADGE_TITLES.idle;
  launcher.dataset.icon = "⏱";
  launcher.setAttribute("aria-label", "자동화 현황");
  const badge = el("span", "automation-badge");
  badge.dataset.state = "idle";
  launcher.append(badge, el("span", "toolbar-label", "자동화"));
  usageButton.before(launcher);

  const panel = el("section");
  panel.id = "automation-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "자동화 현황");
  const header = el("div", "usage-dashboard-header");
  const title = el("div", "usage-dashboard-title", "자동화 현황");
  const settingsButton = button("설정");
  settingsButton.title = "자동 업데이트·예약 작업 설정 열기";
  const closeButton = button("×");
  closeButton.setAttribute("aria-label", "자동화 현황 닫기");
  header.append(title, settingsButton, closeButton);
  const body = el("div", "automation-body");
  const message = el("div", "automation-message");
  message.hidden = true;
  panel.append(header, message, body);
  (usagePanel ?? chatPanel.firstElementChild)?.after(panel);

  let snapshot: Snapshot | null = null;
  let cradle: CradleSession | null = getActiveCradleSession();
  let openTimer = 0;
  const stoppingJobs = new Set<string>();

  const setMessage = (text: string) => {
    message.textContent = text;
    message.hidden = !text;
  };

  const paintBadge = () => {
    if (!snapshot) return;
    let state = overallState(snapshot.update, snapshot.runtime, snapshot.jobs, isCradleRunning(cradle));
    const usageWarning = snapshot.usage && snapshot.usage.level !== "ok" ? snapshot.usage.message : "";
    if (state === "idle" && usageWarning) {
      state = "attention";
    }
    badge.dataset.state = state;
    launcher.title = usageWarning && state === "attention" ? usageWarning : BADGE_TITLES[state];
  };

  const renderUsage = (usage: UsageAlerts): HTMLElement => {
    const section = el("section", "auto-section");
    const heading = el("h4", "auto-section-title", "오늘 사용량");
    if (usage.paidBlocked) {
      heading.append(el("span", "auto-usage-blocked", "유료 호출 차단 중"));
    }
    section.append(heading);
    const meters: Array<[string, number, number, string]> = [
      ["유료 비용", usage.costUsd, usage.dailyCostLimitUsd, usage.dailyCostLimitUsd > 0 ? `$${usage.costUsd.toFixed(2)} / $${usage.dailyCostLimitUsd.toFixed(2)}` : "유료 사용 안 함 (한도 $0)"],
      ["AI 호출", usage.calls, usage.dailyCallWarn, `${usage.calls}회 / ${usage.dailyCallWarn}회`],
    ];
    const list = el("div", "auto-list");
    for (const [label, value, limit, note] of meters) {
      const meter = usageMeter(value, limit);
      const row = el("div", "auto-row auto-usage-row");
      row.dataset.tone = meter.tone;
      const track = el("div", "auto-row-track");
      const bar = el("div", "auto-row-bar");
      bar.style.width = `${Math.round(meter.ratio * 100)}%`;
      track.append(bar);
      row.append(el("span", "auto-dot"), el("span", "auto-row-label", label), el("span", "auto-row-note", limit > 0 ? note : "제한 없음"), track);
      list.append(row);
    }
    section.append(list);
    if (usage.paidCalls > 0) {
      section.append(el("div", "auto-muted", `유료 호출 ${usage.paidCalls}회 포함 · 한도는 설정 → 자동화에서 바꿀 수 있습니다.`));
    }
    if (usage.message) {
      section.append(el("div", `auto-usage-message auto-usage-${usage.level}`, usage.message));
    }
    return section;
  };

  const renderCradle = (session: CradleSession): HTMLElement => {
    const card = el("div", "auto-card");
    const head = el("div", "auto-card-head");
    head.append(el("strong", "", "코딩 작업 (CRADLE)"));
    if (isCradleRunning(session)) {
      const stop = button("중지", "auto-btn auto-btn-danger");
      stop.addEventListener("click", () => {
        window.dispatchEvent(new Event("ai-character:stop-active-work"));
      });
      head.append(stop);
    }
    const stepper = el("ol", "auto-stepper");
    for (const stage of cradleStages(session)) {
      const item = el("li", "auto-step", stage.label);
      item.dataset.state = stage.state;
      stepper.append(item);
    }
    card.append(head, stepper);
    if (session.planSummary) {
      card.append(el("div", "auto-muted", session.planSummary));
    }
    if (session.tasks.length > 0) {
      const tasks = el("div", "auto-tasks");
      for (const task of session.tasks) {
        const chip = el("span", "auto-task", task.title);
        chip.dataset.status = task.status;
        chip.title = `${task.title} · ${TASK_STATUS_TEXT[task.status] ?? task.status}`;
        tasks.append(chip);
      }
      card.append(tasks);
    }
    return card;
  };

  const renderUpdateRunning = (update: UpdateRunStatus): HTMLElement => {
    const card = el("div", "auto-card");
    const head = el("div", "auto-card-head");
    const label = el("strong", "", "업데이트 중");
    label.prepend(el("span", "auto-spinner"));
    head.append(label);
    if (!update.cancelRequested) {
      const stop = button("중지", "auto-btn auto-btn-danger");
      stop.title = "지금 항목까지만 마치고 멈춥니다. 설치 도중에 끊으면 프로그램이 망가질 수 있어서입니다.";
      stop.addEventListener("click", () => {
        void withBusy([stop], async () => {
          const accepted = await cancelUpdates().catch(() => false);
          setMessage(accepted ? "중지 요청을 보냈습니다. 지금 항목이 끝나면 멈춥니다." : "진행 중인 업데이트가 없습니다.");
          await refresh();
        });
      });
      head.append(stop);
    }
    const detail = update.cancelRequested
      ? `중지 요청됨 · ${describeUpdateStep(update.current)}까지만 마칩니다`
      : `${describeUpdateStep(update.current)} · ${update.completed}개 끝`;
    card.append(head, el("div", "auto-muted", detail));
    const track = el("div", "auto-track");
    track.dataset.mode = "busy";
    track.append(el("div", "auto-track-bar"));
    card.append(track);
    return card;
  };

  const renderNow = (data: Snapshot): HTMLElement => {
    const section = el("section", "auto-section");
    section.append(el("h4", "auto-section-title", "지금"));
    const nodes: HTMLElement[] = [];
    if (cradle && (isCradleRunning(cradle) || cradle.status === "failed")) {
      nodes.push(renderCradle(cradle));
    }
    if (data.update.running) {
      nodes.push(renderUpdateRunning(data.update));
    }
    for (const id of data.runtime.running) {
      const job = data.jobs.find((candidate) => candidate.id === id);
      const card = el("div", "auto-card");
      const head = el("div", "auto-card-head");
      const label = el("strong", "", `예약 작업 · ${job?.title ?? id}`);
      label.prepend(el("span", "auto-spinner"));
      head.append(label);
      const stopping = stoppingJobs.has(id);
      const stop = button(stopping ? "중지 중…" : "중지", "auto-btn auto-btn-danger");
      stop.disabled = stopping;
      stop.title = "실행 중인 명령을 바로 끝냅니다.";
      stop.addEventListener("click", () => {
        stoppingJobs.add(id);
        stop.disabled = true;
        stop.textContent = "중지 중…";
        void cancelScheduledJob(id)
          .then((accepted) => {
            setMessage(accepted ? `'${job?.title ?? id}' 중지를 요청했습니다.` : "이미 끝난 작업입니다.");
          })
          .catch((error) => {
            setMessage(`'${job?.title ?? id}'을(를) 멈추지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => {
            stoppingJobs.delete(id);
            void refresh();
          });
      });
      head.append(stop);
      card.append(head);
      nodes.push(card);
    }
    if (data.update.pendingRestart) {
      const card = el("div", "auto-card auto-card-attention");
      const head = el("div", "auto-card-head");
      head.append(el("strong", "", "새 버전 준비됨"));
      const restart = button("지금 재시작", "auto-btn auto-btn-primary");
      restart.addEventListener("click", () => {
        void withBusy([restart], async () => {
          try {
            await restartToApplyUpdate();
          } catch (error) {
            setMessage(`재시작 실패: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      });
      head.append(restart);
      card.append(head, el("div", "auto-muted", "재시작하면 새 버전이 적용됩니다."));
      nodes.push(card);
    }
    const approvals = data.jobs.filter((job) => job.enabled && job.lastStatus === "needs_approval");
    if (approvals.length > 0) {
      const card = el("div", "auto-card auto-card-attention");
      card.append(
        el("strong", "", `승인이 필요한 예약 작업 ${approvals.length}개`),
        el("div", "auto-muted", `${approvals.map((job) => job.title).join(", ")} — 설정 → 자동화에서 '실행'을 눌러 승인하세요.`)
      );
      nodes.push(card);
    }
    if (nodes.length === 0) {
      nodes.push(el("div", "auto-empty", "지금 진행 중인 자동 작업이 없습니다."));
    }
    section.append(...nodes);
    return section;
  };

  const renderUpcoming = (data: Snapshot, now: number): HTMLElement => {
    const section = el("section", "auto-section");
    section.append(el("h4", "auto-section-title", "예정"));
    const list = el("div", "auto-list");
    for (const item of buildUpcoming(data.jobs, data.runtime, data.update, anyUpdatesEnabled(data.settings), now)) {
      const row = el("div", "auto-row");
      row.dataset.state = item.state;
      const dot = el("span", "auto-dot");
      const label = el("span", "auto-row-label", item.label);
      const note = el("span", "auto-row-note", item.note);
      if (item.at) {
        note.title = new Date(item.at).toLocaleString();
      }
      const track = el("div", "auto-row-track");
      const bar = el("div", "auto-row-bar");
      if (item.state === "running") {
        track.dataset.mode = "busy";
      } else {
        bar.style.width = `${Math.round((item.progress ?? 0) * 100)}%`;
      }
      track.append(bar);
      row.append(dot, label, note, track);
      list.append(row);
    }
    section.append(list);
    return section;
  };

  const renderFeed = (data: Snapshot, now: number): HTMLElement => {
    const section = el("section", "auto-section");
    section.append(el("h4", "auto-section-title", "최근 결과"));
    const feed = recentFeed(data.history, data.jobs);
    if (feed.length === 0) {
      section.append(el("div", "auto-empty", "아직 기록이 없습니다."));
      return section;
    }
    const list = el("div", "auto-feed");
    for (const item of feed) {
      const row = el("div", "auto-feed-row");
      row.dataset.tone = item.tone;
      row.append(
        el("span", "auto-dot"),
        el("span", "auto-row-label", item.label),
        el("span", "auto-feed-detail", item.detail),
        el("span", "auto-row-note", formatRelative(item.at, now))
      );
      row.title = `${new Date(item.at).toLocaleString()} · ${item.label} · ${item.detail}`;
      list.append(row);
    }
    section.append(list);
    return section;
  };

  const renderActions = (data: Snapshot): HTMLElement => {
    const actions = el("div", "auto-actions");
    const runNow = button(data.update.running ? "업데이트 중…" : "지금 업데이트 확인", "auto-btn auto-btn-primary");
    runNow.disabled = data.update.running;
    runNow.addEventListener("click", () => {
      void withBusy([runNow], async () => {
        setMessage("업데이트를 확인합니다…");
        const run = runUpdatesNow();
        window.setTimeout(() => void refresh(), 300);
        try {
          setMessage(summarizeOutcomes(await run));
        } catch (error) {
          setMessage(error instanceof Error ? error.message : String(error));
        }
        await refresh();
      });
    });
    actions.append(runNow);
    return actions;
  };

  const paint = () => {
    if (!snapshot || panel.hidden) return;
    const now = Date.now();
    const scroll = body.scrollTop;
    const sections = [renderNow(snapshot)];
    if (snapshot.usage) sections.push(renderUsage(snapshot.usage));
    sections.push(renderUpcoming(snapshot, now), renderFeed(snapshot, now), renderActions(snapshot));
    body.replaceChildren(...sections);
    body.scrollTop = scroll;
  };

  const refresh = async () => {
    try {
      snapshot = await loadSnapshot();
      for (const id of [...stoppingJobs]) {
        if (!snapshot.runtime.running.includes(id)) stoppingJobs.delete(id);
      }
      cradle = getActiveCradleSession() ?? cradle;
      paintBadge();
      paint();
    } catch (error) {
      if (!panel.hidden) {
        setMessage(`자동화 상태를 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const close = () => {
    panel.hidden = true;
    window.clearInterval(openTimer);
    openTimer = 0;
  };

  const open = () => {
    options.setChatOpen(true);
    const settings = document.querySelector<HTMLElement>("#ai-settings-panel");
    if (settings) settings.hidden = true;
    if (usagePanel) usagePanel.hidden = true;
    panel.hidden = false;
    setMessage("");
    if (!snapshot) {
      body.replaceChildren(el("div", "auto-empty", "불러오는 중…"));
    }
    void refresh();
    window.clearInterval(openTimer);
    openTimer = window.setInterval(() => void refresh(), OPEN_POLL_MS);
  };

  launcher.addEventListener("click", () => {
    if (panel.hidden) open();
    else close();
  });
  closeButton.addEventListener("click", close);
  settingsButton.addEventListener("click", () => {
    close();
    window.dispatchEvent(new CustomEvent("ai-character:open-settings", { detail: { tab: "updates" } }));
  });
  usageButton.addEventListener("click", close);
  window.addEventListener("ai-character:usage-opened", close);
  window.addEventListener("ai-character:open-settings", close);
  window.addEventListener("ai-character:open-automation", open);
  window.addEventListener("ai-character:cradle-session", (event: Event) => {
    const next = (event as CustomEvent<CradleSession>).detail;
    const waiting = next ? newlyWaitingWeb(cradle?.id === next.id ? cradle.tasks : [], next.tasks) : [];
    if (waiting.length > 0 && !document.hasFocus()) {
      notifyDesktop("웹 응답이 필요합니다", `${waiting.join(", ")} — 웹 계정 창에서 답변을 확인해 주세요.`);
    }
    cradle = next;
    paintBadge();
    paint();
  });
  void listen<UsageAlerts>(USAGE_ALERT_EVENT, (event) => {
    if (snapshot) snapshot.usage = event.payload;
    paintBadge();
    paint();
  }).catch(() => undefined);
  new MutationObserver(() => {
    if (!chatPanel.classList.contains("open")) close();
  }).observe(chatPanel, { attributes: true, attributeFilter: ["class"] });

  void refresh();
  window.setInterval(() => {
    if (panel.hidden) void refresh();
  }, BADGE_POLL_MS);
}
