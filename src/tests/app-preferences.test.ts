import { describe, expect, it } from "vitest";
import { displayShortcut, shortcutFromKey } from "../app-preferences-ui";
import { FONT_SCALES, resolveTheme } from "../appearance";

const key = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  code,
  ...mods,
});

describe("show/hide shortcut capture", () => {
  it("builds the combination from a key press", () => {
    expect(shortcutFromKey(key("KeyK", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+keyk");
    expect(shortcutFromKey(key("Space", { altKey: true }))).toBe("alt+space");
  });

  it("waits while only modifiers are held", () => {
    expect(shortcutFromKey(key("ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(shortcutFromKey(key("ShiftRight", { shiftKey: true }))).toBeNull();
  });

  it("shows it the way people write it", () => {
    expect(displayShortcut("ctrl+shift+space")).toBe("Ctrl + Shift + Space");
    expect(displayShortcut("ctrl+alt+keyk")).toBe("Ctrl + Alt + K");
    expect(displayShortcut("super+digit1")).toBe("Win + 1");
  });
});

describe("appearance", () => {
  it("follows Windows only when asked to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("keeps the normal size unchanged", () => {
    expect(FONT_SCALES.normal).toBe(1);
    expect(FONT_SCALES.small).toBeLessThan(1);
    expect(FONT_SCALES.xlarge).toBeGreaterThan(FONT_SCALES.large);
  });
});
