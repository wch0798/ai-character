import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  formatWorkLog,
  loadWorkLogSnapshot,
  type WorkLogSnapshot,
  WORK_LOG_STORAGE_KEY,
} from "./work-log-store";

const statusEl = document.querySelector<HTMLElement>("#work-log-status");
const bodyEl = document.querySelector<HTMLElement>("#work-log-body");
const closeButton = document.querySelector<HTMLButtonElement>("#work-log-close");

function paint(snapshot: WorkLogSnapshot): void {
  if (statusEl) {
    statusEl.textContent = snapshot.status || "기록 없음";
  }
  if (bodyEl) {
    bodyEl.textContent = formatWorkLog(snapshot);
  }
}

const injected = (window as unknown as { __AI_WORK_LOG?: WorkLogSnapshot }).__AI_WORK_LOG;
paint(injected ?? loadWorkLogSnapshot());
(
  window as unknown as { __aiPaintWorkLog?: (snapshot: WorkLogSnapshot) => void }
).__aiPaintWorkLog = paint;

void invoke<WorkLogSnapshot>("get_work_log")
  .then((snapshot) => {
    paint(snapshot ?? loadWorkLogSnapshot());
  })
  .catch(() => undefined);

void listen<WorkLogSnapshot>("work-log:update", (event) => {
  paint(event.payload);
}).catch(() => undefined);

window.addEventListener("storage", (event) => {
  if (event.key === WORK_LOG_STORAGE_KEY && event.newValue) {
    try {
      paint(JSON.parse(event.newValue) as WorkLogSnapshot);
    } catch {
      // ignore
    }
  }
});

const closeLog = (): void => {
  void invoke("close_work_log").catch(() => {
    void getCurrentWindow().close();
  });
};

closeButton?.addEventListener("click", closeLog);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeLog();
  }
});

let armed = false;
window.setTimeout(() => {
  armed = true;
}, 250);

void getCurrentWindow()
  .onFocusChanged((event) => {
    if (armed && event.payload === false) {
      closeLog();
    }
  })
  .catch(() => undefined);
