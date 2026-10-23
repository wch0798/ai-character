import {
  createBrowserHistoryStore,
  type ChatConversation,
  type ChatRole,
} from "./chat-history";
import {
  appendParts,
  clearHighlights,
  highlightMessages,
  matchConversation,
  stepIndex,
} from "./chat-search";
import { confirmOnSecondClick } from "./settings-controls";
import { exportAllChatsJson, exportConversationMarkdown, importChatsFromJson } from "./chat-backup";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

function flashLabel(button: HTMLButtonElement, text: string): void {
  const original = button.dataset.label ?? button.textContent ?? "";
  button.dataset.label = original;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = original;
    delete button.dataset.label;
  }, 1600);
}

export const CONVERSATION_SHOWN_EVENT = "ai-character:conversation-shown";
let shownConversationId: string | null = null;

/** The conversation currently on screen, for UI that follows it (e.g. its work folder). */
export function getShownConversationId(): string | null {
  return shownConversationId;
}

export type ChatHistoryManager = {
  getActiveId(): string;
  getContext(): string;
  append(role: ChatRole, content: string, source?: string): void;
  /**
   * Saves into a given conversation, which may no longer be on screen (the user switched while
   * the answer was on its way). Returns whether that conversation is the one showing.
   */
  appendTo(conversationId: string, role: ChatRole, content: string, source?: string): boolean;
  refresh(): void;
};

type SetupOptions = {
  messages: HTMLDivElement;
  addMessage(text: string, type: ChatRole, createdAt?: number, source?: string): void;
  showWelcome?: () => void;
};

