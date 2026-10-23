import {
  getAppPreferences,
  getLastAgentLogins,
  listAgentModels,
  type AgentKind,
  type AgentModel,
  type ModelChoice,
} from "./agent-client";
import { CONVERSATION_SHOWN_EVENT, getShownConversationId } from "./chat-history-ui";

/**
 * The chat's program/model menu. Each conversation remembers its own pick; a new conversation
 * starts with the last one picked (or 기본 프로그램 from settings). Model lists come from the
 * programs themselves (list_agent_models).
 */
const CHOICES_KEY = "ai-character-conversation-models";
const LAST_KEY = "ai-character-last-model";
const MAX_REMEMBERED = 300;

export const AGENTS: Array<{ id: AgentKind; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "ChatGPT (Codex)" },
  { id: "cursor", label: "Cursor" },
  { id: "antigravity", label: "Antigravity" },
];

const AGENT_IDS = new Set<string>(AGENTS.map((agent) => agent.id));

function isChoice(value: unknown): value is ModelChoice {
  const choice = value as ModelChoice | null;
  return !!choice && AGENT_IDS.has(choice.agent) && typeof choice.model === "string";
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Remembered for this session only.
  }
}

type Stored = Record<string, ModelChoice & { at: number }>;

function readChoices(): Stored {
  const value = readJson(CHOICES_KEY);
  return value && typeof value === "object" ? (value as Stored) : {};
}

/** Keeps the newest picks when there are too many conversations to remember. */
export function prunedChoices(choices: Stored, limit = MAX_REMEMBERED): Stored {
  const entries = Object.entries(choices).filter(([, choice]) => isChoice(choice));
  if (entries.length <= limit) return Object.fromEntries(entries);
  return Object.fromEntries(entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, limit));
}

let fallbackAgent: AgentKind = "claude";

/** The pick for a conversation: its own, else the last pick, else 기본 프로그램 with its default model. */
export function choiceFor(conversationId: string | null): ModelChoice {
  const own = conversationId ? readChoices()[conversationId] : undefined;
  if (isChoice(own)) return { agent: own.agent, model: own.model };
  const last = readJson(LAST_KEY);
  if (isChoice(last)) return { agent: last.agent, model: last.model };
  return { agent: fallbackAgent, model: "" };
}

function remember(conversationId: string | null, choice: ModelChoice): void {
  if (conversationId) {
    const choices = readChoices();
    choices[conversationId] = { ...choice, at: Date.now() };
    writeJson(CHOICES_KEY, prunedChoices(choices));
  }
  writeJson(LAST_KEY, choice);
}

const modelLabels = new Map<string, string>();

function shortModelLabel(choice: ModelChoice): string {
  if (!choice.model) return "기본 모델";
  return modelLabels.get(`${choice.agent}:${choice.model}`) ?? choice.model;
}

function agentLabel(agent: AgentKind): string {
  return AGENTS.find((item) => item.id === agent)?.label ?? agent;
}

