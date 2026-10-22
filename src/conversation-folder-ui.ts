import {
  CONVERSATION_DIR_EVENT,
  chooseConversationDirectory,
  getConversationDir,
  setConversationDir,
  type ConversationDir,
} from "./agent-client";
import { CONVERSATION_SHOWN_EVENT, getShownConversationId } from "./chat-history-ui";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Last folder segment, so a long path still reads at a glance in the narrow chat window. */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * A thin bar under the chat toolbar showing which folder this conversation works in, like a
 * Claude Code session: each conversation can pick its own folder, or follow the default one.
 */
export function initializeConversationFolderUi(): void {
  if (document.querySelector("#chat-folder-bar")) {
    return;
  }
  const toolbar = document.querySelector<HTMLElement>("#chat-history-toolbar");
  if (!toolbar) {
    return;
  }

  const bar = document.createElement("div");
  bar.id = "chat-folder-bar";

  const label = document.createElement("span");
  label.className = "chat-folder-label";
  label.textContent = "📁 작업 폴더 확인 중…";

  const changeButton = document.createElement("button");
  changeButton.type = "button";
  changeButton.className = "chat-folder-change";
  changeButton.textContent = "바꾸기";
  changeButton.setAttribute("aria-haspopup", "menu");

  const menu = document.createElement("div");
  menu.className = "chat-folder-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  bar.append(label, changeButton, menu);
  toolbar.insertAdjacentElement("afterend", bar);

  let status: ConversationDir | null = null;

  const paint = (): void => {
    if (!status?.path) {
      label.textContent = "📁 작업 폴더 없음 — 파일 작업을 하려면 고르세요";
      label.title = "";
      changeButton.textContent = "고르기";
      return;
    }
    label.textContent = `📁 ${folderName(status.path)}${status.custom ? "" : " (기본)"}`;
    label.title = `${status.path}\n${status.custom ? "이 대화만 쓰는 폴더입니다." : "설정의 기본 작업 폴더입니다. '바꾸기'로 이 대화만 다른 폴더를 쓸 수 있어요."}`;
    changeButton.textContent = "바꾸기";
  };

  const refresh = async (): Promise<void> => {
    try {
      status = await getConversationDir(getShownConversationId());
      paint();
    } catch (error) {
      label.textContent = "📁 작업 폴더를 읽지 못했습니다";
      label.title = errorText(error);
    }
  };

  const closeMenu = (): void => {
    menu.hidden = true;
    changeButton.setAttribute("aria-expanded", "false");
  };

  const run = async (task: () => Promise<unknown>): Promise<void> => {
    closeMenu();
    changeButton.disabled = true;
    try {
      await task();
    } catch (error) {
      const text = errorText(error);
      if (!text.includes("취소")) {
        label.textContent = `📁 폴더를 바꾸지 못했습니다: ${text}`;
        label.title = text;
        return;
      }
    } finally {
      changeButton.disabled = false;
    }
    await refresh();
  };

  const menuItem = (text: string, title: string, action: () => Promise<unknown>): HTMLButtonElement => {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.textContent = text;
    item.title = title;
    item.addEventListener("click", () => void run(action));
    return item;
  };

  const openMenu = (): void => {
    const id = getShownConversationId();
    if (!id) {
      return;
    }
    const items: HTMLElement[] = [];
    const heading = document.createElement("div");
    heading.className = "chat-folder-menu-title";
    heading.textContent = "이 대화의 작업 폴더";
    items.push(heading);
    for (const path of status?.recent ?? []) {
      if (path === status?.path) continue;
      items.push(menuItem(`📁 ${folderName(path)}`, path, () => setConversationDir(id, path)));
    }
    items.push(menuItem("📂 다른 폴더 고르기…", "탐색기에서 폴더를 고릅니다.", () => chooseConversationDirectory(id)));
    if (status?.custom && status.defaultPath) {
      items.push(
        menuItem(`↩ 기본 폴더 쓰기 (${folderName(status.defaultPath)})`, status.defaultPath, () => setConversationDir(id, null))
      );
    }
    const note = document.createElement("div");
    note.className = "chat-folder-menu-note";
    note.textContent = "새 대화는 기본 폴더로 시작합니다. 기본 폴더는 설정에서 바꿉니다.";
    items.push(note);
    menu.replaceChildren(...items);
    menu.hidden = false;
    changeButton.setAttribute("aria-expanded", "true");
  };

  changeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!menu.hidden) {
      closeMenu();
      return;
    }
    // With no folder at all there is nothing to choose from yet; go straight to the picker.
    const id = getShownConversationId();
    if (id && !status?.path) {
      void run(() => chooseConversationDirectory(id));
      return;
    }
    openMenu();
  });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !bar.contains(event.target as Node)) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  window.addEventListener(CONVERSATION_SHOWN_EVENT, () => {
    closeMenu();
    void refresh();
  });
  window.addEventListener(CONVERSATION_DIR_EVENT, () => void refresh());
  // The default folder can change in settings or the web setup page while the app is open.
  window.addEventListener("focus", () => void refresh());
  void refresh();
}
