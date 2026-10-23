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
  /** Every "add to the current task" note, removed from the waiting list (oldest first). */
  takeAdditions(): string[];
  /** The oldest separate next question, removed from the waiting list. */
  takeQueued(): string | undefined;
  /** After a stop: puts everything waiting back into the input instead of sending it. */
  returnQueuedToInput(): void;
};

/**
 * Typed while an answer runs. "add" belongs to the running task (Enter): it is folded into it.
 * "next" is a separate question (Ctrl+Enter), sent on its own afterwards.
 */
export type QueuedKind = "add" | "next";
export type QueuedItem = { kind: QueuedKind; text: string };
export const QUEUE_LIMIT = 5;

export function enqueue(queue: QueuedItem[], text: string, kind: QueuedKind = "next"): QueuedItem[] {
  const clean = text.trim();
  if (!clean || queue.length >= QUEUE_LIMIT) {
    return queue;
  }
  return [...queue, { kind, text: clean }];
}

/** The follow-up that carries notes added while a task ran, once that task has finished. */
export function additionsPrompt(additions: string[]): string {
  return [
    "[추가 지시] 방금 진행한 요청에 이어지는 내용입니다. 새 질문이 아니라, 앞의 답변이나 작업 결과에 아래 내용을 더 반영해 주세요.",
    ...additions.map((text) => `- ${text}`),
  ].join("\n");
}

/** A task restarted before it answered anything: the original question plus the added notes. */
export function mergedPrompt(original: string, additions: string[]): string {
  return [
    original.trim(),
    "",
    "[추가 지시] 위 질문을 보낸 직후에 덧붙인 내용입니다. 함께 반영해서 한 번에 답해 주세요.",
    ...additions.map((text) => `- ${text}`),
  ].join("\n");
}

export type ComposerOptions = {
  onStop: () => void;
  /**
   * A note for the running task. Return true when it was taken in right away (the task restarted
   * with it); otherwise it waits and goes out as a follow-up when the task finishes.
   */
  onAdd?: (text: string) => boolean;
  /** A short notice for the user, e.g. when the waiting list is full. */
  onNotice?: (text: string) => void;
};

