export type ChatRole = "user" | "assistant";

export type ChatMessageRecord = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
};

export type ChatConversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessageRecord[];
};

export type ChatHistorySnapshot = {
  version: 1;
  activeConversationId: string | null;
  conversations: ChatConversation[];
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type StoreOptions = {
  storage: StorageLike;
  key?: string;
  now?: () => number;
  idFactory?: () => string;
};

const DEFAULT_KEY = "ai-character-chat-history-v1";

function defaultIdFactory(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptySnapshot(): ChatHistorySnapshot {
  return {
    version: 1,
    activeConversationId: null,
    conversations: [],
  };
}

function normalizeTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "새 채팅";
  return normalized.length > 36
    ? `${normalized.slice(0, 36)}…`
    : normalized;
}

export class ChatHistoryStore {
  private readonly storage: StorageLike;
  private readonly key: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: StoreOptions) {
    this.storage = options.storage;
    this.key = options.key ?? DEFAULT_KEY;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  private read(): ChatHistorySnapshot {
    const raw = this.storage.getItem(this.key);
    if (!raw) return emptySnapshot();

    try {
      const parsed = JSON.parse(raw) as Partial<ChatHistorySnapshot>;
      if (parsed.version !== 1 || !Array.isArray(parsed.conversations)) {
        return emptySnapshot();
      }

      return {
        version: 1,
        activeConversationId:
          typeof parsed.activeConversationId === "string"
            ? parsed.activeConversationId
            : null,
        conversations: parsed.conversations as ChatConversation[],
      };
    } catch {
      return emptySnapshot();
    }
  }

  private write(snapshot: ChatHistorySnapshot): void {
    this.storage.setItem(this.key, JSON.stringify(snapshot));
  }

  createConversation(title = "새 채팅"): ChatConversation {
    const snapshot = this.read();
    const time = this.now();
    const conversation: ChatConversation = {
      id: this.idFactory(),
      title: normalizeTitle(title),
      createdAt: time,
      updatedAt: time,
      messages: [],
    };

    snapshot.conversations.push(conversation);
    snapshot.activeConversationId = conversation.id;
    this.write(snapshot);
    return structuredClone(conversation);
  }

  ensureActiveConversation(): ChatConversation {
    const active = this.getActiveConversation();
    return active ?? this.createConversation();
  }

  getActiveConversationId(): string | null {
    return this.read().activeConversationId;
  }

  getActiveConversation(): ChatConversation | null {
    const snapshot = this.read();
    const id = snapshot.activeConversationId;
    if (!id) return null;
    const conversation = snapshot.conversations.find((item) => item.id === id);
    return conversation ? structuredClone(conversation) : null;
  }

  setActiveConversation(id: string): ChatConversation | null {
    const snapshot = this.read();
    const conversation = snapshot.conversations.find((item) => item.id === id);
    if (!conversation) return null;
    snapshot.activeConversationId = id;
    this.write(snapshot);
    return structuredClone(conversation);
  }

  loadConversation(id: string): ChatConversation | null {
    const conversation = this.read().conversations.find((item) => item.id === id);
    return conversation ? structuredClone(conversation) : null;
  }

  listConversations(query = ""): ChatConversation[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return this.read().conversations
      .filter((conversation) => {
        if (!normalizedQuery) return true;
        if (conversation.title.toLocaleLowerCase().includes(normalizedQuery)) {
          return true;
        }
        return conversation.messages.some((message) =>
          message.content.toLocaleLowerCase().includes(normalizedQuery)
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((conversation) => structuredClone(conversation));
  }

  appendMessage(id: string, role: ChatRole, content: string): ChatMessageRecord {
    const snapshot = this.read();
    const conversation = snapshot.conversations.find((item) => item.id === id);
    if (!conversation) {
      throw new Error("대화를 찾을 수 없습니다.");
    }

    const time = this.now();
    const message: ChatMessageRecord = {
      id: this.idFactory(),
      role,
      content,
      createdAt: time,
    };

    conversation.messages.push(message);
    conversation.updatedAt = time;

    if (role === "user" && conversation.title === "새 채팅") {
      conversation.title = normalizeTitle(content);
    }

    snapshot.activeConversationId = id;
    this.write(snapshot);
    return structuredClone(message);
  }

  renameConversation(id: string, title: string): boolean {
    const snapshot = this.read();
    const conversation = snapshot.conversations.find((item) => item.id === id);
    if (!conversation) return false;
    conversation.title = normalizeTitle(title);
    conversation.updatedAt = this.now();
    this.write(snapshot);
    return true;
  }

  deleteConversation(id: string): void {
    const snapshot = this.read();
    snapshot.conversations = snapshot.conversations.filter((item) => item.id !== id);
    if (snapshot.activeConversationId === id) {
      snapshot.activeConversationId = snapshot.conversations
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
    }
    this.write(snapshot);
  }

  deleteAllConversations(): void {
    this.storage.removeItem(this.key);
  }

  getSnapshot(): ChatHistorySnapshot {
    return structuredClone(this.read());
  }

  exportJson(pretty = true): string {
    return pretty
      ? `${JSON.stringify(this.getSnapshot(), null, 2)}\n`
      : JSON.stringify(this.getSnapshot());
  }

  exportConversationMarkdown(id: string): string | null {
    const conversation = this.loadConversation(id);
    if (!conversation) return null;

    const lines = [
      `# ${conversation.title}`,
      "",
      `- 생성: ${new Date(conversation.createdAt).toLocaleString()}`,
      `- 수정: ${new Date(conversation.updatedAt).toLocaleString()}`,
      "",
    ];

    for (const message of conversation.messages) {
      const speaker = message.role === "assistant" ? "AI" : "나";
      lines.push(`## ${speaker}`);
      lines.push("");
      lines.push(message.content);
      lines.push("");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  importSnapshot(
    raw: string,
    mode: "replace" | "merge" = "merge"
  ): { imported: number; mode: "replace" | "merge" } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("백업 파일이 올바른 JSON이 아닙니다.");
    }

    const incoming = parsed as Partial<ChatHistorySnapshot>;
    if (incoming.version !== 1 || !Array.isArray(incoming.conversations)) {
      throw new Error("지원하지 않는 채팅 백업 형식입니다.");
    }

    const conversations = incoming.conversations as ChatConversation[];
    if (mode === "replace") {
      this.write({
        version: 1,
        activeConversationId:
          typeof incoming.activeConversationId === "string"
            ? incoming.activeConversationId
            : conversations[0]?.id ?? null,
        conversations,
      });
      return { imported: conversations.length, mode };
    }

    const snapshot = this.read();
    const known = new Set(snapshot.conversations.map((item) => item.id));
    let imported = 0;

    for (const conversation of conversations) {
      if (!conversation || typeof conversation.id !== "string") {
        continue;
      }

      if (known.has(conversation.id)) {
        const cloned: ChatConversation = {
          ...structuredClone(conversation),
          id: this.idFactory(),
        };
        snapshot.conversations.push(cloned);
        imported += 1;
        continue;
      }

      snapshot.conversations.push(structuredClone(conversation));
      known.add(conversation.id);
      imported += 1;
    }

    if (
      typeof incoming.activeConversationId === "string" &&
      snapshot.conversations.some(
        (item) => item.id === incoming.activeConversationId
      )
    ) {
      snapshot.activeConversationId = incoming.activeConversationId;
    }

    this.write(snapshot);
    return { imported, mode };
  }

  buildContext(id: string, maxMessages = 8, maxChars = 2_400): string {
    const conversation = this.loadConversation(id);
    if (!conversation) return "";

    const text = conversation.messages
      .slice(-Math.max(1, maxMessages))
      .map((message) => {
        const speaker = message.role === "assistant" ? "Assistant" : "User";
        const content =
          message.content.length > 400
            ? `${message.content.slice(0, 399)}…`
            : message.content;
        return `${speaker}: ${content}`;
      })
      .join("\n");

    if (text.length <= maxChars) return text;
    return text.slice(text.length - maxChars);
  }
}

export function createBrowserHistoryStore(): ChatHistoryStore {
  return new ChatHistoryStore({ storage: window.localStorage });
}

export function createMemoryHistoryStore(): ChatHistoryStore {
  const memory = new Map<string, string>();
  const storage: StorageLike = {
    getItem(key) {
      return memory.get(key) ?? null;
    },
    setItem(key, value) {
      memory.set(key, value);
    },
    removeItem(key) {
      memory.delete(key);
    },
  };
  return new ChatHistoryStore({ storage });
}
