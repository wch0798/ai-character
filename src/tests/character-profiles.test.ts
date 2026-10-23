import { describe, expect, it } from "vitest";
import {
  MAX_PROFILES,
  applyProfile,
  currentProfile,
  parseProfiles,
  removeProfile,
  upsertProfile,
  type CharacterProfile,
} from "../character-profiles";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

const profile = (name: string): CharacterProfile => ({ name, model: `/m/${name}.model3.json`, modelName: name, persona: "", savedAt: 1 });

describe("character profiles", () => {
  it("saves the current character and persona and puts them back", () => {
    const storage = memoryStorage({
      "selected-live2d-model": "/live2d/models/Hiyori/Hiyori.model3.json",
      "selected-live2d-name": "히요리",
      "ai-character-persona": "친구처럼 반말",
    });
    const saved = currentProfile("  주말용 ", storage, 5);
    const list = upsertProfile([], saved);
    expect(list[0].name).toBe("주말용");

    const other = memoryStorage({ "ai-character-persona": "old" });
    applyProfile(list[0], other);
    expect(other.data.get("selected-live2d-model")).toBe("/live2d/models/Hiyori/Hiyori.model3.json");
    expect(other.data.get("selected-live2d-name")).toBe("히요리");
    expect(other.data.get("ai-character-persona")).toBe("친구처럼 반말");
  });

  it("replaces a profile with the same name and refuses a full list or empty name", () => {
    let list = upsertProfile([profile("a")], { ...profile("a"), modelName: "새" });
    expect(list).toHaveLength(1);
    expect(list[0].modelName).toBe("새");
    expect(() => upsertProfile([], profile("  "))).toThrow();
    list = Array.from({ length: MAX_PROFILES }, (_, i) => profile(`p${i}`));
    expect(() => upsertProfile(list, profile("new"))).toThrow();
    expect(removeProfile(list, "p0")).toHaveLength(MAX_PROFILES - 1);
  });

  it("ignores broken saved data", () => {
    expect(parseProfiles("not json")).toEqual([]);
    expect(parseProfiles(JSON.stringify([{ name: 1 }, profile("ok")]))).toHaveLength(1);
  });
});