export function setupComposer(
  form: HTMLFormElement,
  input: HTMLTextAreaElement,
  options: ComposerOptions
): Composer {
  const { onStop, onAdd, onNotice } = options;
  const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
  let busy = false;
  let sent = readJson<string[]>(SENT_KEY, []).filter((item) => typeof item === "string");
  let historyIndex = sent.length;
  let draftBeforeRecall = "";
  let queue: QueuedItem[] = [];
  const queueBox = document.createElement("div");
  queueBox.id = "chat-queue";
  queueBox.hidden = true;
  form.before(queueBox);
  // "↓ 맨 아래로" sits just above the form; lift it over the waiting list and attachments.
  const placeJumpButton = () => {
    const attachments = document.getElementById("attachment-list");
    const above = (queueBox.hidden ? 0 : queueBox.offsetHeight) + (attachments?.offsetHeight ?? 0);
    form.style.setProperty("--chat-above-form", `${above}px`);
  };
  const attachmentList = document.getElementById("attachment-list");
  if (attachmentList && "ResizeObserver" in window) {
    new ResizeObserver(placeJumpButton).observe(attachmentList);
  }

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
    paintSubmit();
  };

  const paintSubmit = () => {
    if (!submit) return;
    // While busy, typed text is added to the running task; an empty input means "stop".
    const adds = busy && input.value.trim() !== "";
    const stops = busy && !adds;
    submit.textContent = adds ? "추가" : stops ? "중지" : "전송";
    submit.title = adds
      ? "지금 작업에 이 내용을 더 반영합니다 (Enter) · 따로 다음 질문으로 보내기 (Ctrl+Enter)"
      : stops
        ? "진행 중인 답변을 멈춥니다 (Esc)"
        : "보내기 (Enter) · 줄바꿈 (Shift+Enter)";
    submit.classList.toggle("is-stop", stops);
  };

  const paintQueue = () => {
    queueBox.replaceChildren();
    queueBox.hidden = queue.length === 0;
    window.requestAnimationFrame(placeJumpButton);
    if (!queue.length) return;
    const title = document.createElement("div");
    title.className = "chat-queue-title";
    title.textContent = "답변 중에 넣은 내용 · 지금 작업이 끝나면 차례로 보냅니다";
    queueBox.append(title);
    queue.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = `chat-queue-item is-${item.kind}`;
      const tag = document.createElement("em");
      tag.textContent = item.kind === "add" ? "지금 작업에 반영" : "다음 질문";
      const label = document.createElement("span");
      label.textContent = item.text;
      label.title = item.text;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "이 내용은 보내지 않습니다";
      remove.addEventListener("click", () => {
        queue = queue.filter((_, i) => i !== index);
        paintQueue();
      });
      row.append(tag, label, remove);
      queueBox.append(row);
    });
  };

  const addToQueue = (kind: QueuedKind) => {
    const text = input.value.trim();
    if (!text) return;
    // A note for the running task may be taken in right away (the task restarts with it).
    if (kind === "add" && onAdd?.(text)) {
      setValue("");
      return;
    }
    if (queue.length >= QUEUE_LIMIT) {
      input.classList.add("is-waiting");
      window.setTimeout(() => input.classList.remove("is-waiting"), 900);
      onNotice?.(`답변 중에는 ${QUEUE_LIMIT}개까지 넣을 수 있습니다. 지금 답변이 끝나면 다시 넣어 주세요.`);
      return;
    }
    queue = enqueue(queue, text, kind);
    setValue("");
    paintQueue();
  };

  const idlePlaceholder = input.placeholder;
  input.value = localStorage.getItem(DRAFT_KEY) ?? "";
  resize();
  paintSubmit();

  input.addEventListener("input", () => {
    historyIndex = sent.length;
    resize();
    saveDraft();
    paintSubmit();
  });

  // Ctrl+Enter pressed while a Korean syllable is still being composed only finishes the
  // syllable; queue the question once composition ends instead of needing a second press.
  let queueAfterComposition = false;
  input.addEventListener("compositionend", () => {
    if (!queueAfterComposition) return;
    queueAfterComposition = false;
    window.setTimeout(() => {
      if (busy) addToQueue("next");
    }, 0);
  });

  input.addEventListener("keydown", (event) => {
    if (busy && event.key === "Enter" && (event.ctrlKey || event.metaKey) && (event.isComposing || event.keyCode === 229)) {
      queueAfterComposition = true;
    }
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
        addToQueue(event.ctrlKey || event.metaKey ? "next" : "add");
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
        if (input.value.trim()) {
          addToQueue("add");
        } else {
          onStop();
        }
      }
    },
    { capture: true }
  );

  return {
    setBusy(next) {
      busy = next;
      form.classList.toggle("is-busy", next);
      input.placeholder = next ? "답변 중에도 입력하면 지금 작업에 반영합니다 (Ctrl+Enter: 다음 질문)" : idlePlaceholder;
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
    takeAdditions() {
      const additions = queue.filter((item) => item.kind === "add").map((item) => item.text);
      queue = queue.filter((item) => item.kind !== "add");
      paintQueue();
      return additions;
    },
    takeQueued() {
      const index = queue.findIndex((item) => item.kind === "next");
      if (index < 0) return undefined;
      const [item] = queue.splice(index, 1);
      paintQueue();
      return item.text;
    },
    returnQueuedToInput() {
      if (!queue.length) return;
      setValue([input.value.trim(), ...queue.map((item) => item.text)].filter(Boolean).join("\n\n"));
      queue = [];
      paintQueue();
      paintSubmit();
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
  "오늘 할 일을 정리해 줘",
  "이 글을 쉽게 요약해 줘: ",
  "작업 폴더에 무엇이 있는지 알려 줘",
  "이메일 답장을 공손하게 써 줘: ",
];

/** Shown in the chat with F1. */
export const SHORTCUT_HELP = [
  "**단축키**",
  "",
  "| 키 | 하는 일 |",
  "| --- | --- |",
  "| Enter | 보내기 |",
  "| Shift+Enter | 줄바꿈 |",
  "| ↑ / ↓ | 이전에 보낸 질문 불러오기 |",
  "| Enter (답변 중) | 지금 작업에 추가 지시 넣기 |",
  "| Ctrl+Enter (답변 중) | 다음 질문으로 기다리게 하기 |",
  "| Esc (답변 중) | 답변 멈추기 |",
  "| Ctrl+F | 이 대화에서 찾기 |",
  "| Ctrl+V | 그림 붙여넣기 |",
  "| Ctrl+Shift+Space | 캐릭터 숨기기·부르기 (설정에서 바꿀 수 있음) |",
  "| F1 | 이 도움말 |",
].join("\n");

export function renderWelcome(messages: HTMLElement, onPick: (text: string) => void): void {
  const box = document.createElement("div");
  box.className = "chat-welcome";
  const title = document.createElement("div");
  title.className = "chat-welcome-title";
  title.textContent = "무엇을 도와드릴까요?";
  const hint = document.createElement("div");
  hint.className = "chat-welcome-hint";
  hint.textContent = "Enter 보내기 · Shift+Enter 줄바꿈 · ↑ 이전 질문 · 그림은 Ctrl+V · 🎤 말로 입력 · F1 단축키 전체 보기";
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