export function setupChatHistory(options: SetupOptions): ChatHistoryManager {
  const store = createBrowserHistoryStore();
  const historyButton = document.querySelector<HTMLButtonElement>("#chat-history-button");
  const newButton = document.querySelector<HTMLButtonElement>("#new-chat-button");
  const drawer = document.querySelector<HTMLDivElement>("#chat-history-drawer");
  const closeButton = document.querySelector<HTMLButtonElement>("#chat-history-close");
  const searchInput = document.querySelector<HTMLInputElement>("#chat-history-search");
  const list = document.querySelector<HTMLDivElement>("#chat-history-list");
  const deleteAllButton = document.querySelector<HTMLButtonElement>("#chat-history-delete-all");
  const exportAllButton = document.querySelector<HTMLButtonElement>("#chat-history-export-all");
  const importButton = document.querySelector<HTMLButtonElement>("#chat-history-import");
  exportAllButton?.setAttribute("title", "모든 대화를 JSON 파일로 저장합니다");
  importButton?.setAttribute("title", "JSON 백업에서 대화를 추가합니다 (기존 대화는 유지)");

  let active = store.ensureActiveConversation();

  const findBar = document.createElement("div");
  findBar.id = "chat-find-bar";
  findBar.hidden = true;
  const findInput = document.createElement("input");
  findInput.type = "search";
  findInput.placeholder = "이 대화에서 찾기";
  findInput.setAttribute("aria-label", "이 대화에서 찾기");
  const findCount = document.createElement("span");
  findCount.className = "chat-find-count";
  const findButton = (label: string, title: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    return button;
  };
  const prevButton = findButton("↑", "이전 결과 (Shift+Enter)");
  const nextButton = findButton("↓", "다음 결과 (Enter)");
  const closeFindButton = findButton("×", "찾기 닫기 (Esc)");
  findBar.append(findInput, findCount, prevButton, nextButton, closeFindButton);
  options.messages.before(findBar);

  let renaming = false;
  let hits: HTMLElement[] = [];
  let hitIndex = -1;

  const focusHit = (index: number) => {
    hits[hitIndex]?.classList.remove("current");
    hitIndex = index;
    const hit = hits[hitIndex];
    if (hit) {
      hit.classList.add("current");
      hit.scrollIntoView({ block: "center" });
    }
    findCount.textContent = hits.length === 0 ? (findInput.value.trim() ? "결과 없음" : "") : `${hitIndex + 1} / ${hits.length}`;
    prevButton.disabled = nextButton.disabled = hits.length < 2;
  };

  const runFind = () => {
    hits = highlightMessages(options.messages, findInput.value);
    hitIndex = -1;
    focusHit(hits.length > 0 ? 0 : -1);
  };

  const openFind = (query: string) => {
    findBar.hidden = false;
    findInput.value = query;
    runFind();
    findInput.focus();
  };

  const closeFind = () => {
    findBar.hidden = true;
    clearHighlights(options.messages);
    hits = [];
    hitIndex = -1;
  };

  findInput.addEventListener("input", runFind);
  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      focusHit(stepIndex(hitIndex, event.shiftKey ? -1 : 1, hits.length));
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
    }
  });
  prevButton.addEventListener("click", () => focusHit(stepIndex(hitIndex, -1, hits.length)));
  nextButton.addEventListener("click", () => focusHit(stepIndex(hitIndex, 1, hits.length)));
  closeFindButton.addEventListener("click", closeFind);
  document.addEventListener("keydown", (event) => {
    const panel = options.messages.closest("#chat-panel");
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && panel?.classList.contains("open")) {
      event.preventDefault();
      openFind(findInput.value);
      findInput.select();
    }
  });

  const renderMessages = (conversation: ChatConversation) => {
    if (shownConversationId !== conversation.id) {
      shownConversationId = conversation.id;
      window.dispatchEvent(new CustomEvent(CONVERSATION_SHOWN_EVENT, { detail: { id: conversation.id } }));
    }
    closeFind();
    options.messages.innerHTML = "";

    if (conversation.messages.length === 0) {
      if (options.showWelcome) {
        options.showWelcome();
      } else {
        options.addMessage("안녕하세요. 무엇을 도와드릴까요?", "assistant");
      }
      return;
    }

    for (const message of conversation.messages) {
      options.addMessage(message.content, message.role, message.createdAt, message.source);
    }
    options.messages.scrollTop = options.messages.scrollHeight;
  };

  const closeRowMenus = () => {
    list
      ?.querySelectorAll<HTMLElement>(".chat-history-row-menu.open")
      .forEach((menu) => menu.classList.remove("open"));

    list
      ?.querySelectorAll<HTMLElement>(".chat-history-more.open")
      .forEach((button) => button.classList.remove("open"));
  };

  const openConversation = (id: string, query = "") => {
    const conversation = store.setActiveConversation(id);
    if (!conversation) return;

    active = conversation;
    renderMessages(active);
    drawer?.classList.remove("open");
    renderList();
    if (query.trim()) {
      openFind(query.trim());
    }
  };

  const startRename = (row: HTMLElement, openButton: HTMLButtonElement, conversation: ChatConversation) => {
    closeRowMenus();
    const input = document.createElement("input");
    input.className = "chat-history-rename";
    input.value = conversation.title;
    input.setAttribute("aria-label", "대화 이름");
    let done = false;
    renaming = true;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      renaming = false;
      const value = input.value.trim();
      if (save && value && value !== conversation.title) {
        store.renameConversation(conversation.id, value);
        if (conversation.id === active.id) {
          active = store.loadConversation(active.id) ?? active;
        }
      }
      renderList();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    openButton.replaceWith(input);
    row.classList.add("renaming");
    input.focus();
    input.select();
  };

  const createNewConversation = () => {
    active = store.createConversation();
    renderMessages(active);
    drawer?.classList.remove("open");
    renderList();
  };

  const renderList = () => {
    if (!list || renaming) return;

    list.innerHTML = "";

    const query = (searchInput?.value ?? "").trim();
    const conversations = store.listConversations(query);

    if (conversations.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chat-history-empty";
      empty.textContent = query ? `'${query}'와 일치하는 대화가 없습니다.` : "저장된 대화가 없습니다.";
      list.append(empty);
    }

    for (const conversation of conversations) {
      const row = document.createElement("div");
      row.className = "chat-history-row";

      if (conversation.id === active.id) {
        row.classList.add("active");
      }

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "chat-history-open";
      const titleLine = document.createElement("span");
      titleLine.className = "chat-history-title";
      titleLine.textContent = conversation.title;
      if (conversation.pinned) {
        row.classList.add("pinned");
        const pin = document.createElement("span");
        pin.className = "chat-history-pin";
        pin.textContent = "고정";
        titleLine.prepend(pin);
      }
      openButton.append(titleLine);
      openButton.title = new Date(
        conversation.updatedAt
      ).toLocaleString();
      if (query) {
        const match = matchConversation(conversation.messages, query);
        if (match.count > 0) {
          const count = document.createElement("span");
          count.className = "chat-history-count";
          count.textContent = `${match.count}개`;
          titleLine.append(count);
        }
        if (match.snippet) {
          const snippet = document.createElement("span");
          snippet.className = "chat-history-snippet";
          appendParts(snippet, match.snippet, "chat-history-hit");
          openButton.append(snippet);
        }
      }
      openButton.addEventListener("click", () => {
        openConversation(conversation.id, query);
      });

      const moreButton = document.createElement("button");
      moreButton.type = "button";
      moreButton.className = "chat-history-more";
      moreButton.textContent = "⋯";
      moreButton.title = "대화 관리";
      moreButton.setAttribute("aria-label", "대화 관리");

      const rowMenu = document.createElement("div");
      rowMenu.className = "chat-history-row-menu";

      moreButton.addEventListener("click", (event) => {
        event.stopPropagation();

        const willOpen = !rowMenu.classList.contains("open");
        closeRowMenus();

        if (willOpen) {
          rowMenu.classList.add("open");
          moreButton.classList.add("open");
        }
      });

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "chat-history-action";
      renameButton.textContent = "이름 변경";
      renameButton.addEventListener("click", (event) => {
        event.stopPropagation();
        startRename(row, openButton, conversation);
      });

      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.className = "chat-history-action";
      pinButton.textContent = conversation.pinned ? "고정 해제" : "맨 위에 고정";
      pinButton.addEventListener("click", (event) => {
        event.stopPropagation();
        store.setPinned(conversation.id, !conversation.pinned);
        renderList();
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "chat-history-action danger";
      deleteButton.textContent = "삭제";
      deleteButton.title = "한 번 더 누르면 삭제합니다.";
      confirmOnSecondClick(deleteButton, "정말 삭제?", () => {
        store.deleteConversation(conversation.id);
        active =
          store.getActiveConversation() ??
          store.createConversation();
        renderMessages(active);
        renderList();
      });

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "chat-history-action";
      copyButton.textContent = "Markdown 복사";
      copyButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const markdown = store.exportConversationMarkdown(conversation.id);
        if (!markdown) return;
        void copyToClipboard(markdown).then((ok) => {
          flashLabel(copyButton, ok ? "복사됨" : "복사 실패");
        });
      });

      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.className = "chat-history-action";
      saveButton.textContent = "Markdown 저장";
      saveButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void exportConversationMarkdown(store, conversation.id, conversation.title)
          .then(() => flashLabel(saveButton, "저장됨"))
          .catch((error) => {
            const text = error instanceof Error ? error.message : String(error);
            flashLabel(saveButton, text.includes("취소") ? "취소됨" : "저장 실패");
          });
      });

      rowMenu.append(
        pinButton,
        renameButton,
        copyButton,
        saveButton,
        deleteButton
      );

      row.append(
        openButton,
        moreButton,
        rowMenu
      );

      list.appendChild(row);
    }
  };

  historyButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    drawer?.classList.toggle("open");

    if (drawer?.classList.contains("open")) {
      renderList();
      searchInput?.focus();
    }
  });

  closeButton?.addEventListener("click", () => {
    closeRowMenus();
    drawer?.classList.remove("open");
  });

  newButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    createNewConversation();
  });
  searchInput?.addEventListener("input", renderList);

  exportAllButton?.addEventListener("click", () => {
    void exportAllChatsJson(store)
      .then(() => flashLabel(exportAllButton, "저장됨"))
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        flashLabel(exportAllButton, text.includes("취소") ? "취소됨" : "저장 실패");
      });
  });

  importButton?.addEventListener("click", () => {
    void importChatsFromJson(store, "merge")
      .then((result) => {
        active = store.loadConversation(active.id) ?? store.ensureActiveConversation();
        renderList();
        flashLabel(importButton, `${result.imported}개 가져옴`);
      })
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error);
        flashLabel(importButton, text.includes("취소") ? "취소됨" : "가져오기 실패");
        importButton.title = text;
      });
  });

  if (deleteAllButton) {
    deleteAllButton.title = "한 번 더 누르면 모든 대화를 지웁니다. 되돌릴 수 없습니다.";
    confirmOnSecondClick(deleteAllButton, "한 번 더 누르면 전체 삭제", () => {
      store.deleteAllConversations();
      active = store.createConversation();
      renderMessages(active);
      renderList();
    });
  }

  renderMessages(active);
  renderList();

  return {
    getActiveId() {
      return active.id;
    },

    getContext() {
      return store.buildContext(
        active.id,
        8,
        2_400
      );
    },

    append(role, content, source) {
      store.appendMessage(
        active.id,
        role,
        content,
        { source }
      );

      active =
        store.loadConversation(active.id) ??
        active;

      renderList();
    },

    appendTo(conversationId, role, content, source) {
      if (conversationId === active.id) {
        this.append(role, content, source);
        return true;
      }
      try {
        store.appendMessage(conversationId, role, content, { activate: false, source });
      } catch {
        // The conversation was deleted while the answer was on its way.
      }
      renderList();
      return false;
    },

    refresh() {
      active =
        store.loadConversation(active.id) ??
        active;

      renderList();
    },
  };
}
