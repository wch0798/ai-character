import { describe, expect, it } from "vitest";
import { createMemoryHistoryStore } from "../chat-history";

describe("chat history", () => {
  it("대화와 메시지를 저장하고 다시 불러온다", () => {
    const store = createMemoryHistoryStore();
    const conversation = store.createConversation();
    store.appendMessage(conversation.id, "user", "첫 질문");
    store.appendMessage(conversation.id, "assistant", "첫 답변");

    const loaded = store.loadConversation(conversation.id);
    expect(loaded?.messages.map((message) => message.content)).toEqual([
      "첫 질문",
      "첫 답변",
    ]);
    expect(loaded?.title).toBe("첫 질문");
  });

  it("대화를 개별 삭제할 수 있다", () => {
    const store = createMemoryHistoryStore();
    const first = store.createConversation("첫 번째");
    store.createConversation("두 번째");
    store.deleteConversation(first.id);
    expect(store.listConversations().map((item) => item.title)).toEqual(["두 번째"]);
  });

  it("전체 채팅 기록을 삭제할 수 있다", () => {
    const store = createMemoryHistoryStore();
    store.createConversation("첫 번째");
    store.createConversation("두 번째");
    store.deleteAllConversations();
    expect(store.listConversations()).toEqual([]);
  });

  it("이전 메시지를 Claude용 컨텍스트로 만든다", () => {
    const store = createMemoryHistoryStore();
    const conversation = store.createConversation();
    store.appendMessage(conversation.id, "user", "내 이름은 테스트야");
    store.appendMessage(conversation.id, "assistant", "기억할게");
    expect(store.buildContext(conversation.id)).toContain("User: 내 이름은 테스트야");
    expect(store.buildContext(conversation.id)).toContain("Assistant: 기억할게");
  });

  it("긴 대화는 최근 메시지만 남긴다", () => {
    const store = createMemoryHistoryStore();
    const conversation = store.createConversation();
    for (let index = 0; index < 20; index += 1) {
      store.appendMessage(conversation.id, "user", `질문 ${index} ${"가".repeat(80)}`);
      store.appendMessage(conversation.id, "assistant", `답변 ${index}`);
    }

    const context = store.buildContext(conversation.id, 4, 800);
    expect(context).toContain("질문 19");
    expect(context).not.toContain("질문 0");
  });

  it("JSON 백업을 내보내고 다시 가져온다", () => {
    const store = createMemoryHistoryStore();
    const conversation = store.createConversation("백업 테스트");
    store.appendMessage(conversation.id, "user", "안녕");
    const json = store.exportJson(true);

    const other = createMemoryHistoryStore();
    const result = other.importSnapshot(json, "replace");
    expect(result.imported).toBe(1);
    expect(other.listConversations()[0]?.title).toBe("백업 테스트");
    expect(other.exportConversationMarkdown(conversation.id)).toContain("## 나");
  });
});
