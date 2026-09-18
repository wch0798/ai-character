import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTauriInternalFetchUrl,
  shouldPatchLive2DFetch,
} from "../live2d-fetch-mime";
import { isTauriRuntimeReady } from "../tauri-ready";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Tauri IPC fetch 보호", () => {
  it("ipc/tauri 내부 URL은 MIME 패치를 건너뛴다", () => {
    expect(isTauriInternalFetchUrl("ipc://localhost/invoke")).toBe(true);
    expect(isTauriInternalFetchUrl("http://ipc.localhost/invoke")).toBe(true);
    expect(isTauriInternalFetchUrl("https://ipc.localhost/plugin")).toBe(true);
    expect(isTauriInternalFetchUrl("tauri://localhost")).toBe(true);
    expect(
      isTauriInternalFetchUrl("http://localhost:1420/live2d/models/Hiyori/Hiyori.model3.json")
    ).toBe(false);
  });

  it("Live2D 에셋만 fetch 패치 대상이다", () => {
    expect(
      shouldPatchLive2DFetch("http://localhost:1420/live2d/models/Hiyori/Hiyori.model3.json")
    ).toBe(true);
    expect(shouldPatchLive2DFetch("http://ipc.localhost/invoke")).toBe(false);
    expect(shouldPatchLive2DFetch("http://127.0.0.1:4318/api/usage")).toBe(false);
    expect(shouldPatchLive2DFetch("/settings.json")).toBe(false);
  });
});

describe("Tauri 준비 상태", () => {
  it("invoke만 있고 window metadata가 없으면 아직 준비되지 않은 것으로 본다", () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: { invoke: () => undefined },
    });
    expect(isTauriRuntimeReady()).toBe(false);
  });

  it("invoke와 currentWindow label이 있으면 준비된 것으로 본다", () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {
        invoke: () => undefined,
        metadata: { currentWindow: { label: "main" } },
      },
    });
    expect(isTauriRuntimeReady()).toBe(true);
  });
});
