export type WorkerResultEnvelope = {
  summary: string;
  findings: string[];
  sources: string[];
  nextAction: string | null;
};

export const WORKER_RESULT_SCHEMA =
  '{"summary":"one-paragraph result","findings":["key point"],"sources":["url or file"],"nextAction":null}';

export function compactText(value: string, maxChars: number): string {
  const clean = value.trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

function cleanJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length >= 3 && lines[lines.length - 1].trim() === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }
  return trimmed;
}

function asStringArray(value: unknown, maxItems: number, maxItemChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, maxItems)
    .map((item) => compactText(item, maxItemChars));
}

export function parseWorkerResultEnvelope(raw: string): WorkerResultEnvelope | null {
  try {
    const value = JSON.parse(cleanJsonText(raw)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    if (!summary) return null;
    return {
      summary: compactText(summary, 600),
      findings: asStringArray(record.findings, 8, 200),
      sources: asStringArray(record.sources, 6, 200),
      nextAction:
        typeof record.nextAction === "string" && record.nextAction.trim()
          ? compactText(record.nextAction, 200)
          : null,
    };
  } catch {
    return null;
  }
}

export function compactWorkerOutput(
  raw: string,
  mode: "analyze" | "modify" = "analyze",
  maxChars = 1_600
): string {
  if (mode === "modify") {
    return compactText(raw, 8_000);
  }
  const parsed = parseWorkerResultEnvelope(raw);
  if (parsed) {
    return JSON.stringify(parsed);
  }
  return JSON.stringify({
    summary: compactText(raw, maxChars),
    findings: [],
    sources: [],
    nextAction: null,
  } satisfies WorkerResultEnvelope);
}
