import { invoke } from "@tauri-apps/api/core";
import { confirmOnSecondClick, errorText, sectionShell, withBusy, type MakeButton } from "./settings-controls";

export type ApiKeyStatus = {
  name: string;
  label: string;
  configured: boolean;
  /** A file path or "환경변수"; never the key value. */
  source: string | null;
  testable: boolean;
};

export function getApiKeyStatus(): Promise<ApiKeyStatus[]> {
  return invoke<ApiKeyStatus[]>("get_api_key_status");
}

export function saveApiKey(name: string, value: string): Promise<ApiKeyStatus[]> {
  return invoke<ApiKeyStatus[]>("save_api_key", { name, value });
}

export function testApiKey(name: string): Promise<string> {
  return invoke<string>("test_api_key", { name });
}

/** Explains why a key still counts as configured after the app removed it from its own file. */
export function describeRemoval(row: ApiKeyStatus | undefined, label: string): string {
  if (!row?.configured) {
    return `${label} 키를 지웠습니다.`;
  }
  return row.source === "환경변수"
    ? `${label} 키를 앱 파일에서 지웠지만 시스템 환경변수에 남아 있어 계속 사용됩니다.`
    : `${label} 키를 앱 파일에서 지웠지만 ${row.source ?? "다른 파일"}에 남아 있어 계속 사용됩니다.`;
}

export function createApiKeysSection(
  makeButton: MakeButton,
  setMessage: (text: string) => void,
  onChanged: () => void
): { section: HTMLElement; refresh: () => Promise<void> } {
  const { section, title } = sectionShell("API 키");
  title.title = "키는 이 컴퓨터의 앱 키 파일에만 저장되고 화면에 다시 표시하지 않습니다.";
  const list = document.createElement("div");
  list.className = "ai-api-key-list";
  section.append(list);

  const render = (rows: ApiKeyStatus[]): void => {
    list.replaceChildren(
      ...rows.map((row) => {
        const item = document.createElement("div");
        item.className = "ai-api-key-row";
        const dot = document.createElement("span");
        dot.className = "ai-api-key-dot";
        dot.dataset.state = row.configured ? "ok" : "missing";
        const label = document.createElement("span");
        label.className = "ai-api-key-label";
        label.textContent = row.label;
        if (row.source) {
          label.title = `사용 중인 위치: ${row.source}`;
        }
        const input = document.createElement("input");
        input.type = "password";
        input.className = "ai-settings-text";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.placeholder = row.configured ? "저장됨 · 바꾸려면 입력" : "키 붙여넣기";
        input.setAttribute("aria-label", `${row.label} 키`);
        const save = makeButton("저장", "ai-settings-action");
        const actions: HTMLElement[] = [save];
        if (row.configured && row.testable) {
          const test = makeButton("확인", "ai-settings-ghost");
          test.title = "요금이 들지 않는 조회로 키가 동작하는지 확인합니다.";
          test.addEventListener("click", () => {
            void withBusy([test], async () => {
              setMessage(`${row.label} 연결을 확인하는 중…`);
              try {
                setMessage(`${row.label}: ${await testApiKey(row.name)}`);
              } catch (error) {
                setMessage(`${row.label}: ${errorText(error)}`);
              }
            });
          });
          actions.push(test);
        }
        if (row.configured) {
          const remove = makeButton("삭제", "ai-settings-ghost");
          remove.title = "한 번 더 누르면 앱 키 파일에서 지웁니다.";
          confirmOnSecondClick(remove, "정말 삭제?", () => {
            void withBusy([save, remove], () => persist(row, ""));
          });
          actions.push(remove);
        }
        save.addEventListener("click", () => {
          const value = input.value.trim();
          if (!value) {
            setMessage("키를 입력하세요.");
            return;
          }
          void withBusy([save], async () => {
            if (await persist(row, value)) {
              input.value = "";
            }
          });
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !save.disabled) {
            save.click();
          }
        });
        const actionBox = document.createElement("div");
        actionBox.className = "ai-api-key-actions";
        actionBox.append(...actions);
        item.append(dot, label, input, actionBox);
        return item;
      })
    );
  };

  const persist = async (row: ApiKeyStatus, value: string): Promise<boolean> => {
    try {
      const rows = await saveApiKey(row.name, value);
      render(rows);
      setMessage(
        value
          ? `${row.label} 키를 저장했습니다.`
          : describeRemoval(rows.find((candidate) => candidate.name === row.name), row.label)
      );
      onChanged();
      return true;
    } catch (error) {
      setMessage(`키 저장 실패: ${errorText(error)}`);
      return false;
    }
  };

  const refresh = async (): Promise<void> => {
    render(await getApiKeyStatus());
  };

  return { section, refresh };
}
