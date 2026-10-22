import { describe, expect, it } from "vitest";
import { QUEUE_LIMIT, additionsPrompt, enqueue, mergedPrompt } from "../chat-composer";

describe("what the user types while an answer is running", () => {
  it("waits in order, keeps its kind and skips empty text", () => {
    let queue = enqueue([], "  화면도 같이 고쳐줘 ", "add");
    queue = enqueue(queue, "   ", "add");
    queue = enqueue(queue, "다음 질문", "next");
    expect(queue).toEqual([
      { kind: "add", text: "화면도 같이 고쳐줘" },
      { kind: "next", text: "다음 질문" },
    ]);
  });

  it("stops growing at the limit", () => {
    let queue = enqueue([], "질문 0");
    for (let i = 1; i < QUEUE_LIMIT + 3; i += 1) queue = enqueue(queue, `질문 ${i}`);
    expect(queue).toHaveLength(QUEUE_LIMIT);
  });

  it("folds notes into a restarted question", () => {
    const prompt = mergedPrompt("보고서 요약해줘", ["표로 정리해줘"]);
    expect(prompt.startsWith("보고서 요약해줘")).toBe(true);
    expect(prompt).toContain("[추가 지시]");
    expect(prompt).toContain("- 표로 정리해줘");
  });

  it("sends notes for a finished task as a follow-up, not a new question", () => {
    const prompt = additionsPrompt(["테스트도 추가해줘", "주석은 한국어로"]);
    expect(prompt).toContain("새 질문이 아니라");
    expect(prompt).toContain("- 테스트도 추가해줘\n- 주석은 한국어로");
  });
});
