import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

import { folderName } from "../conversation-folder-ui";

describe("folderName", () => {
  it("shows only the last folder of Windows and Unix paths", () => {
    expect(folderName("E:\\AI 작업")).toBe("AI 작업");
    expect(folderName("D:\\Projects\\my-app\\")).toBe("my-app");
    expect(folderName("/Users/me/code/site")).toBe("site");
    expect(folderName("C:\\")).toBe("C:");
  });
});
