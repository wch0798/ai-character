import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { buildTaskContext } = await import("../context-client");
const { contextBudgetFor } = await import("../orchestration-engine");

describe("작업 컨텍스트 클라이언트", () => {
  beforeEach(() => invokeMock.mockReset());

  it("대화 ID와 예산을 백엔드에 넘긴다", async () => {
    invokeMock.mockResolvedValue({ context: "ctx", fingerprint: "f", files: ["a.ts"], keywords: [], usedRipgrep: true, changedFiles: 0 });
    const result = await buildTaskContext("conv-1", "fix loadWidget", 4000);
    expect(invokeMock).toHaveBeenCalledWith("build_task_context", { conversationId: "conv-1", query: "fix loadWidget", maxChars: 4000 });
    expect(result.fingerprint).toBe("f");
  });

  it("백엔드 오류가 나도 빈 컨텍스트로 계속 진행한다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "build_task_context") {
        throw new Error("no project");
      }
      return undefined;
    });
    const result = await buildTaskContext("conv-1", "query", 4000);
    expect(result.context).toBe("");
    expect(result.fingerprint).toBe("");
  });

  it("빈 질의는 호출하지 않는다", async () => {
    await buildTaskContext("conv-1", "  ", 4000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("파일을 직접 읽는 CLI 워커는 더 작은 컨텍스트를 받는다", () => {
    expect(contextBudgetFor("codex")).toBeLessThan(contextBudgetFor("gemini_api"));
    expect(contextBudgetFor("claude_web")).toBe(contextBudgetFor("openrouter_api"));
  });
});
