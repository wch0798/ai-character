export type ChatProgressKind = "chat" | "file" | "cradle";

export type ChatProgressView = {
  kind: ChatProgressKind;
  label: string;
  percent: number | null;
  elapsedMs: number;
  canStop: boolean;
};

export function chatProgressLabel(
  kind: ChatProgressKind,
  agent?: string | null
): string {
  if (kind === "chat") {
    return "답변 중…";
  }
  if (kind === "cradle") {
    return "작업 분배 중…";
  }
  const name = {
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
    antigravity: "Antigravity",
  }[agent ?? ""] ?? agent;
  return name ? `${name}가 파일을 수정하는 중…` : "파일을 수정하는 중…";
}

export function cradleProgressPercent(finished: number, total: number): number | null {
  if (!Number.isFinite(finished) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((finished / total) * 100)));
}

export function formatChatProgress(view: ChatProgressView): string {
  const seconds = Math.max(0, Math.round(view.elapsedMs / 1000));
  const time = seconds > 0 ? ` · ${seconds}초` : "";
  if (view.percent == null) {
    return `${view.label}${time}`;
  }
  return `${view.label} ${view.percent}%${time}`;
}

export function initializeChatProgressUi(): void {
  if (document.querySelector("#chat-progress")) {
    return;
  }
  const messages = document.querySelector<HTMLElement>("#messages");
  if (!messages) {
    return;
  }

  const row = document.createElement("div");
  row.id = "chat-progress";
  row.hidden = true;
  row.setAttribute("role", "status");
  row.setAttribute("aria-live", "polite");

  const text = document.createElement("div");
  text.id = "chat-progress-text";
  text.textContent = "준비 중…";

  const track = document.createElement("div");
  track.id = "chat-progress-track";
  const bar = document.createElement("div");
  bar.id = "chat-progress-bar";
  track.append(bar);

  const actions = document.createElement("div");
  actions.id = "chat-progress-actions";

  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.id = "chat-progress-stop";
  stopButton.textContent = "중지";

  const logButton = document.createElement("button");
  logButton.type = "button";
  logButton.id = "chat-progress-log";
  logButton.textContent = "로그";
  logButton.title = "기술 로그를 새 창에서 봅니다";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.id = "chat-progress-close";
  closeButton.textContent = "닫기";
  closeButton.title = "진행 표시를 숨깁니다. 작업은 계속됩니다.";

  actions.append(stopButton, logButton, closeButton);
  row.append(text, track, actions);
  messages.append(row);

  let startedAt = 0;
  let timer: number | null = null;
  let view: ChatProgressView = {
    kind: "chat",
    label: "답변 중…",
    percent: null,
    elapsedMs: 0,
    canStop: true,
  };

  const paint = () => {
    view.elapsedMs = startedAt ? performance.now() - startedAt : 0;
    text.textContent = formatChatProgress(view);
    stopButton.hidden = !view.canStop;
    if (view.percent == null) {
      track.dataset.mode = "busy";
      bar.style.width = "32%";
    } else {
      track.dataset.mode = "determinate";
      bar.style.width = `${view.percent}%`;
    }
    messages.append(row);
    messages.scrollTop = messages.scrollHeight;
  };

  const show = (next: Partial<ChatProgressView>) => {
    if (row.hidden) {
      startedAt = performance.now();
    }
    view = { ...view, ...next };
    row.hidden = false;
    stopButton.disabled = !view.canStop;
    if (timer == null) {
      timer = window.setInterval(paint, 500);
    }
    paint();
  };

  const hide = () => {
    row.hidden = true;
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  stopButton.addEventListener("click", () => {
    window.dispatchEvent(new Event("ai-character:stop-active-work"));
  });
  logButton.addEventListener("click", () => {
    window.dispatchEvent(new Event("ai-character:work-log-toggle"));
  });
  closeButton.addEventListener("click", () => {
    hide();
    window.dispatchEvent(new Event("ai-character:work-ui-hide"));
  });

  window.addEventListener("ai-character:chat-progress-start", () => {
    show({
      kind: "chat",
      label: chatProgressLabel("chat"),
      percent: null,
      canStop: true,
    });
  });

  window.addEventListener("ai-character:agent-task-start", (event: Event) => {
    const detail = (event as CustomEvent<{ agent?: string; kind?: ChatProgressKind }>).detail;
    const kind = detail?.kind === "file" ? "file" : "chat";
    show({
      kind,
      label: chatProgressLabel(kind, detail?.agent),
      percent: kind === "file" ? view.percent : null,
      canStop: true,
    });
  });

  window.addEventListener("ai-character:agent-task-end", (event: Event) => {
    const detail = (event as CustomEvent<{ status?: string; userMessage?: string }>).detail;
    if (detail?.status === "cancelled") {
      show({ label: "중지됨", canStop: false, percent: view.percent });
      window.setTimeout(hide, 1600);
      return;
    }
    if (detail?.status === "failed") {
      show({
        label: detail.userMessage ?? "다시 시도해 주세요",
        canStop: false,
        percent: null,
      });
      return;
    }
    if (detail?.status === "completed" && view.kind === "chat") {
      show({ label: "답 정리 중…", canStop: false, percent: 100 });
    }
  });

  window.addEventListener("ai-character:cradle-session", (event: Event) => {
    const session = (event as CustomEvent<{
      status?: string;
      statusMessage?: string;
      tasks?: Array<{ status?: string }>;
    }>).detail;
    const tasks = session?.tasks ?? [];
    const finished = tasks.filter((task) =>
      ["completed", "failed", "cancelled"].includes(task.status ?? "")
    ).length;
    const running = ["planning", "running", "waiting_web", "synthesizing"].includes(
      session?.status ?? ""
    );
    if (!running && session?.status !== "failed") {
      if (session?.status === "completed" || session?.status === "cancelled") {
        hide();
      }
      return;
    }
    const percent = cradleProgressPercent(finished, tasks.length);
    const label =
      session?.status === "synthesizing"
        ? "답을 정리 중…"
        : session?.status === "planning"
          ? "준비 중…"
          : tasks.length > 0
            ? `작업 ${finished}/${tasks.length}`
            : chatProgressLabel("cradle");
    show({
      kind: "cradle",
      label,
      percent,
      canStop: running,
    });
  });

  window.addEventListener("ai-character:chat-progress-hide", hide);
}
