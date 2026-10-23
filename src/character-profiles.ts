import { PERSONA_KEY } from "./persona";

/** A saved character: which Live2D model to show and how it talks. */
export type CharacterProfile = {
  name: string;
  model: string;
  modelName: string;
  persona: string;
  savedAt: number;
};

export const PROFILES_KEY = "ai-character-profiles";
export const MODEL_KEY = "selected-live2d-model";
export const MODEL_NAME_KEY = "selected-live2d-name";
export const MAX_PROFILES = 10;
const MAX_NAME = 30;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isProfile(value: unknown): value is CharacterProfile {
  const item = value as Partial<CharacterProfile> | null;
  return Boolean(item) && typeof item?.name === "string" && typeof item?.model === "string";
}

export function parseProfiles(raw: string | null): CharacterProfile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isProfile).map((item) => ({
          name: item.name,
          model: item.model,
          modelName: typeof item.modelName === "string" ? item.modelName : "",
          persona: typeof item.persona === "string" ? item.persona : "",
          savedAt: typeof item.savedAt === "number" ? item.savedAt : 0,
        }))
      : [];
  } catch {
    return [];
  }
}

/**
 * Adds a profile, replacing one with the same name (it moves to the front). Refuses an empty
 * name and a full list, so nothing is dropped without the user knowing.
 */
export function upsertProfile(profiles: CharacterProfile[], profile: CharacterProfile): CharacterProfile[] {
  const name = profile.name.trim().slice(0, MAX_NAME);
  if (!name) {
    throw new Error("프로필 이름을 입력해 주세요.");
  }
  if (!profile.model) {
    throw new Error("저장할 캐릭터가 없습니다. 캐릭터를 먼저 고른 뒤 저장해 주세요.");
  }
  const others = profiles.filter((item) => item.name !== name);
  if (others.length >= MAX_PROFILES) {
    throw new Error(`프로필은 ${MAX_PROFILES}개까지 저장할 수 있습니다. 쓰지 않는 프로필을 지운 뒤 다시 저장해 주세요.`);
  }
  return [{ ...profile, name }, ...others];
}

export function removeProfile(profiles: CharacterProfile[], name: string): CharacterProfile[] {
  return profiles.filter((item) => item.name !== name);
}

export function loadProfiles(storage: StorageLike = localStorage): CharacterProfile[] {
  try {
    return parseProfiles(storage.getItem(PROFILES_KEY));
  } catch {
    return [];
  }
}

export function storeProfiles(profiles: CharacterProfile[], storage: StorageLike = localStorage): void {
  storage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

/** The character on screen right now, as a profile under `name`. */
export function currentProfile(name: string, storage: StorageLike = localStorage, now = Date.now()): CharacterProfile {
  return {
    name,
    model: storage.getItem(MODEL_KEY) ?? "",
    modelName: storage.getItem(MODEL_NAME_KEY) ?? "",
    persona: storage.getItem(PERSONA_KEY) ?? "",
    savedAt: now,
  };
}

/** Writes the profile's character and persona; the caller reloads to show the model. */
export function applyProfile(profile: CharacterProfile, storage: StorageLike = localStorage): void {
  storage.setItem(MODEL_KEY, profile.model);
  storage.setItem(MODEL_NAME_KEY, profile.modelName);
  if (profile.persona) {
    storage.setItem(PERSONA_KEY, profile.persona);
  } else {
    storage.removeItem(PERSONA_KEY);
  }
}
