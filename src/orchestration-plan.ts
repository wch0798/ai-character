import type {
  OrchestrationPlan,
  OrchestrationTarget,
  OrchestrationTaskSpec,
  SynthesisEnvelope,
  TaskRole,
} from "./orchestration-types";

export const MAX_ORCHESTRATION_TASKS = 8;
const MAX_REVISION_TASKS = 4;
const MAX_TITLE_CHARS = 120;
const MAX_PROMPT_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 2_000;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

const TARGETS = new Set<OrchestrationTarget>([
  "claude_web",
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "chatgpt_web",
  "gemini_web",
  "gemini_api",
  "openrouter_api",
  "free_pool_api",
  "openai_api",
]);

const ROLES = new Set<TaskRole>(["planner", "coder", "reviewer", "tester", "documenter"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split(/\r?\n/);
    if (lines.length >= 3 && lines[lines.length - 1].trim() === "```") {
      return lines.slice(1, -1).join("\n").trim();
    }
  }
  return trimmed;
}

/**
 * Mends what models commonly get wrong in "JSON only" answers: prose around the object,
 * // or block comments, and trailing commas. String contents are left alone.
 */
export function repairJsonText(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const text = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 1;
    } else if (char === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] !== "}" && text[next] !== "]") out += char;
    } else {
      out += char;
    }
  }
  return out;
}

function parseJsonRecord(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  const cleaned = cleanJsonText(raw);
  try {
    value = JSON.parse(cleaned);
  } catch (error) {
    try {
      value = JSON.parse(repairJsonText(cleaned));
    } catch {
      throw new Error(`${label} JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const clean = value.trim();
  if (!clean) {
    throw new Error(`${label} must not be empty`);
  }
  if (clean.length > max) {
    throw new Error(`${label} exceeds ${max} characters`);
  }
  return clean;
}

/** A planner estimate in whole minutes (1–480), or undefined when missing or not a number. */
function estimateMinutes(value: unknown): number | undefined {
  const minutes = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(480, Math.max(1, Math.round(minutes))) : undefined;
}

function parseTask(raw: unknown, index: number): OrchestrationTaskSpec {
  if (!isRecord(raw)) {
    throw new Error(`task ${index + 1} must be an object`);
  }

  const id = boundedText(raw.id, `task ${index + 1} id`, 40);
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`task ${id} id contains unsupported characters`);
  }

  const target = raw.target;
  if (typeof target !== "string" || !TARGETS.has(target as OrchestrationTarget)) {
    throw new Error(`unsupported orchestration target: ${String(target)}`);
  }

  const mode = raw.mode ?? "analyze";
  if (mode !== "analyze" && mode !== "modify") {
    throw new Error(`task ${id} mode must be analyze or modify`);
  }

  const dependsOnRaw = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOnRaw)) {
    throw new Error(`task ${id} dependency list must be an array`);
  }
  const dependsOn = dependsOnRaw.map((value, dependencyIndex) => {
    const dep = boundedText(value, `task ${id} dependency ${dependencyIndex + 1}`, 40);
    if (!TASK_ID_PATTERN.test(dep)) {
      throw new Error(`task ${id} dependency id contains unsupported characters`);
    }
    return dep;
  });

  const role = raw.role ?? (mode === "modify" ? "coder" : "reviewer");
  if (typeof role !== "string" || !ROLES.has(role as TaskRole)) {
    throw new Error(`task ${id} role must be one of ${[...ROLES].join(", ")}`);
  }

  return {
    id,
    title: boundedText(raw.title, `task ${id} title`, MAX_TITLE_CHARS),
    target: target as OrchestrationTarget,
    prompt: boundedText(raw.prompt, `task ${id} prompt`, MAX_PROMPT_CHARS),
    dependsOn,
    mode: role === "coder" ? "modify" : role === "tester" || role === "planner" ? "analyze" : mode,
    role: role as TaskRole,
    estimateMinutes: estimateMinutes(raw.estimateMinutes),
  };
}

function validateTaskGraph(tasks: OrchestrationTaskSpec[]): void {
  const byId = new Map<string, OrchestrationTaskSpec>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      throw new Error(`duplicate orchestration task id: ${task.id}`);
    }
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`task ${task.id} dependency does not exist: ${dependency}`);
      }
      if (dependency === task.id) {
        throw new Error(`orchestration dependency cycle: ${task.id}`);
      }
    }
  }

  topologicalLayers(tasks);
}

function parseTaskList(raw: unknown, maxTasks: number, allowEmpty: boolean): OrchestrationTaskSpec[] {
  if (!Array.isArray(raw)) {
    throw new Error("tasks must be an array");
  }
  if ((!allowEmpty && raw.length === 0) || raw.length > maxTasks) {
    throw new Error(`tasks must contain ${allowEmpty ? "0" : "1"}-${maxTasks} items`);
  }
  const tasks = raw.map(parseTask);
  validateTaskGraph(tasks);
  return tasks;
}

export function parseOrchestrationPlan(raw: string): OrchestrationPlan {
  const value = parseJsonRecord(raw, "orchestration plan");
  const summary = boundedText(value.summary, "plan summary", MAX_SUMMARY_CHARS);
  const tasks = parseTaskList(value.tasks, MAX_ORCHESTRATION_TASKS, false);
  return { summary, tasks };
}

export function topologicalLayers(tasks: OrchestrationTaskSpec[]): OrchestrationTaskSpec[][] {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const remaining = new Set(tasks.map((task) => task.id));
  const completed = new Set<string>();
  const layers: OrchestrationTaskSpec[][] = [];

  while (remaining.size > 0) {
    const ready = tasks.filter(
      (task) =>
        remaining.has(task.id) &&
        task.dependsOn.every((dependency) => completed.has(dependency))
    );
    if (ready.length === 0) {
      const unresolved = [...remaining].join(", ");
      throw new Error(`orchestration dependency cycle detected: ${unresolved}`);
    }
    layers.push(ready);
    for (const task of ready) {
      remaining.delete(task.id);
      completed.add(task.id);
    }
  }

  // Keep this lookup so static/runtime validation catches accidental dependency
  // references when this helper is used independently from parseOrchestrationPlan.
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`task ${task.id} dependency does not exist: ${dependency}`);
      }
    }
  }

  return layers;
}

export function parseSynthesisEnvelope(raw: string): SynthesisEnvelope {
  const value = parseJsonRecord(raw, "synthesis result");
  const finalAnswer = boundedText(value.finalAnswer, "finalAnswer", 80_000);
  const revisionTasks = parseTaskList(value.revisionTasks ?? [], MAX_REVISION_TASKS, true);
  return { finalAnswer, revisionTasks };
}

export function extractUserFacingAnswer(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return parseSynthesisEnvelope(trimmed).finalAnswer;
  } catch {
    const match = trimmed.match(/"finalAnswer"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return match[1];
      }
    }
    return trimmed;
  }
}
