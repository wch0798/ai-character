import { logFrontendError } from "./system-client";

/** Errors nothing else caught go to the app log (keys are masked on the Rust side). */
let installed = false;
let sentThisMinute = 0;

function send(text: string): void {
  // A broken loop must not flood the log.
  if (sentThisMinute >= 20) return;
  sentThisMinute += 1;
  void logFrontendError(text).catch(() => undefined);
}

export function installErrorLogging(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.setInterval(() => {
    sentThisMinute = 0;
  }, 60_000);
  window.addEventListener("error", (event) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    send(`${event.message}${where}${event.error?.stack ? `\n${event.error.stack}` : ""}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    send(`처리되지 않은 오류: ${reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason)}`);
  });
}
