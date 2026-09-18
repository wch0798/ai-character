const WAIT_STEP_MS = 40;

type TauriInternals = {
  invoke?: (...args: unknown[]) => unknown;
  metadata?: {
    currentWindow?: { label?: string };
  };
};

function internals(): TauriInternals | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
    .__TAURI_INTERNALS__;
}

export function isTauriRuntimeReady(): boolean {
  const inner = internals();
  return (
    typeof inner?.invoke === "function" &&
    typeof inner.metadata?.currentWindow?.label === "string" &&
    inner.metadata.currentWindow.label.length > 0
  );
}

/** HMR/재빌드 직후 invoke·window metadata가 붙기 전에 호출하지 않도록 기다립니다. */
export async function waitForTauri(timeoutMs = 8000): Promise<boolean> {
  if (isTauriRuntimeReady()) {
    return true;
  }
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => {
      window.setTimeout(resolve, WAIT_STEP_MS);
    });
    if (isTauriRuntimeReady()) {
      return true;
    }
  }
  return isTauriRuntimeReady();
}
