import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  FONT_SCALE_KEY,
  readFontScale,
  readTheme,
  setFontScale,
  setTheme,
  type FontScaleChoice,
  type ThemeChoice,
} from "./appearance";
import { installErrorLogging } from "./diagnostics";
import {
  getAutostart,
  getDiagnostics,
  getToggleShortcut,
  openLogFolder,
  setAutostart,
  setToggleShortcut,
} from "./system-client";
import { PERSONA_KEY, PERSONA_LIMIT, readPersona } from "./persona";

export const PERSONA_EVENT = "ai-character:persona-changed";

export const PERSONA_PRESETS: Array<{ label: string; text: string }> = [
  { label: "친절한 비서", text: "친절하고 차분한 비서처럼 존댓말로 답합니다. 어려운 말은 쉽게 풀어서 설명합니다." },
  { label: "친구처럼 반말", text: "오래된 친구처럼 편한 반말로 답합니다. 짧고 다정하게, 가끔 가벼운 농담도 합니다." },
  { label: "간결하게", text: "인사말이나 군더더기 없이 핵심만 짧게 답합니다. 필요하면 목록으로 정리합니다." },
];

function savePersona(text: string): void {
  const clean = text.trim().slice(0, PERSONA_LIMIT);
  try {
    if (clean) localStorage.setItem(PERSONA_KEY, clean);
    else localStorage.removeItem(PERSONA_KEY);
  } catch {
    // Kept for this session only.
  }
  window.dispatchEvent(new Event(PERSONA_EVENT));
}

/** "ctrl+shift+KeyK" style text from a key press, or null while only modifiers are held. */
export function shortcutFromKey(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code">): string | null {
  if (!event.code || /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(event.code)) return null;
  const parts = [event.ctrlKey && "ctrl", event.altKey && "alt", event.shiftKey && "shift", event.metaKey && "super"].filter(Boolean);
  return [...parts, event.code.toLowerCase()].join("+");
}

/** "ctrl+shift+keyk" → "Ctrl + Shift + K" for display. */
export function displayShortcut(text: string): string {
  return text
    .split("+")
    .map((part) => {
      const key = part.replace(/^key(?=[a-z]$)/, "").replace(/^digit(?=\d$)/, "");
      if (key === "ctrl") return "Ctrl";
      if (key === "super") return "Win";
      return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
    })
    .join(" + ");
}

type MakeButton = (label: string, className?: string) => HTMLButtonElement;

function heading(text: string): HTMLHeadingElement {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}

function help(text: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "ai-settings-help";
  div.textContent = text;
  return div;
}

function choiceRow<T extends string>(label: string, options: Array<[T, string]>, current: T, onPick: (value: T) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "ai-settings-choice-row";
  const name = document.createElement("span");
  name.className = "ai-settings-choice-label";
  name.textContent = label;
  const group = document.createElement("div");
  group.className = "ai-settings-segmented";
  group.setAttribute("role", "radiogroup");
  const buttons = options.map(([value, text]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.setAttribute("role", "radio");
    button.addEventListener("click", () => {
      for (const other of buttons) other.setAttribute("aria-checked", String(other === button));
      onPick(value);
    });
    button.setAttribute("aria-checked", String(value === current));
    return button;
  });
  group.append(...buttons);
  row.append(name, group);
  return row;
}

export type AppPreferencesSections = {
  /** 화면 (테마·글자 크기) and 캐릭터 말투, for the 기본 tab. */
  screen: HTMLElement;
  persona: HTMLElement;
  /** Windows 시작·단축키 and 진단, for the 고급 tab. */
  system: HTMLElement;
  diagnostics: HTMLElement;
  refresh(): Promise<void>;
};

