import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { applyStreamEvent } from "../chat-stream";

describe("chat stream", () => {
  it("appends deltas, resets on new attempts, and ignores other streams", () => {
    let text = "";
    text = applyStreamEvent(text, { streamId: "a", reset: true, text: "" }, "a");
    text = applyStreamEvent(text, { streamId: "a", reset: false, text: "안녕" }, "a");
    text = applyStreamEvent(text, { streamId: "a", reset: false, text: "하세요" }, "a");
    expect(text).toBe("안녕하세요");
    expect(applyStreamEvent(text, { streamId: "b", reset: false, text: "x" }, "a")).toBe("안녕하세요");
    expect(applyStreamEvent(text, { streamId: "a", reset: true, text: "" }, "a")).toBe("");
  });
});
