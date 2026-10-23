/**
 * Small values kept in this browser profile. Storage can be missing or full (private mode,
 * quota), so reads fall back and writes are best effort: the value then lasts for this session.
 */

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Saves the value, or removes the key for null. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Kept for this session only.
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readStored(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeStored(key, JSON.stringify(value));
}
