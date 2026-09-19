import { invoke } from "@tauri-apps/api/core";
import {
  formatWorkLog,
  getWorkLogSnapshot,
  loadWorkLogSnapshot,
  WORK_LOG_STORAGE_KEY,
  type WorkLogSnapshot,
} from "./work-log-store";

function renderOverlay(snapshot: WorkLogSnapshot): void {
  let overlay = document.querySelector<HTMLElement>("#work-log-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "work-log-overlay";
    overlay.innerHTML = `
      <div class="work-log-dialog" role="dialog" aria-label="기술 로그">
        <div class="work-log-dialog-header">
          <strong>기술 로그</strong>
          <span>다른 곳을 클릭하면 닫힙니다</span>
          <button type="button" class="work-log-dialog-close">닫기</button>
        </div>
        <pre class="work-log-dialog-body"></pre>
      </div>
    `;
    document.body.append(overlay);
    const panel = overlay;
    const hide = (): void => {
      panel.hidden = true;
    };
    panel.addEventListener("click", (event) => {
      if (event.target === panel) {
        hide();
      }
    });
    panel.querySelector(".work-log-dialog-close")?.addEventListener("click", hide);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        hide();
      }
    });
  }
  const body = overlay.querySelector<HTMLElement>(".work-log-dialog-body");
  if (body) {
    body.textContent = formatWorkLog(snapshot);
  }
  overlay.hidden = false;
}

export async function openWorkLogWindow(): Promise<void> {
  let snapshot = getWorkLogSnapshot();
  if (!snapshot.output && !snapshot.technical) {
    snapshot = loadWorkLogSnapshot();
  }
  try {
    localStorage.setItem(WORK_LOG_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore
  }
  void invoke("close_work_log").catch(() => undefined);
  void invoke("set_work_log", { snapshot }).catch(() => undefined);
  renderOverlay(snapshot);
}
