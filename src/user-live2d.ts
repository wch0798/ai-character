import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

export type UserLive2DModel = {
  id: string;
  name: string;
  gender: string;
  source: string;
  model: string;
  folder: string;
  motions: Record<string, number>;
};

export type ImportOutcome =
  | { status: "ok"; model: UserLive2DModel }
  | {
      status: "conflict";
      existing: UserLive2DModel;
      proposedName: string;
      fingerprint: string;
    };

export type DedupeResult = {
  removed: string[];
  kept: number;
};

export const USER_LIVE2D_CHANGED_EVENT = "ai-character:user-live2d-changed";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function normalizeMotions(
  motions: Record<string, number> | undefined
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(motions ?? {}).map(([key, value]) => [
      key,
      typeof value === "number" ? value : Number(value) || 1,
    ])
  );
}

function normalizeModel(row: UserLive2DModel): UserLive2DModel {
  return { ...row, motions: normalizeMotions(row.motions) };
}

export function notifyUserLive2DChanged(): void {
  window.dispatchEvent(new CustomEvent(USER_LIVE2D_CHANGED_EVENT));
}

export async function listUserLive2DModels(): Promise<UserLive2DModel[]> {
  if (!isTauriRuntime()) return [];
  try {
    const rows = await invoke<UserLive2DModel[]>("list_user_live2d_models");
    return rows.map(normalizeModel);
  } catch {
    return [];
  }
}

async function importFromPath(
  path: string,
  mode?: "ask" | "skip" | "overwrite" | "copy"
): Promise<UserLive2DModel> {
  const outcome = await invoke<ImportOutcome>("import_user_live2d_model", {
    sourcePath: path,
    mode: mode ?? null,
  });

  if (outcome.status === "conflict") {
    const overwrite = window.confirm(
      `"${outcome.existing.name}" 모델이 이미 있습니다.\n\n확인: 덮어쓰기\n취소: 추가하지 않음`
    );
    if (!overwrite) {
      notifyUserLive2DChanged();
      return normalizeModel(outcome.existing);
    }
    return importFromPath(path, "overwrite");
  }

  notifyUserLive2DChanged();
  return normalizeModel(outcome.model);
}

export async function importUserLive2DModel(): Promise<UserLive2DModel> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "nizima/Booth 모델 폴더 선택 (.model3.json 포함)",
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) {
    throw new Error("선택이 취소되었습니다.");
  }
  return importFromPath(path);
}

export async function importUserLive2DZip(): Promise<UserLive2DModel> {
  const selected = await open({
    multiple: false,
    title: "Live2D 모델 ZIP/RAR 선택",
    filters: [{ name: "Archive", extensions: ["zip", "rar", "7z"] }],
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) {
    throw new Error("선택이 취소되었습니다.");
  }
  return importFromPath(path);
}

export async function removeUserLive2DModel(folder: string): Promise<void> {
  await invoke("remove_user_live2d_model", { folder });
  notifyUserLive2DChanged();
}

export async function dedupeUserLive2DModels(): Promise<DedupeResult> {
  const result = await invoke<DedupeResult>("dedupe_user_live2d_models");
  notifyUserLive2DChanged();
  return result;
}

export async function openUserLive2DDir(): Promise<void> {
  await invoke("open_user_live2d_dir");
}

export async function getUserLive2DDir(): Promise<string> {
  return invoke<string>("get_user_live2d_dir");
}

export async function openNizima(): Promise<void> {
  await openUrl("https://nizima.com/");
}

export async function openBoothLive2D(): Promise<void> {
  await openUrl("https://booth.pm/en/search/live2D?max_price=0");
}

/** Booth 무료(0엔) 원작 인기 모델 — 로그인 후 본인이 받아 'ZIP 업로드' 또는 '모델 폴더 추가' */
export const BOOTH_FREE_ORIGINAL_PICKS: Array<{
  id: string;
  name: string;
  url: string;
  note: string;
}> = [
  {
    id: "usahime",
    name: "兎姫 (우사히메)",
    url: "https://booth.pm/en/items/3072192",
    note: "yukinoa · 무료 원작",
  },
  {
    id: "witch",
    name: "魔女 (마녀)",
    url: "https://booth.pm/en/items/6499774",
    note: "SnowBear Project · 무료 배포",
  },
  {
    id: "ice-girl",
    name: "Ice Girl",
    url: "https://booth.pm/en/items/5975192",
    note: "TianYeLuLu · 완전 무료",
  },
  {
    id: "maid-cat",
    name: "Maid Cat Girl",
    url: "https://booth.pm/en/items/5047582",
    note: "comte19 · 무료 원작",
  },
  {
    id: "moose",
    name: "ムースちゃん (무스)",
    url: "https://booth.pm/en/items/4803854",
    note: "羽宮Project · 무료 범용",
  },
];

export async function openBoothFreePick(url: string): Promise<void> {
  await openUrl(url);
}
