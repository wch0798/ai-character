import { listen } from "@tauri-apps/api/event";
import {
  UPDATE_NOTICE_EVENT,
  type UpdateNotice,
  type UpdateSettings,
  describeOutcome,
  getUpdateSettings,
  hasPendingAppUpdate,
  listUpdateHistory,
  needsRestart,
  restartToApplyUpdate,
  runUpdatesNow,
  setUpdateSettings,
  summarizeOutcomes,
} from "./update-client";
import { clampNumber, errorText, numberField, sectionShell, toggleRow, withBusy, type MakeButton } from "./settings-controls";

const NOTICE_VISIBLE_MS = 12_000;

export function formatHistoryTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const UPDATE_CATEGORIES: Array<{ key: keyof Omit<UpdateSettings, "intervalHours">; label: string; help: string }> = [
  {
    key: "app",
    label: "앱",
    help: "소스 실행: 새 버전을 임시 폴더에서 테스트한 뒤 반영. 설치본: 서명된 GitHub 릴리스만 설치.",
  },
  { key: "clis", label: "CLI (Claude · Codex · Gemini · Cursor · Antigravity)", help: "설치된 것만 업데이트하고, 실패하면 이전 버전으로 되돌립니다." },
  { key: "plugins", label: "Claude 플러그인 · 스킬", help: "마켓 목록을 갱신하고 설치된 플러그인을 업데이트합니다." },
  { key: "models", label: "무료 모델 목록", help: "OpenRouter·Gemini 무료 모델 목록을 하루에 한 번 갱신합니다." },
];

export function showUpdateNotice(notice: UpdateNotice): void {
  if (notice.lines.length === 0) {
    return;
  }
  const toast = document.createElement("div");
  toast.className = "ai-update-notice";
  toast.setAttribute("role", "status");
  const title = document.createElement("strong");
  title.textContent = notice.title;
  const list = document.createElement("ul");
  for (const line of notice.lines.slice(0, 6)) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }
  if (notice.lines.length > 6) {
    const more = document.createElement("li");
    more.textContent = `외 ${notice.lines.length - 6}건`;
    list.append(more);
  }
  toast.append(title, list);
  toast.addEventListener("click", () => toast.remove());
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), NOTICE_VISIBLE_MS);
}

export function initializeUpdateNotices(): void {
  void listen<UpdateNotice>(UPDATE_NOTICE_EVENT, (event) => showUpdateNotice(event.payload)).catch(() => undefined);
}

export function createUpdateSection(
  makeButton: MakeButton,
  setMessage: (text: string) => void
): { section: HTMLElement; refresh: () => Promise<void> } {
  const { section } = sectionShell("자동 업데이트");
  section.title = "켜 둔 항목은 자동으로 설치하고 알려 줍니다. CRADLE 작업 중에는 미룹니다.";
  const inputs = new Map<string, HTMLInputElement>();
  for (const category of UPDATE_CATEGORIES) {
    const { root, input } = toggleRow(category.label, category.help);
    inputs.set(category.key, input);
    section.append(root);
  }
  const interval = numberField("확인 간격(시간)", { min: 1, max: 168 });

  const actions = document.createElement("div");
  actions.className = "ai-settings-ghost-row";
  const saveButton = makeButton("저장", "ai-settings-action");
  const runButton = makeButton("지금 업데이트", "ai-settings-ghost");
  const restartButton = makeButton("지금 재시작", "ai-settings-action");
  restartButton.title = "내려받은 새 버전을 적용하고 앱을 다시 시작합니다.";
  restartButton.hidden = true;
  actions.append(saveButton, runButton, restartButton);

  const historyFold = document.createElement("details");
  historyFold.className = "ai-settings-fold";
  const historySummary = document.createElement("summary");
  historySummary.textContent = "최근 이력";
  const history = document.createElement("ul");
  history.className = "ai-update-history";
  historyFold.append(historySummary, history);

  section.append(interval.root, actions, historyFold);

  const readSettings = (): UpdateSettings => ({
    app: inputs.get("app")?.checked ?? true,
    clis: inputs.get("clis")?.checked ?? true,
    plugins: inputs.get("plugins")?.checked ?? true,
    models: inputs.get("models")?.checked ?? true,
    intervalHours: clampNumber(interval.input.value, 1, 168, 6),
  });

  const render = (value: UpdateSettings): void => {
    for (const category of UPDATE_CATEGORIES) {
      const input = inputs.get(category.key);
      if (input) {
        input.checked = value[category.key];
      }
    }
    interval.input.value = String(value.intervalHours);
  };

  const historyItem = (text: string, detail?: string | null): HTMLLIElement => {
    const item = document.createElement("li");
    item.textContent = text;
    if (detail) {
      item.title = detail;
    }
    return item;
  };

  const renderHistory = async (): Promise<void> => {
    try {
      const records = await listUpdateHistory(10);
      history.replaceChildren(
        ...(records.length === 0
          ? [historyItem("아직 기록이 없습니다.")]
          : records.map((record) =>
              historyItem(
                `${formatHistoryTime(record.createdAt)} · ${describeOutcome(
                  record as Parameters<typeof describeOutcome>[0]
                )}`,
                record.message
              )
            ))
      );
    } catch (error) {
      history.replaceChildren(historyItem(`이력 조회 실패: ${errorText(error)}`));
    }
  };

  const refreshRestart = async (): Promise<void> => {
    restartButton.hidden = !(await hasPendingAppUpdate().catch(() => false));
  };

  const refresh = async (): Promise<void> => {
    render(await getUpdateSettings());
    await Promise.all([renderHistory(), refreshRestart()]);
  };

  saveButton.addEventListener("click", () => {
    void withBusy([saveButton], async () => {
      try {
        render(await setUpdateSettings(readSettings()));
        setMessage("자동 업데이트 설정을 저장했습니다.");
      } catch (error) {
        setMessage(`자동 업데이트 설정 저장 실패: ${errorText(error)}`);
      }
    });
  });

  runButton.addEventListener("click", () => {
    void withBusy([runButton], async () => {
      runButton.textContent = "업데이트 중…";
      setMessage("업데이트를 확인하고 설치하는 중… 몇 분 걸릴 수 있습니다.");
      try {
        const settings = readSettings();
        const categories = UPDATE_CATEGORIES.filter((category) => settings[category.key]).map((category) => category.key);
        const outcomes = await runUpdatesNow(categories);
        setMessage(summarizeOutcomes(outcomes));
        if (needsRestart(outcomes)) {
          restartButton.hidden = false;
        }
        await Promise.all([renderHistory(), refreshRestart()]);
      } catch (error) {
        setMessage(`업데이트 실패: ${errorText(error)}`);
      } finally {
        runButton.textContent = "지금 업데이트";
      }
    });
  });

  restartButton.addEventListener("click", () => {
    void withBusy([restartButton], async () => {
      setMessage("새 버전을 적용하고 다시 시작합니다…");
      try {
        await restartToApplyUpdate();
      } catch (error) {
        setMessage(`재시작 실패: ${errorText(error)}`);
      }
    });
  });

  return { section, refresh };
}
