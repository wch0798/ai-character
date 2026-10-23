import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  applyProfile,
  currentProfile,
  loadProfiles,
  removeProfile,
  storeProfiles,
  upsertProfile,
} from "./character-profiles";
import { stamp } from "./chat-backup";
import { errorText, help, sectionShell, type MakeButton } from "./settings-controls";

/**
 * Settings sections for the user's own data: back up and restore settings, wipe everything
 * the app keeps on this PC, and saved character profiles.
 */
function section(title: string, ...nodes: Node[]): HTMLElement {
  const { section: box } = sectionShell(title);
  box.append(...nodes);
  return box;
}

function row(...buttons: HTMLElement[]): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "ai-settings-ghost-row";
  node.append(...buttons);
  return node;
}

/** 설정 백업 · 모든 데이터 지우기, for the 고급 tab. */
export function createDataToolsSection(makeButton: MakeButton, setMessage: (text: string) => void): HTMLElement {
  const backup = makeButton("설정 백업 저장", "ai-settings-action");
  backup.addEventListener("click", async () => {
    backup.disabled = true;
    try {
      const path = await save({
        defaultPath: `ai-character-settings-${stamp()}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      // The backend returns the backup as an object (the same one the setup page exports).
      const backupData = await invoke<unknown>("export_settings_backup");
      await invoke("write_text_file", { path, contents: JSON.stringify(backupData, null, 2) });
      setMessage(`설정을 저장했습니다: ${path} (키는 들어 있지 않습니다)`);
    } catch (error) {
      setMessage(`설정을 저장하지 못했습니다: ${errorText(error)}`);
    } finally {
      backup.disabled = false;
    }
  });

  const restore = makeButton("설정 불러오기", "ai-settings-ghost");
  restore.addEventListener("click", async () => {
    restore.disabled = true;
    try {
      const selected = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      const json = await invoke<string>("read_text_file", { path });
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new Error("설정 백업 파일이 아닙니다 (내용을 읽을 수 없습니다).");
      }
      const result = await invoke<{ applied: string[]; warning: string | null }>("import_settings_backup", { backup: parsed });
      setMessage(
        [`불러왔습니다: ${result.applied.join(", ") || "바뀐 항목 없음"}.`, result.warning ?? ""].filter(Boolean).join(" ")
      );
    } catch (error) {
      setMessage(`설정을 불러오지 못했습니다: ${errorText(error)}`);
    } finally {
      restore.disabled = false;
    }
  });

  const wipe = makeButton("모든 데이터 지우기", "ai-settings-ghost");
  wipe.addEventListener("click", async () => {
    const first = window.confirm(
      "이 PC에서 AI Character가 저장한 것을 모두 지웁니다.\n\n" +
        "지워지는 것: 저장한 키, 설정, 대화 기록, 사용량 기록, 로그, 캐릭터 프로필\n" +
        "지워지지 않는 것: 작업 폴더(프로젝트) 안의 파일, 각 AI 프로그램의 로그인\n\n계속할까요?"
    );
    if (!first || !window.confirm("정말 지울까요? 되돌릴 수 없습니다.")) {
      return;
    }
    wipe.disabled = true;
    try {
      const result = await invoke<{ removed: string[]; failed: string[] }>("wipe_all_data");
      const summary = [
        result.removed.length ? `지웠습니다: ${result.removed.join(", ")}.` : "",
        result.failed.length ? `지우지 못한 것: ${result.failed.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
      try {
        localStorage.clear();
      } catch {
        // Nothing more to clear.
      }
      setMessage(`${summary} 앱을 처음 상태로 다시 엽니다…`);
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      wipe.disabled = false;
      setMessage(`데이터를 지우지 못했습니다: ${errorText(error)}`);
    }
  });

  return section(
    "내 데이터",
    help("설정을 파일로 저장해 두면 다른 PC나 다시 설치한 뒤에 그대로 불러올 수 있습니다. 키(비밀번호 같은 값)는 백업 파일에 넣지 않습니다."),
    row(backup, restore),
    help("PC를 다른 사람에게 넘기거나 처음부터 다시 시작하려면 모든 데이터를 지우세요. 작업 폴더 안의 파일은 지우지 않습니다."),
    row(wipe)
  );
}

/** 캐릭터 프로필: the current character and its tone saved under a name, for the 캐릭터 tab. */
export function createCharacterProfilesSection(makeButton: MakeButton, setMessage: (text: string) => void): HTMLElement {
  const nameInput = document.createElement("input");
  nameInput.className = "ai-settings-text";
  nameInput.maxLength = 30;
  nameInput.placeholder = "프로필 이름 (예: 업무용, 주말용)";
  const saveButton = makeButton("지금 캐릭터 저장", "ai-settings-action");
  const list = document.createElement("div");
  list.className = "ai-web-accounts-list";

  const render = () => {
    list.replaceChildren();
    const profiles = loadProfiles();
    if (!profiles.length) {
      list.append(help("저장한 프로필이 없습니다. 캐릭터와 말투를 고른 뒤 이름을 정해 저장하세요."));
      return;
    }
    for (const profile of profiles) {
      const item = document.createElement("div");
      item.className = "ai-web-account-row";
      const meta = document.createElement("div");
      meta.className = "ai-web-account-meta";
      const title = document.createElement("strong");
      title.textContent = profile.name;
      const detail = document.createElement("small");
      detail.className = "ai-settings-help";
      detail.textContent = [profile.modelName || "캐릭터", profile.persona ? `말투: ${profile.persona.slice(0, 40)}${profile.persona.length > 40 ? "…" : ""}` : "기본 말투"].join(" · ");
      meta.append(title, detail);
      const apply = makeButton("적용", "ai-settings-action");
      apply.addEventListener("click", () => {
        applyProfile(profile);
        setMessage(`'${profile.name}' 프로필로 바꿉니다…`);
        // The model is chosen at start-up, the same way the character menu switches it.
        window.setTimeout(() => window.location.reload(), 300);
      });
      const remove = makeButton("삭제", "ai-settings-ghost");
      remove.addEventListener("click", () => {
        if (!window.confirm(`'${profile.name}' 프로필을 지울까요?`)) return;
        storeProfiles(removeProfile(loadProfiles(), profile.name));
        render();
      });
      const actions = document.createElement("div");
      actions.className = "ai-web-account-actions";
      actions.append(apply, remove);
      item.append(meta, actions);
      list.append(item);
    }
  };

  saveButton.addEventListener("click", () => {
    try {
      storeProfiles(upsertProfile(loadProfiles(), currentProfile(nameInput.value)));
      setMessage(`'${nameInput.value.trim()}' 프로필을 저장했습니다.`);
      nameInput.value = "";
      render();
    } catch (error) {
      setMessage(errorText(error));
    }
  });

  render();
  const form = document.createElement("div");
  form.className = "ai-settings-ghost-row";
  form.append(nameInput, saveButton);
  return section(
    "캐릭터 프로필",
    help("지금 캐릭터 모습과 말투를 이름을 붙여 저장해 두고, 버튼 하나로 바꿔 쓸 수 있습니다 (최대 10개)."),
    form,
    list
  );
}