export function createAppPreferencesSections(makeButton: MakeButton, setMessage: (text: string) => void): AppPreferencesSections {
  installErrorLogging();
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // ----- 화면 -----
  const screen = document.createElement("section");
  screen.className = "ai-settings-section";
  screen.append(
    heading("화면"),
    choiceRow<ThemeChoice>("테마", [["system", "Windows 따라가기"], ["light", "밝게"], ["dark", "어둡게"]], readTheme(), setTheme),
    choiceRow<FontScaleChoice>(
      "글자 크기",
      [["small", "작게"], ["normal", "보통"], ["large", "크게"], ["xlarge", "아주 크게"]],
      readFontScale(),
      (value) => {
        setFontScale(value);
        window.dispatchEvent(new CustomEvent("ai-character:appearance-changed", { detail: { key: FONT_SCALE_KEY } }));
      }
    ),
    help("바꾸면 바로 적용되고 저장됩니다.")
  );

  // ----- 캐릭터 말투 -----
  const persona = document.createElement("section");
  persona.className = "ai-settings-section";
  const personaInput = document.createElement("textarea");
  personaInput.className = "ai-settings-textarea";
  personaInput.rows = 3;
  personaInput.maxLength = PERSONA_LIMIT;
  personaInput.placeholder = "예: 다정한 친구처럼 반말로, 짧게 답해 줘.";
  personaInput.value = readPersona();
  const counter = document.createElement("small");
  counter.className = "ai-settings-help";
  const paintCounter = () => {
    counter.textContent = `${personaInput.value.length} / ${PERSONA_LIMIT}자 · 비워 두면 기본 말투로 답합니다.`;
  };
  paintCounter();
  let saveTimer = 0;
  personaInput.addEventListener("input", () => {
    paintCounter();
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => savePersona(personaInput.value), 500);
  });
  const presets = document.createElement("div");
  presets.className = "ai-settings-ghost-row";
  for (const preset of PERSONA_PRESETS) {
    const button = makeButton(preset.label, "ai-settings-ghost");
    button.addEventListener("click", () => {
      personaInput.value = preset.text;
      paintCounter();
      savePersona(preset.text);
      setMessage(`캐릭터 말투를 ‘${preset.label}’(으)로 바꿨습니다.`);
    });
    presets.append(button);
  }
  const clearPersona = makeButton("기본 말투로", "ai-settings-ghost");
  clearPersona.addEventListener("click", () => {
    personaInput.value = "";
    paintCounter();
    savePersona("");
    setMessage("캐릭터 말투를 기본으로 되돌렸습니다.");
  });
  presets.append(clearPersona);
  persona.append(
    heading("캐릭터 성격·말투"),
    help("캐릭터가 어떤 성격과 말투로 답할지 적어 주세요. 사실과 작업 내용은 그대로이고 말투만 바뀝니다."),
    presets,
    personaInput,
    counter
  );

  // ----- Windows 시작·단축키 -----
  const system = document.createElement("section");
  system.className = "ai-settings-section";
  const autostartLabel = document.createElement("label");
  autostartLabel.className = "ai-settings-checkbox";
  const autostartBox = document.createElement("input");
  autostartBox.type = "checkbox";
  const autostartCopy = document.createElement("span");
  autostartCopy.className = "ai-settings-checkbox-copy";
  const autostartText = document.createElement("span");
  autostartText.textContent = "Windows를 켜면 자동으로 실행";
  const autostartHelp = document.createElement("small");
  autostartHelp.className = "ai-settings-help";
  autostartHelp.textContent = "PC를 켤 때 캐릭터가 바로 나타납니다.";
  autostartCopy.append(autostartText, autostartHelp);
  autostartLabel.append(autostartBox, autostartCopy);
  autostartBox.addEventListener("change", () => {
    const wanted = autostartBox.checked;
    autostartBox.disabled = true;
    void setAutostart(wanted)
      .then((now) => {
        autostartBox.checked = now;
        setMessage(now ? "Windows를 켤 때 자동으로 실행합니다." : "자동 실행을 껐습니다.");
      })
      .catch((error) => {
        autostartBox.checked = !wanted;
        setMessage(errorText(error));
      })
      .finally(() => {
        autostartBox.disabled = false;
      });
  });

  const shortcutRow = document.createElement("div");
  shortcutRow.className = "ai-settings-choice-row";
  const shortcutName = document.createElement("span");
  shortcutName.className = "ai-settings-choice-label";
  shortcutName.textContent = "숨기기·보이기 단축키";
  const shortcutField = document.createElement("input");
  shortcutField.className = "ai-settings-shortcut";
  shortcutField.readOnly = true;
  shortcutField.value = "확인 중…";
  shortcutField.title = "누른 뒤 원하는 키 조합을 누르세요";
  let currentShortcut = "";
  const showShortcut = (text: string) => {
    currentShortcut = text;
    shortcutField.value = displayShortcut(text);
  };
  shortcutField.addEventListener("focus", () => {
    shortcutField.value = "키 조합을 누르세요…";
  });
  shortcutField.addEventListener("blur", () => showShortcut(currentShortcut));
  shortcutField.addEventListener("keydown", (event) => {
    event.preventDefault();
    if (event.key === "Escape") {
      shortcutField.blur();
      return;
    }
    const combo = shortcutFromKey(event);
    if (!combo) return;
    void setToggleShortcut(combo)
      .then((saved) => {
        showShortcut(saved);
        setMessage(`이제 ${displayShortcut(saved)}(으)로 캐릭터를 숨기고 다시 부릅니다.`);
        shortcutField.blur();
      })
      .catch((error) => {
        setMessage(errorText(error));
        shortcutField.value = "키 조합을 누르세요…";
      });
  });
  const resetShortcut = makeButton("기본값으로", "ai-settings-ghost");
  resetShortcut.addEventListener("click", () => {
    void setToggleShortcut(null)
      .then((saved) => {
        showShortcut(saved);
        setMessage(`단축키를 기본값 ${displayShortcut(saved)}(으)로 되돌렸습니다.`);
      })
      .catch((error) => setMessage(errorText(error)));
  });
  shortcutRow.append(shortcutName, shortcutField, resetShortcut);
  system.append(
    heading("시작·단축키"),
    autostartLabel,
    shortcutRow,
    help("단축키는 Ctrl·Alt·Shift 중 하나 이상과 다른 키를 함께 눌러 정합니다. 다른 프로그램이 쓰는 조합이면 알려 드립니다.")
  );

  // ----- 진단 -----
  const diagnostics = document.createElement("section");
  diagnostics.className = "ai-settings-section";
  const copyDiagnostics = makeButton("진단 정보 복사", "ai-settings-action");
  copyDiagnostics.addEventListener("click", () => {
    copyDiagnostics.disabled = true;
    void getDiagnostics()
      .then((text) => writeText(text))
      .then(() => setMessage("진단 정보를 복사했습니다. 도움을 요청할 때 붙여 넣으세요. 키는 들어 있지 않습니다."))
      .catch((error) => setMessage(`진단 정보를 복사하지 못했습니다: ${errorText(error)}`))
      .finally(() => {
        copyDiagnostics.disabled = false;
      });
  });
  const openLogs = makeButton("로그 폴더 열기", "ai-settings-ghost");
  openLogs.addEventListener("click", () => {
    void openLogFolder()
      .then((path) => setMessage(`로그 폴더를 열었습니다: ${path}`))
      .catch((error) => setMessage(errorText(error)));
  });
  const diagnosticsActions = document.createElement("div");
  diagnosticsActions.className = "ai-settings-ghost-row";
  diagnosticsActions.append(copyDiagnostics, openLogs);
  diagnostics.append(
    heading("문제 해결"),
    help("문제가 생기면 ‘진단 정보 복사’를 눌러 도움을 요청할 때 붙여 넣으세요. 앱 버전, Windows 버전, 로그인 상태, 최근 오류 기록이 들어가고 키와 비밀번호는 빠집니다."),
    diagnosticsActions
  );

  return {
    screen,
    persona,
    system,
    diagnostics,
    async refresh() {
      const [autostart, shortcut] = await Promise.all([
        getAutostart().catch(() => false),
        getToggleShortcut().catch(() => "ctrl+shift+space"),
      ]);
      autostartBox.checked = autostart;
      if (document.activeElement !== shortcutField) showShortcut(shortcut);
    },
  };
}
