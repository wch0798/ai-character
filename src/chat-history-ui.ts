import { safeConfirm } from "./safe-confirm";
import {
  createBrowserHistoryStore,
  type ChatConversation,
  type ChatRole,
} from "./chat-history";

export type ChatHistoryManager = {
  getActiveId(): string;
  getContext(): string;
  append(role: ChatRole, content: string): void;
  refresh(): void;
};

type SetupOptions = {
  messages: HTMLDivElement;
  addMessage(text: string, type: ChatRole): void;
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

  let active = store.ensureActiveConversation();

  const renderMessages = (conversation: ChatConversation) => {
    options.messages.innerHTML = "";

    if (conversation.messages.length === 0) {
      options.addMessage("안녕하세요. 무엇을 도와드릴까요?", "assistant");
      return;
    }

    for (const message of conversation.messages) {
      options.addMessage(message.content, message.role);
    }
  };

  const closeRowMenus = () => {
    list
      ?.querySelectorAll<HTMLElement>(".chat-history-row-menu.open")
      .forEach((menu) => menu.classList.remove("open"));

    list
      ?.querySelectorAll<HTMLElement>(".chat-history-more.open")
      .forEach((button) => button.classList.remove("open"));
  };

  const openConversation = (id: string) => {
    const conversation = store.setActiveConversation(id);
    if (!conversation) return;

    active = conversation;
    renderMessages(active);
    drawer?.classList.remove("open");
    renderList();
  };

  const createNewConversation = () => {
    active = store.createConversation();
    renderMessages(active);
    drawer?.classList.remove("open");
    renderList();
  };

  const renderList = () => {
    if (!list) return;

    list.innerHTML = "";

    const conversations = store.listConversations(
      searchInput?.value ?? ""
    );

    for (const conversation of conversations) {
      const row = document.createElement("div");
      row.className = "chat-history-row";

      if (conversation.id === active.id) {
        row.classList.add("active");
      }

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "chat-history-open";
      openButton.textContent = conversation.title;
      openButton.title = new Date(
        conversation.updatedAt
      ).toLocaleString();
      openButton.addEventListener("click", () => {
        openConversation(conversation.id);
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
      renameButton.addEventListener("click", () => {
        const value = window.prompt(
          "대화 이름",
          conversation.title
        );

        if (!value?.trim()) return;

        store.renameConversation(
          conversation.id,
          value
        );

        if (conversation.id === active.id) {
          active = store.loadConversation(active.id) ?? active;
        }

        renderList();
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "chat-history-action danger";
      deleteButton.textContent = "삭제";
      deleteButton.addEventListener("click", () => {
        if (
          !safeConfirm(
            `"${conversation.title}" 대화를 삭제할까요?`
          )
        ) {
          return;
        }

        store.deleteConversation(conversation.id);
        active =
          store.getActiveConversation() ??
          store.createConversation();
        renderMessages(active);
        renderList();
      });

      rowMenu.append(
        renameButton,
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

  deleteAllButton?.addEventListener("click", () => {
    if (
      !safeConfirm(
        "모든 채팅 기록을 삭제할까요? 이 작업은 되돌릴 수 없습니다."
      )
    ) {
      return;
    }

    store.deleteAllConversations();
    active = store.createConversation();
    renderMessages(active);
    renderList();
  });

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

    append(role, content) {
      store.appendMessage(
        active.id,
        role,
        content
      );

      active =
        store.loadConversation(active.id) ??
        active;

      renderList();
    },

    refresh() {
      active =
        store.loadConversation(active.id) ??
        active;

      renderList();
    },
  };
}