export function setupChatModelMenu(onNotice: (text: string) => void): void {
  const toolbarStart = document.querySelector<HTMLElement>("#chat-history-toolbar .chat-toolbar-start");
  // Inside the chat panel: clicks outside the panel's area pass through to the desktop.
  const panel = document.querySelector<HTMLElement>("#chat-panel");
  if (!toolbarStart || !panel) return;

  const button = document.createElement("button");
  button.type = "button";
  button.id = "chat-model-button";
  button.setAttribute("aria-haspopup", "menu");

  const menu = document.createElement("div");
  menu.id = "chat-model-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");

  toolbarStart.append(button);
  panel.append(menu);

  let viewAgent: AgentKind = "claude";

  const paintButton = () => {
    const choice = choiceFor(getShownConversationId());
    button.textContent = `${agentLabel(choice.agent).replace(" (Codex)", "")} · ${shortModelLabel(choice)} ▾`;
    button.title = "이 대화에서 답할 AI 프로그램과 모델을 고릅니다 (대화마다 따로 기억합니다)";
  };

  const close = () => {
    menu.hidden = true;
    button.classList.remove("open");
  };

  const place = () => {
    const rect = button.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left - box.left, box.width - 328))}px`;
    menu.style.top = `${rect.bottom - box.top + 6}px`;
  };

  const renderModels = async (list: HTMLElement, agent: AgentKind, refresh = false) => {
    list.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "chat-model-note";
    loading.textContent = "모델 목록을 불러오는 중…";
    list.append(loading);
    let models: AgentModel[];
    try {
      models = await listAgentModels(agent, refresh);
    } catch (error) {
      loading.textContent = `모델 목록을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    if (viewAgent !== agent) return;
    const current = choiceFor(getShownConversationId());
    list.replaceChildren();
    // Cursor alone offers hundreds of models: a long list gets a search box.
    const items: Array<{ element: HTMLElement; text: string }> = [];
    if (models.length > 12) {
      const search = document.createElement("input");
      search.type = "search";
      search.className = "chat-model-search";
      search.placeholder = `모델 ${models.length - 1}개 중 찾기`;
      search.addEventListener("input", () => {
        const query = search.value.trim().toLowerCase();
        for (const item of items) item.element.hidden = !!query && !item.text.includes(query);
      });
      list.append(search);
      window.setTimeout(() => search.focus(), 0);
    }
    for (const model of models) {
      modelLabels.set(`${agent}:${model.id}`, model.label);
      const item = document.createElement("button");
      item.type = "button";
      item.className = "chat-model-item";
      item.setAttribute("role", "menuitemradio");
      const checked = current.agent === agent && current.model === model.id;
      item.setAttribute("aria-checked", String(checked));
      const name = document.createElement("span");
      name.className = "chat-model-name";
      name.textContent = model.label;
      item.append(name);
      if (model.note) {
        const note = document.createElement("span");
        note.className = "chat-model-hint";
        note.textContent = model.note;
        item.append(note);
      }
      item.addEventListener("click", () => {
        const choice = { agent, model: model.id };
        remember(getShownConversationId(), choice);
        paintButton();
        close();
        onNotice(`이 대화는 ${agentLabel(agent)} · ${model.label}(으)로 답합니다`);
      });
      list.append(item);
      items.push({ element: item, text: `${model.id} ${model.label} ${model.note}`.toLowerCase() });
    }
    if (models.length <= 1) {
      const note = document.createElement("div");
      note.className = "chat-model-note";
      note.textContent = "이 프로그램에서 모델 목록을 받지 못했습니다. 설치·로그인 상태를 확인해 주세요.";
      list.append(note);
    }
  };

  const renderMenu = async () => {
    menu.replaceChildren();
    const logins = await getLastAgentLogins().catch(() => null);
    const tabs = document.createElement("div");
    tabs.className = "chat-model-tabs";
    const list = document.createElement("div");
    list.className = "chat-model-list";
    for (const agent of AGENTS) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "chat-model-tab";
      tab.textContent = agent.label;
      const login = logins?.find((item) => item.id === agent.id);
      if (login?.loggedIn === false) {
        tab.classList.add("is-signed-out");
        tab.title = "로그인이 필요합니다 (설정 → 계정 · 로그인)";
      }
      tab.setAttribute("aria-selected", String(agent.id === viewAgent));
      tab.addEventListener("click", () => {
        viewAgent = agent.id;
        for (const other of tabs.children) other.setAttribute("aria-selected", String(other === tab));
        void renderModels(list, agent.id);
      });
      tabs.append(tab);
    }
    const footer = document.createElement("div");
    footer.className = "chat-model-footer";
    const hint = document.createElement("span");
    hint.textContent = "대화마다 따로 기억합니다";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "목록 새로고침";
    refresh.addEventListener("click", () => void renderModels(list, viewAgent, true));
    footer.append(hint, refresh);
    menu.append(tabs, list, footer);
    void renderModels(list, viewAgent);
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!menu.hidden) {
      close();
      return;
    }
    viewAgent = choiceFor(getShownConversationId()).agent;
    place();
    menu.hidden = false;
    button.classList.add("open");
    void renderMenu();
  });
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());
  document.addEventListener("pointerdown", () => {
    if (!menu.hidden) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.stopPropagation();
      close();
    }
  }, true);
  window.addEventListener(CONVERSATION_SHOWN_EVENT, () => {
    close();
    paintButton();
  });

  paintButton();
  void getAppPreferences()
    .then((preferences) => {
      fallbackAgent = preferences.defaultAgent;
      paintButton();
    })
    .catch(() => undefined);
}
