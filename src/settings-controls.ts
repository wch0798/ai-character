export type MakeButton = (label: string, className?: string) => HTMLButtonElement;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sectionShell(titleText: string): { section: HTMLElement; title: HTMLHeadingElement } {
  const section = document.createElement("section");
  section.className = "ai-settings-section";
  const title = document.createElement("h3");
  title.textContent = titleText;
  section.append(title);
  return { section, title };
}

/** A one-line toggle; the longer explanation lives in the tooltip to keep the panel compact. */
export function toggleRow(label: string, tooltip?: string): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = document.createElement("label");
  root.className = "ai-settings-checkbox";
  if (tooltip) {
    root.title = tooltip;
  }
  const input = document.createElement("input");
  input.type = "checkbox";
  const text = document.createElement("span");
  text.textContent = label;
  root.append(input, text);
  return { root, input };
}

export function numberField(
  label: string,
  options: { min: number; max: number; step?: number; tooltip?: string }
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = document.createElement("label");
  root.className = "ai-settings-field ai-settings-inline-field";
  if (options.tooltip) {
    root.title = options.tooltip;
  }
  const text = document.createElement("span");
  text.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.className = "ai-settings-number ai-settings-number-small";
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step ?? 1);
  root.append(text, input);
  return { root, input };
}

/** Backend settings are integers (Rust u64), so fractions are rounded before saving. */
export function clampNumber(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Disables the buttons while `task` runs so a slow command is never started twice. */
export async function withBusy<T>(buttons: HTMLButtonElement[], task: () => Promise<T>): Promise<T> {
  for (const button of buttons) {
    button.disabled = true;
  }
  try {
    return await task();
  } finally {
    for (const button of buttons) {
      button.disabled = false;
    }
  }
}

/**
 * Two-step confirmation without a native dialog (those freeze always-on-top windows on Windows):
 * the first click relabels the button, a second click within a few seconds runs `action`.
 */
export function confirmOnSecondClick(
  button: HTMLButtonElement,
  confirmLabel: string,
  action: () => void,
  timeoutMs = 4000
): void {
  const original = button.textContent ?? "";
  let timer: number | undefined;
  button.addEventListener("click", () => {
    if (timer === undefined) {
      button.textContent = confirmLabel;
      button.dataset.armed = "true";
      timer = window.setTimeout(() => {
        timer = undefined;
        button.textContent = original;
        delete button.dataset.armed;
      }, timeoutMs);
      return;
    }
    window.clearTimeout(timer);
    timer = undefined;
    button.textContent = original;
    delete button.dataset.armed;
    action();
  });
}
