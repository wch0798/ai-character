import { describe, expect, it } from "vitest";
import { createMemoryHistoryStore } from "../chat-history";

describe("a reply that arrives after the user switched conversations", () => {
  it("is saved in its own conversation without switching back to it", () => {
    const store = createMemoryHistoryStore();
    const asked = store.createConversation("질문한 대화");
    const viewing = store.createConversation("지금 보는 대화");
    store.setActiveConversation(viewing.id);

    store.appendMessage(asked.id, "assistant", "늦게 온 답", { activate: false });

    expect(store.getActiveConversationId()).toBe(viewing.id);
    expect(store.loadConversation(asked.id)?.messages.map((message) => message.content)).toEqual(["늦게 온 답"]);
    expect(store.loadConversation(viewing.id)?.messages).toEqual([]);
  });
});
