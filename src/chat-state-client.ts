import { invoke } from "@tauri-apps/api/core";
import { waitForTauri } from "./tauri-ready";

type LocalStorageSnapshot = Record<string, string>;

const SYNC_INTERVAL_MS = 750;
let initialized = false;
let lastSyncedPayload: string | null = null;
let syncInFlight = false;
let lastWarningAt = 0;
// Set whenever localStorage is written, so the periodic sync skips re-encoding everything
// (the whole chat history included) when nothing changed.
let storageDirty = true;

function trackStorageWrites(): void {
  const storage = Object.getPrototypeOf(localStorage) as Storage;
  for (const name of ["setItem", "removeItem", "clear"] as const) {
    const original = storage[name] as (...args: unknown[]) => unknown;
    (storage as unknown as Record<string, unknown>)[name] = function (this: Storage, ...args: unknown[]) {
      if (this === localStorage) storageDirty = true;
      return original.apply(this, args);
    };
  }
}

function isTransientTauriError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /invoke|metadata|Failed to fetch|callback id|준비되지 않았습니다/i.test(
    text
  );
}

function readLocalStorageSnapshot(): LocalStorageSnapshot {
  const snapshot: LocalStorageSnapshot = {};
  const keys: string[] = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key !== null) keys.push(key);
  }

  keys.sort();
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value !== null) snapshot[key] = value;
  }

  return snapshot;
}

function encodeSnapshot(snapshot: LocalStorageSnapshot): string {
  return JSON.stringify(snapshot);
}

function decodeSnapshot(payload: string): LocalStorageSnapshot {
  const parsed: unknown = JSON.parse(payload);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SQLite UI 상태 형식이 올바르지 않습니다.");
  }

  const snapshot: LocalStorageSnapshot = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") snapshot[key] = value;
  }
  return snapshot;
}

function restoreSnapshot(snapshot: LocalStorageSnapshot): void {
  localStorage.clear();
  for (const [key, value] of Object.entries(snapshot)) {
    localStorage.setItem(key, value);
  }
}

async function persistIfChanged(): Promise<void> {
  if (syncInFlight || !storageDirty) return;
  if (!(await waitForTauri(1500))) return;
  storageDirty = false;
  const payload = encodeSnapshot(readLocalStorageSnapshot());
  if (payload === lastSyncedPayload) return;

  syncInFlight = true;
  try {
    await invoke("save_ui_state", { payload });
    lastSyncedPayload = payload;
  } catch (error) {
    // Not saved: try again on the next tick.
    storageDirty = true;
    if (!isTransientTauriError(error)) {
      const now = Date.now();
      if (now - lastWarningAt > 10_000) {
        console.warn("SQLite UI 상태 저장 대기 중:", error);
        lastWarningAt = now;
      }
    }
  } finally {
    syncInFlight = false;
  }
}

export async function initializeSqliteStateMirror(): Promise<void> {
  if (initialized) return;
  initialized = true;
  trackStorageWrites();

  try {
    await waitForTauri();
    const payload = await invoke<string | null>("load_ui_state");
    if (payload !== null) {
      const snapshot = decodeSnapshot(payload);
      restoreSnapshot(snapshot);
      lastSyncedPayload = encodeSnapshot(snapshot);
    } else {
      await persistIfChanged();
    }
  } catch (error) {
    if (!isTransientTauriError(error)) {
      console.warn("SQLite UI 상태 복원을 건너뜁니다:", error);
    }
  }

  window.setInterval(() => {
    void persistIfChanged();
  }, SYNC_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void persistIfChanged();
    }
  });

  window.addEventListener("pagehide", () => {
    void persistIfChanged();
  });
}
