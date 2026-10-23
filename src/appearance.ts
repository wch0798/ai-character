/** Theme and chat font size, kept in this browser profile and applied as early as possible. */
import { readStored as read, writeStored as write } from "./local-store";

export type ThemeChoice = "system" | "light" | "dark";
export type FontScaleChoice = "small" | "normal" | "large" | "xlarge";

export const THEME_KEY = "ai-character-theme";
export const FONT_SCALE_KEY = "ai-character-font-scale";

export const FONT_SCALES: Record<FontScaleChoice, number> = {
  small: 0.9,
  normal: 1,
  large: 1.15,
  xlarge: 1.3,
};

export function readTheme(): ThemeChoice {
  const value = read(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function readFontScale(): FontScaleChoice {
  const value = read(FONT_SCALE_KEY);
  return value === "small" || value === "large" || value === "xlarge" ? value : "normal";
}

/** "system" follows Windows' light/dark setting. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): "light" | "dark" {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

const darkQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function applyAppearance(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(readTheme(), darkQuery?.matches ?? true);
  root.style.setProperty("--chat-font-scale", String(FONT_SCALES[readFontScale()]));
}

export function setTheme(choice: ThemeChoice): void {
  write(THEME_KEY, choice);
  applyAppearance();
}

export function setFontScale(choice: FontScaleChoice): void {
  write(FONT_SCALE_KEY, choice);
  applyAppearance();
}

darkQuery?.addEventListener?.("change", applyAppearance);
applyAppearance();
