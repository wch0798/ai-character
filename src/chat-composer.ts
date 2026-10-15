export type KeyIntent = "submit" | "newline" | "recall-previous" | "recall-next" | "stop" | "none";

export type KeyState = {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
  value: string;
  caretAtStart: boolean;
  caretAtEnd: boolean;
  busy: boolean;
};

/** Enter sends, Shift+Enter breaks the line; Korean IME composition (keyCode 229) never sends. */
export function keyIntent(state: KeyState): KeyIntent {
  if (state.isComposing || state.keyCode === 229) {
    return "none";
  }
  if (state.key === "Escape" && state.busy) {
    return "stop";
  }
  if (state.key === "Enter") {
    return state.shiftKey ? "newline" : "submit";
  }
  if (state.key === "ArrowUp" && state.caretAtStart && !state.value.includes("\n")) {
    return "recall-previous";
  }
  if (state.key === "ArrowDown" && state.caretAtEnd && !state.value.includes("\n")) {
    return "recall-next";
  }
  return "none";
}

export const SENT_HISTORY_LIMIT = 30;

export function rememberSent(history: string[], text: string): string[] {
  const clean = text.trim();
  if (!clean) {
    return history;
  }
  return [...history.filter((item) => item !== clean), clean].slice(-SENT_HISTORY_LIMIT);
}

/** Walks the sent history; index === history.length means "the draft being typed". */
export function stepHistory(historyLength: number, index: number, direction: -1 | 1): number {
  return Math.max(0, Math.min(historyLength, index + direction));
}

export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 80): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

const DRAFT_KEY = "ai-character-chat-draft";
const SENT_KEY = "ai-character-chat-sent";
const MAX_INPUT_HEIGHT = 168;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export type Composer = {
  setBusy(busy: boolean): void;
  isBusy(): boolean;
  takeText(): string;
  restoreText(text: string): void;
  fill(text: string): void;
  remember(text: string): void;
};

export function setupComposer(
  form: HTMLFormElement,
  input: HTMLTextAreaElement,
  onStop: () => void
): Composer {
  const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
  let busy = false;
  let sent = readJson<string[]>(SENT_KEY, []).filter((item) => typeof item === "string");
  let historyIndex = sent.length;
  let draftBeforeRecall = "";

  const resize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(MAX_INPUT_HEIGHT, input.scrollHeight)}px`;
    input.style.overflowY = input.scrollHeight > MAX_INPUT_HEIGHT ? "auto" : "hidden";
  };

  const saveDraft = () => {
    try {
      if (input.value) {
        localStorage.setItem(DRAFT_KEY, input.value);
      } else {
        localStorage.removeItem(DRAFT_KEY);
      }
    } catch {
      // Draft persistence is best-effort.
    }
  };

  const setValue = (text: string) => {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    resize();
    saveDraft();
  };

  const paintSubmit = () => {
    if (!submit) return;
    submit.textContent = busy ? "중지" : "전송";
    submit.title = busy ? "진행 중인 답변을 멈춥니다 (Esc)" : "보내기 (Enter) · 줄바꿈 (Shift+Enter)";
    submit.classList.toggle("is-stop", busy);
  };

  input.value = localStorage.getItem(DRAFT_KEY) ?? "";
  resize();
  paintSubmit();

  input.addEventListener("input", () => {
    historyIndex = sent.length;
    resize();
    saveDraft();
  });

  input.addEventListener("keydown", (event) => {
    const intent = keyIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.isComposing,
      keyCode: event.keyCode,
      value: input.value,
      caretAtStart: input.selectionStart === 0 && input.selectionEnd === 0,
      caretAtEnd: input.selectionStart === input.value.length,
      busy,
    });
    if (intent === "submit") {
      event.preventDefault();
      if (busy) {
        input.classList.add("is-waiting");
        window.setTimeout(() => input.classList.remove("is-waiting"), 900);
        return;
      }
      form.requestSubmit();
    } else if (intent === "stop") {
      event.preventDefault();
      onStop();
    } else if (intent === "recall-previous" && sent.length > 0) {
      event.preventDefault();
      if (historyIndex === sent.length) {
        draftBeforeRecall = input.value;
      }
      historyIndex = stepHistory(sent.length, historyIndex, -1);
      setValue(sent[historyIndex] ?? "");
    } else if (intent === "recall-next" && historyIndex < sent.length) {
      event.preventDefault();
      historyIndex = stepHistory(sent.length, historyIndex, 1);
      setValue(historyIndex === sent.length ? draftBeforeRecall : sent[historyIndex] ?? "");
    }
  });

  form.addEventListener(
    "submit",
    (event) => {
      if (busy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onStop();
      }
    },
    { capture: true }
  );

  return {
    setBusy(next) {
      busy = next;
      form.classList.toggle("is-busy", next);
      paintSubmit();
    },
    isBusy: () => busy,
    takeText() {
      const text = input.value;
      setValue("");
      return text;
    },
    restoreText(text) {
      if (!input.value.trim()) {
        setValue(text);
      }
    },
    fill(text) {
      setValue(text);
      input.focus();
    },
    remember(text) {
      sent = rememberSent(sent, text);
      historyIndex = sent.length;
      try {
        localStorage.setItem(SENT_KEY, JSON.stringify(sent));
      } catch {
        // History persistence is best-effort.
      }
    },
  };
}

export type ScrollFollower = {
  /** Scrolls to the newest message when the reader is already at the bottom (or `force`). */
  follow(force?: boolean): void;
};

export function setupScrollFollow(messages: HTMLElement, host: HTMLElement): ScrollFollower {
  const jump = document.createElement("button");
  jump.type = "button";
  jump.id = "chat-jump-latest";
  jump.hidden = true;
  host.append(jump);
  let unread = 0;
  let pinned = true;

  const paint = () => {
    jump.hidden = pinned;
    jump.textContent = unread > 0 ? `↓ 새 메시지 ${unread}` : "↓ 맨 아래로";
  };

  const toBottom = (smooth: boolean) => {
    messages.scrollTo({ top: messages.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    unread = 0;
    pinned = true;
    paint();
  };

  messages.addEventListener("scroll", () => {
    pinned = isNearBottom(messages.scrollTop, messages.clientHeight, messages.scrollHeight);
    if (pinned) {
      unread = 0;
    }
    paint();
  }, { passive: true });

  jump.addEventListener("click", () => toBottom(true));

  return {
    follow(force = false) {
      if (force || pinned) {
        toBottom(false);
        return;
      }
      unread += 1;
      paint();
    },
  };
}

export const WELCOME_SUGGESTIONS = [
  "이 프로젝트 구조를 설명해줘",
  "최근 변경 내용을 요약해줘",
  "테스트를 돌려서 실패 원인을 찾아줘",
  "이 오류를 고쳐줘: ",
];

export function renderWelcome(messages: HTMLElement, onPick: (text: string) => void): void {
  const box = document.createElement("div");
  box.className = "chat-welcome";
  const title = document.createElement("div");
  title.className = "chat-welcome-title";
  title.textContent = "무엇을 도와드릴까요?";
  const hint = document.createElement("div");
  hint.className = "chat-welcome-hint";
  hint.textContent = "Enter 보내기 · Shift+Enter 줄바꿈 · ↑ 이전 질문 · 파일은 끌어다 놓기";
  const chips = document.createElement("div");
  chips.className = "chat-welcome-chips";
  for (const suggestion of WELCOME_SUGGESTIONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.textContent = suggestion.trim();
    chip.addEventListener("click", () => onPick(suggestion));
    chips.append(chip);
  }
  box.append(title, hint, chips);
  messages.append(box);
}
