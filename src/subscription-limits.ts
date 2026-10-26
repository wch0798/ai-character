import { readJson, writeJson } from "./local-store";

/**
 * Subscribed programs (Claude, ChatGPT/Codex) that hit their usage limit. While a program is
 * over its limit it is skipped and the other program or a free AI answers; once its reset time
 * passes it is used first again. A program that is still limited is simply marked again, so
 * the switch back and forth repeats on its own.
 */
const LIMITS_KEY = "ai-character-subscription-limits";

/** When the message gives no reset time: try the program again after this long. */
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const MIN_WAIT_MS = 60_000;
const MAX_WAIT_MS = 7 * 24 * 60 * 60_000;

const LIMIT_MARKERS = [
  "usage limit",
  "limit reached",
  "hit your limit",
  "rate limit",
  "quota exceeded",
  "credits exhausted",
  "out of credits",
  "plan limit",
  "too many requests",
  "5-hour limit",
  "weekly limit",
  "사용량 초과",
  "사용량을 다",
  "한도 초과",
  "한도에 걸렸",
];

export function isUsageLimitMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return LIMIT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * When the limit lifts, read from the program's message ("|1792999999", "try again in 2 hours
 * 5 minutes", "resets 7pm", "3시간 후"); otherwise DEFAULT_COOLDOWN_MS from now.
 */
export function limitResetAt(message: string, now = Date.now()): number {
  const clamp = (at: number) => Math.min(now + MAX_WAIT_MS, Math.max(now + MIN_WAIT_MS, at));

  const epoch = message.match(/\|(\d{10})\b/);
  if (epoch) return clamp(Number(epoch[1]) * 1000);

  const relative = message.match(/(?:try again|retry|resets?)\s+in\s+(?:(\d+)\s*(?:hours?|hrs?|h)\b)?\s*(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/i);
  if (relative && (relative[1] || relative[2])) {
    return clamp(now + (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60_000);
  }

  const korean = message.match(/(?:(\d+)\s*시간)?\s*(?:(\d+)\s*분)?\s*(?:후|뒤)/);
  if (korean && (korean[1] || korean[2])) {
    return clamp(now + (Number(korean[1] ?? 0) * 60 + Number(korean[2] ?? 0)) * 60_000);
  }

  const clock = message.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3].toLowerCase() === "pm") hour += 12;
    const at = new Date(now);
    at.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return clamp(at.getTime());
  }

  return now + DEFAULT_COOLDOWN_MS;
}

type Limits = Record<string, number>;

function readLimits(now: number): Limits {
  const stored = readJson<unknown>(LIMITS_KEY, null);
  const limits: Limits = {};
  if (stored && typeof stored === "object") {
    for (const [agent, until] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof until === "number" && until > now) limits[agent] = until;
    }
  }
  return limits;
}

/** Remembers that `agent` is over its limit, if `message` says so. Returns the reset time. */
export function noteRunFailure(agent: string, message: string, now = Date.now()): number | null {
  if (!isUsageLimitMessage(message)) return null;
  const until = limitResetAt(message, now);
  writeJson(LIMITS_KEY, { ...readLimits(now), [agent]: until });
  return until;
}

/** A finished run means the limit has lifted. */
export function noteRunSuccess(agent: string, now = Date.now()): void {
  const limits = readLimits(now);
  if (agent in limits) {
    delete limits[agent];
    writeJson(LIMITS_KEY, limits);
  }
}

/** When `agent` may be used again, or null when it is usable now. */
export function limitedUntil(agent: string, now = Date.now()): number | null {
  return readLimits(now)[agent] ?? null;
}

/** "오후 5:30" (today) or "10월 27일 오전 9:00". */
export function formatResumeTime(until: number, now = Date.now()): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString()
    ? time
    : `${at.getMonth() + 1}월 ${at.getDate()}일 ${time}`;
}
