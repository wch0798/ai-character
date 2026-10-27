import { personaInstruction } from "./persona";
import {
  agentLabel,
  askAgentCompat,
  cancelAgent,
  confirmSensitiveAgentAccess,
  detectAgent,
  getAppPreferences,
  getWorkspaceChanges,
  prepareCradleEnvironment,
  runAgentTask,
  type AgentKind,
  type AppPreferences,
  type ModelChoice,
  type WorkActivityEvent,
  WORK_ACTIVITY_EVENT,
} from "./agent-client";
import { collectWebResearch } from "./web-research";
import { buildTaskContext } from "./context-client";
import { setCradleActivity } from "./update-client";
import {
  createCoderWorktree,
  discardCoderWorktree,
  failingTestLogs,
  mergeCoderWorktree,
  runProjectTests,
  summarizeTestRun,
  type CoderWorktree,
  type TestRunSummary,
} from "./cradle-workspace-client";
import {
  extractCurrentUserRequest,
  judgeRequestIntent,
  needsLocalFiles,
  type RequestIntent,
} from "./request-intent";
import type { RequestMode } from "./request-mode";
import { formatResumeTime, isUsageLimitMessage, limitedUntil } from "./subscription-limits";
import { compactText, compactWorkerOutput, WORKER_RESULT_SCHEMA } from "./worker-result";
import {
  classifyAutomaticProviderError,
  getAutomaticProviderStatuses,
  isFreeAutomaticProvider,
  requestPaidApproval,
  runAutomaticProvider,
  type AutomaticCallContext,
  type AutomaticProviderHealth,
  type AutomaticProviderStatus,
} from "./automatic-provider";
import {
  parseOrchestrationPlan,
  parseSynthesisEnvelope,
  extractUserFacingAnswer,
  topologicalLayers,
} from "./orchestration-plan";
import type {
  AutomaticApiTarget,
  CradleSession,
  CradleTaskState,
  ManagerWebStage,
  OrchestrationCliTarget,
  OrchestrationPlan,
  OrchestrationTarget,
  OrchestrationTaskSpec,
  TaskRole,
  WebAgentTarget,
  WebAvailability,
} from "./orchestration-types";

export const MAX_AUTOMATIC_CLI_WORKERS = 4;
const SESSION_EVENT = "ai-character:cradle-session";

type WebWaiter = { resolve: () => void };
type ManagerWaiterResult =
  | { kind: "response"; response: string }
  | { kind: "fallback" };
type ManagerWaiter = {
  resolve: (result: ManagerWaiterResult) => void;
  reject: (error: Error) => void;
};
type SynthesisWaiter = {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
};

let activeSession: CradleSession | null = null;
const webWaiters = new Map<string, WebWaiter>();
const managerWaiters = new Map<string, ManagerWaiter>();
const synthesisWaiters = new Map<string, SynthesisWaiter>();
const activeCliTaskIds = new Set<string>();
const rememberedWebAvailability: Record<WebAgentTarget, WebAvailability> = {
  claude_web: "unknown",
  chatgpt_web: "unknown",
  gemini_web: "unknown",
};
const automaticProviderHealth: Record<AutomaticApiTarget, AutomaticProviderHealth> = {
  gemini_api: "unknown",
  openrouter_api: "unknown",
  free_pool_api: "unknown",
  openai_api: "unknown",
};
let automaticProviderStatuses: AutomaticProviderStatus[] = [];
const deniedPaidProviders = new Set<string>();

const WEB_PREFERENCE_FOR_CLI: Record<OrchestrationCliTarget, WebAgentTarget> = {
  claude: "claude_web",
  codex: "chatgpt_web",
  cursor: "chatgpt_web",
  antigravity: "gemini_web",
};

const CLI_PREFERENCE_FOR_WEB: Record<WebAgentTarget, OrchestrationCliTarget[]> = {
  claude_web: ["claude"],
  chatgpt_web: ["codex", "cursor", "claude"],
  gemini_web: ["antigravity", "claude"],
};

function createSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `cradle-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function webWaiterKey(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}

function managerWaiterKey(sessionId: string, stage: ManagerWebStage): string {
  return `${sessionId}:manager:${stage}`;
}

function isWebTarget(target: OrchestrationTarget): target is WebAgentTarget {
  return target === "claude_web" || target === "chatgpt_web" || target === "gemini_web";
}

function isAutomaticApiTarget(target: OrchestrationTarget): target is AutomaticApiTarget {
  return target === "gemini_api" || target === "openrouter_api" || target === "free_pool_api" || target === "openai_api";
}

function isCliTarget(target: OrchestrationTarget): target is OrchestrationCliTarget {
  return target === "claude" || target === "codex" || target === "cursor" || target === "antigravity";
}

export function preferredWebTargetForCli(target: OrchestrationCliTarget): WebAgentTarget {
  return WEB_PREFERENCE_FOR_CLI[target];
}

function preferredCliFallbackForWeb(
  target: WebAgentTarget,
  automaticTargets: OrchestrationCliTarget[]
): OrchestrationCliTarget | null {
  return CLI_PREFERENCE_FOR_WEB[target].find((candidate) => automaticTargets.includes(candidate)) ?? null;
}

export function isQuotaOrLimitError(error: unknown): boolean {
  if (isUsageLimitMessage(error instanceof Error ? error.message : String(error))) return true;
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const markers = [
    "quota exceeded",
    "usage limit",
    "rate limit",
    "credits exhausted",
    "plan limit",
    "limit reached",
    "too many requests",
    "429",
    "사용량 초과",
    "한도 초과",
  ];
  return markers.some((marker) => text.includes(marker));
}

export function isRecoverableEnvironmentError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const markers = [
    "environment_git_missing",
    "not inside a trusted directory",
    "skip-git-repo-check",
    "cli를 찾을 수 없습니다",
    "실행 파일을 찾을 수 없습니다",
    "permission denied",
    "eacces",
    "authentication required",
    "login required",
    "not logged in",
  ];
  return markers.some((marker) => text.includes(marker));
}


function cloneSession(session: CradleSession): CradleSession {
  return JSON.parse(JSON.stringify(session)) as CradleSession;
}

function dispatchSession(session: CradleSession): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<CradleSession>(SESSION_EVENT, { detail: cloneSession(session) })
  );
}

function setSessionStatus(
  session: CradleSession,
  status: CradleSession["status"],
  message: string
): void {
  session.status = status;
  session.statusMessage = message;
  dispatchSession(session);
}

function ensureNotCancelled(session: CradleSession): void {
  if (session.status === "cancelled") {
    throw new Error("협업 작업이 취소되었습니다.");
  }
}

function stateFromSpec(spec: OrchestrationTaskSpec): CradleTaskState {
  return {
    ...spec,
    dependsOn: [...spec.dependsOn],
    status: "queued",
    output: null,
    error: null,
    fallbackCount: 0,
    fallbackFrom: null,
    fallbackReason: null,
    handoffPrompt: null,
  };
}

function findTask(session: CradleSession, taskId: string): CradleTaskState {
  const task = session.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`CRADLE task not found: ${taskId}`);
  }
  return task;
}

async function detectAutomaticTargets(): Promise<OrchestrationCliTarget[]> {
  const candidates: AgentKind[] = ["cursor", "codex", "claude", "antigravity"];
  const found = await Promise.all(
    candidates.map(async (agent) => {
      try {
        await detectAgent(agent);
        return agent;
      } catch {
        return null;
      }
    })
  );
  return found.filter((agent): agent is OrchestrationCliTarget => agent !== null);
}

const CLI_SPREAD_ORDER: OrchestrationCliTarget[] = [
  "cursor",
  "codex",
  "claude",
  "antigravity",
];

export function availableModifyCliTargets(
  automaticCliTargets: OrchestrationCliTarget[]
): OrchestrationCliTarget[] {
  return CLI_SPREAD_ORDER.filter((target) => automaticCliTargets.includes(target));
}

/** Free providers first (Gemini, OpenRouter free models, the extra free pool), then the opt-in paid OpenAI API. */
export function usableAutomaticProviders(
  statuses: AutomaticProviderStatus[],
  preferences: Pick<AppPreferences, "geminiApiEnabled" | "allowPaidOpenAiApi">,
  health: Record<AutomaticApiTarget, AutomaticProviderHealth> = automaticProviderHealth
): AutomaticApiTarget[] {
  const healthy = (provider: AutomaticApiTarget) =>
    health[provider] !== "limited" && health[provider] !== "unavailable";
  const available = (provider: AutomaticApiTarget) =>
    statuses.find((status) => status.provider === provider)?.available === true && healthy(provider);

  const providers: AutomaticApiTarget[] = [];
  if (preferences.geminiApiEnabled && available("gemini_api")) {
    providers.push("gemini_api");
  }
  if (available("openrouter_api")) {
    providers.push("openrouter_api");
  }
  if (available("free_pool_api")) {
    providers.push("free_pool_api");
  }
  if (preferences.allowPaidOpenAiApi && available("openai_api")) {
    providers.push("openai_api");
  }
  return providers;
}

function rememberAutomaticProviderFailure(provider: AutomaticApiTarget, error: unknown): void {
  const health = classifyAutomaticProviderError(error);
  if (health === "limited" || health === "unavailable") {
    automaticProviderHealth[provider] = health;
  }
}

function isPaidApprovalRequired(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes("PAID_APPROVAL_REQUIRED|");
}

/**
 * Calls an automatic provider. When the backend demands paid approval, asks the
 * user once per session/provider; a denial is remembered for that session only.
 */
async function callAutomaticProvider(
  provider: AutomaticApiTarget,
  prompt: string,
  context: AutomaticCallContext,
  approvalReason: string
): Promise<string> {
  const deniedKey = `${context.sessionId ?? "direct"}:${provider}`;
  if (deniedPaidProviders.has(deniedKey)) {
    throw new Error(`PAID_APPROVAL_DENIED|${provider}|이번 세션에서 유료 호출을 거절했습니다.`);
  }
  try {
    const response = await runAutomaticProvider(provider, prompt, context);
    automaticProviderHealth[provider] = "available";
    return response;
  } catch (error) {
    if (!isPaidApprovalRequired(error)) {
      rememberAutomaticProviderFailure(provider, error);
      throw error;
    }
    const approved = await requestPaidApproval(provider, approvalReason, context.sessionId ?? null);
    if (!approved) {
      deniedPaidProviders.add(deniedKey);
      throw new Error(`PAID_APPROVAL_DENIED|${provider}|사용자가 유료 호출을 승인하지 않았습니다.`);
    }
    try {
      const response = await runAutomaticProvider(provider, prompt, context);
      automaticProviderHealth[provider] = "available";
      return response;
    } catch (retryError) {
      rememberAutomaticProviderFailure(provider, retryError);
      throw retryError;
    }
  }
}

/** Tries providers in order and returns the first non-empty response, or null. */
async function tryAutomaticProviders(
  providers: AutomaticApiTarget[],
  prompt: string,
  context: AutomaticCallContext,
  approvalReason: string,
  onAttempt?: (provider: AutomaticApiTarget) => void
): Promise<{ provider: AutomaticApiTarget; response: string } | null> {
  for (const provider of providers) {
    onAttempt?.(provider);
    try {
      const response = (await callAutomaticProvider(provider, prompt, context, approvalReason)).trim();
      if (response) {
        return { provider, response };
      }
    } catch (error) {
      console.warn("자동 Provider 실패", { provider, error });
    }
  }
  return null;
}

export function createPlanningPrompt(
  originalPrompt: string,
  automaticTargets: OrchestrationCliTarget[],
  researchPromptBlock = "",
  automaticApiTargets: AutomaticApiTarget[] = [],
  conversationContext = ""
): string {
  return [
    "You are the lead manager of CRADLE inside AI-Character.",
    "Decompose the user's request into the smallest useful set of specialist tasks.",
    "Project work is led by Claude when Claude CLI is available, so plugins, skills, and subagents stay in that session. Cursor may also edit files. Assign factual lookup and review to a free automatic API.",
    "This path is for PROJECT work only. Simple chat questions should not be planned here.",
    "Return JSON only. Do not use markdown fences or explanatory text.",
    "Schema:",
    '{"summary":"overall plan","tasks":[{"id":"task-1","title":"short title","target":"gemini_api|openrouter_api|free_pool_api|openai_api|claude_web|chatgpt_web|gemini_web|claude|codex|cursor|antigravity","mode":"analyze|modify","role":"planner|coder|reviewer|tester|documenter","prompt":"self-contained worker instruction","dependsOn":[],"estimateMinutes":10}]}',
    "Rules:",
    "- Use 1 to 8 tasks. Prefer fewer workers when one worker is enough.",
    "- Give every task a role: planner (design/breakdown), coder (edits files, mode=modify, CLI only), reviewer (checks code/results), tester (runs the project's tests and analyzes failures; depend on coder tasks), documenter (writes docs/reports).",
    "- If claude is available, mode=modify tasks use claude, and cursor when cursor is also available. Plugins load on the Claude run. Do not assign file edits to codex or antigravity while claude is available.",
    "- Use Codex or Antigravity for mode=modify only when claude and cursor are both unavailable.",
    "- Factual and review tasks use a free automatic API. Gemini is preferred, then OpenRouter.",
    "- OpenAI API is paid and may be assigned only when it appears in the available automatic API list.",
    "- Manual web targets are the last fallback.",
    "- For mode=analyze, prefer an available automatic API target instead of CLI targets.",
    "- Creating or editing files, apps, or web pages REQUIRES at least one mode=modify CLI task.",
    "- The conversation workspace already has write permission. Never ask the user for /add-dir, extra folder access, or secret files.",
    `- Available automatic API targets: ${automaticApiTargets.join(", ") || "none"}. Do not assign an unavailable API target.`,
    `- Available automatic CLI targets: ${automaticTargets.join(", ")}. Do not assign an unavailable CLI target.`,
    "- Web agents are always human-assisted last-resort handoffs, not APIs or DOM scraping.",
    "- Make each worker prompt self-contained and short. Do not copy the full conversation into worker prompts.",
    "- estimateMinutes: a realistic estimate of how many minutes the task needs, including its tests. The user sees it and decides whether to keep waiting, so be honest rather than optimistic.",
    "- Instruct analyze workers to return JSON only using this schema:",
    WORKER_RESULT_SCHEMA,
    "- Do not place secrets, credentials, private keys, cookies, or auth tokens in web-agent prompts.",
    conversationContext ? "COMPACT CONVERSATION CONTEXT:" : "",
    conversationContext,
    researchPromptBlock ? "" : "",
    researchPromptBlock,
    "",
    "USER REQUEST:",
    originalPrompt.trim(),
  ].filter((line) => line !== "").join("\n");
}

export function normalizePlanForWebFirst(
  plan: OrchestrationPlan,
  availability: Record<WebAgentTarget, WebAvailability>
): OrchestrationPlan {
  return {
    summary: plan.summary,
    tasks: plan.tasks.map((task) => {
      if (task.mode === "modify" || !isCliTarget(task.target)) {
        return { ...task, dependsOn: [...task.dependsOn] };
      }
      const webTarget = preferredWebTargetForCli(task.target);
      if (availability[webTarget] === "limited") {
        return { ...task, dependsOn: [...task.dependsOn] };
      }
      return { ...task, target: webTarget, dependsOn: [...task.dependsOn] };
    }),
  };
}

export function normalizePlanForAutomaticProviders(
  plan: OrchestrationPlan,
  automaticApiTargets: AutomaticApiTarget[],
  automaticCliTargets: OrchestrationCliTarget[],
  availability: Record<WebAgentTarget, WebAvailability>,
  /** 무료 AI 먼저 쓰기. Off: analysis goes to the installed (subscribed) programs. */
  freeFirst = true
): OrchestrationPlan {
  const freeTargets = automaticApiTargets.filter((target) => isFreeAutomaticProvider(target));
  const freeAutomatic: AutomaticApiTarget | null = freeTargets[0] ?? null;
  const paidAutomatic = automaticApiTargets.includes("openai_api") ? "openai_api" : null;
  const modifyClis = availableModifyCliTargets(automaticCliTargets);
  let modifyIndex = 0;

  return {
    summary: plan.summary,
    tasks: plan.tasks.map((task) => {
      if (task.mode === "modify") {
        const claudeAndCursor = (["claude", "cursor"] as const).filter((target) => automaticCliTargets.includes(target));
        const fileEditors = claudeAndCursor.length > 0 ? claudeAndCursor : modifyClis;
        if (fileEditors.length > 0) {
          const target = fileEditors[modifyIndex % fileEditors.length];
          modifyIndex += 1;
          return { ...task, target, dependsOn: [...task.dependsOn] };
        }
        if (isAutomaticApiTarget(task.target) || isCliTarget(task.target)) {
          const webTarget: WebAgentTarget = task.target === "openai_api" || task.target === "codex" || task.target === "cursor"
            ? "chatgpt_web"
            : "gemini_web";
          return { ...task, target: webTarget, dependsOn: [...task.dependsOn] };
        }
        return { ...task, dependsOn: [...task.dependsOn] };
      }

      // Reading the work folder needs a program running inside it: free and web AIs cannot see
      // the files and would stall (or ask the user to paste them). Without 무료 AI 먼저 쓰기,
      // the subscribed programs take every task they can.
      const localFiles = needsLocalFiles(`${task.title}\n${task.prompt}`);
      if (localFiles || !freeFirst) {
        const reader = isCliTarget(task.target) && automaticCliTargets.includes(task.target)
          ? task.target
          : automaticCliTargets[0];
        if (reader) {
          return { ...task, target: reader, dependsOn: [...task.dependsOn] };
        }
      }

      if (isAutomaticApiTarget(task.target)) {
        if (task.target === "openai_api" && freeAutomatic) {
          return { ...task, target: freeAutomatic, dependsOn: [...task.dependsOn] };
        }
        if (automaticApiTargets.includes(task.target)) {
          return { ...task, dependsOn: [...task.dependsOn] };
        }
        if (freeAutomatic) {
          return { ...task, target: freeAutomatic, dependsOn: [...task.dependsOn] };
        }
        if (paidAutomatic) {
          return { ...task, target: paidAutomatic, dependsOn: [...task.dependsOn] };
        }
        const webTarget: WebAgentTarget = task.target === "openai_api" ? "chatgpt_web" : "gemini_web";
        return { ...task, target: webTarget, dependsOn: [...task.dependsOn] };
      }

      if (freeAutomatic && (isCliTarget(task.target) || isWebTarget(task.target))) {
        return { ...task, target: freeAutomatic, dependsOn: [...task.dependsOn] };
      }

      // No free AI: an installed program answers rather than a web page that waits for the
      // user to copy and paste.
      if ((isCliTarget(task.target) || isWebTarget(task.target)) && automaticCliTargets.length > 0) {
        const program = isCliTarget(task.target) && automaticCliTargets.includes(task.target)
          ? task.target
          : automaticCliTargets[0];
        return { ...task, target: program, dependsOn: [...task.dependsOn] };
      }

      if (isCliTarget(task.target)) {
        const webTarget = preferredWebTargetForCli(task.target);
        if (availability[webTarget] !== "limited") {
          return { ...task, target: webTarget, dependsOn: [...task.dependsOn] };
        }
      }
      return { ...task, dependsOn: [...task.dependsOn] };
    }),
  };
}

function compactResearchForPrompt(researchPromptBlock: string): string {
  return compactText(researchPromptBlock.trim(), 2_400);
}

function dependencyContext(session: CradleSession, task: CradleTaskState): string {
  const parts: string[] = [];
  for (const dependencyId of task.dependsOn) {
    const dependency = findTask(session, dependencyId);
    const output = dependency.output
      ? compactWorkerOutput(dependency.output, dependency.mode)
      : `Error: ${dependency.error ?? "no output"}`;
    parts.push(
      [
        `Dependency ${dependency.id}: ${dependency.title}`,
        `Status: ${dependency.status}`,
        `Output JSON:\n${output}`,
      ].join("\n")
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : "No dependency outputs.";
}

const ROLE_INSTRUCTIONS: Record<TaskRole, string> = {
  planner: "break the work into concrete steps and interfaces; do not edit files.",
  coder: "implement the change in the workspace files; keep the diff minimal.",
  reviewer: "check correctness, regressions, and security; list concrete issues.",
  tester: "explain failing tests from the logs and propose the smallest fix.",
  documenter: "write concise documentation or a change report from the results.",
};

/** Workers run under the app's time limit; one slow test (65,000 mkdirs) used it all up once. */
const LONG_COMMAND_RULE =
  "Time limit: the whole task must finish well within the app's time limit. Keep every command under about 5 minutes: scale stress tests and benchmarks down (thousands, not tens of thousands of items) or give them a timeout, and do not start or wait for a command you expect to run longer. If a full-size check would take too long, run a smaller one and say what the full size would need.";

const RESUME_AFTER_TIMEOUT =
  "RESUMING: an earlier attempt at this task ran out of time and was stopped. Its file changes are still in this work copy. Check what is already done (git status / git diff), do not redo it, finish only what is left, and skip or shrink whatever long-running command stopped it.";

export function isTimeoutError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /시간이 (?:설정된 )?제한을 초과|시간을 초과|timed out|timeout/i.test(text);
}

function buildWorkerPrompt(session: CradleSession, task: CradleTaskState): string {
  const researchPromptBlock = compactResearchForPrompt(session.webResearch.researchPromptBlock);
  const webModifyNotice = isWebTarget(task.target) && task.mode === "modify"
    ? "This web agent cannot modify local files directly. Return a precise patch/diff or step-by-step file edits for the Claude manager or a later CLI worker to apply."
    : "";
  const jsonNotice = task.mode === "analyze"
    ? `Return JSON only using this schema:\n${WORKER_RESULT_SCHEMA}\nDo not paste long original web pages or full conversation transcripts.`
    : "Return a concise patch/diff. Do not repeat the full project.";
  return [
    `You are the ${task.target} worker in a CRADLE orchestration session.`,
    `Task: ${task.title}`,
    `Mode: ${task.mode}`,
    task.role ? `Role: ${task.role} — ${ROLE_INSTRUCTIONS[task.role]}` : "",
    "Follow only this assigned task.",
    jsonNotice,
    task.mode === "modify" && isCliTarget(task.target)
      ? "You already have permission to read and write this conversation workspace. Do not ask for /add-dir, extra folders, or keys.env. Read .ai-character-context.md if present, then start implementing immediately."
      : "Analyze only unless a tiny temporary artifact is strictly necessary.",
    webModifyNotice,
    isCliTarget(task.target) ? LONG_COMMAND_RULE : "",
    task.resumedAfterTimeout ? RESUME_AFTER_TIMEOUT : "",
    "",
    "ORIGINAL USER REQUEST:",
    compactText(session.originalPrompt, 800),
    "",
    "ASSIGNED WORK:",
    compactText(task.prompt, 2_000),
    researchPromptBlock ? "" : "",
    researchPromptBlock,
    task.codeContext ? "" : "",
    task.codeContext
      ? `RELEVANT PROJECT CONTEXT (selected blocks only, not the whole project):\n${task.codeContext}`
      : "",
    task.testSummary ? `TEST RUN SUMMARY:\n${task.testSummary}` : "",
    task.testLog ? `FAILING TEST LOGS (trimmed):\n${task.testLog}` : "",
    "",
    "DEPENDENCY RESULTS:",
    dependencyContext(session, task),
  ].filter(Boolean).join("\n");
}

/** CLI workers can read files themselves, so they get a smaller excerpt. */
export function contextBudgetFor(target: OrchestrationTarget): number {
  return isCliTarget(target) ? 4_000 : 12_000;
}

async function runTesterCommands(session: CradleSession, task: CradleTaskState): Promise<TestRunSummary | null> {
  if (task.role !== "tester" || !session.conversationId || task.testSummary !== undefined) {
    return null;
  }
  setSessionStatus(session, session.status, `${task.title}: 프로젝트 테스트를 실행합니다.`);
  try {
    const summary = await runProjectTests(session.conversationId, session.id, task.id, "tester");
    task.testSummary = summarizeTestRun(summary);
    task.testLog = summary.passed ? "" : failingTestLogs(summary);
    return summary;
  } catch (error) {
    task.testSummary = JSON.stringify({ tests: "error", error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** A passing (or absent) test run needs no model call. */
export function testerResultWithoutModel(summary: TestRunSummary | null): string | null {
  if (!summary || (summary.detected && !summary.passed)) {
    return null;
  }
  return JSON.stringify({
    summary: summary.detected ? "모든 프로젝트 테스트가 통과했습니다." : "실행할 테스트 명령을 찾지 못했습니다.",
    findings: [],
    tests: summarizeTestRun(summary),
  });
}

async function prepareTaskContext(session: CradleSession, task: CradleTaskState): Promise<void> {
  if (task.codeContext !== undefined || !session.conversationId) {
    return;
  }
  const result = await buildTaskContext(
    session.conversationId,
    [task.title, task.prompt, session.originalPrompt].join("\n"),
    contextBudgetFor(task.target)
  );
  task.codeContext = result.context;
  task.contextFingerprint = result.fingerprint;
}

export function buildSynthesisPrompt(session: CradleSession, allowRevision: boolean): string {
  const researchPromptBlock = compactResearchForPrompt(session.webResearch.researchPromptBlock);
  const workerResults = session.tasks
    .map((task) => {
      const result = task.output
        ? compactWorkerOutput(task.output, task.mode)
        : task.error ?? "No result";
      return [
        `### ${task.id} — ${task.title}`,
        `Target: ${task.target}`,
        `Status: ${task.status}`,
        task.fallbackReason ? `Fallback: ${task.fallbackReason}` : "",
        result,
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");

  return [
    "You are the Claude lead manager for CRADLE.",
    "Review compact worker JSON results for correctness, consistency, missing pieces, and the user's original intent.",
    "Do not ask the user to re-copy long web pages. Use the JSON envelopes already collected.",
    "Return JSON only with this schema:",
    '{"finalAnswer":"user-facing final answer","revisionTasks":[]}',
    allowRevision
      ? "If a material gap can be fixed with one more bounded worker round, include 1-4 revisionTasks using the same task schema. Otherwise use an empty array."
      : "This is the final review round. revisionTasks MUST be an empty array.",
    "Prefer automatic APIs for revision analysis/review; use CLI only when local file modification is required.",
    "Revision task dependencies may only refer to other revision task IDs. Prior results are already included below.",
    "Do not mention internal JSON or orchestration machinery in finalAnswer unless the user asked about it.",
    "",
    "ORIGINAL USER REQUEST:",
    compactText(session.originalPrompt, 800),
    "",
    "PLAN SUMMARY:",
    compactText(session.planSummary, 600),
    researchPromptBlock ? "" : "",
    researchPromptBlock,
    "",
    "WORKER RESULTS:",
    workerResults,
  ].join("\n");
}

async function runClaudeManagerCli(
  prompt: string,
  conversationId: string | null,
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean
): Promise<string> {
  const task = runAgentTask({
    agent: "claude",
    prompt,
    conversationId,
    timeoutSeconds: preferences.timeoutSeconds,
    sensitiveAcknowledged,
    emitRuntimeEvents: false,
  });
  activeCliTaskIds.add(task.taskId);
  try {
    return await task.result;
  } finally {
    activeCliTaskIds.delete(task.taskId);
  }
}

export type ManagerStep = AutomaticApiTarget | "claude_cli";

/** Claude leads project work so plugins stay attached. Free APIs are the factual fallback, then paid APIs. */
export function managerProviderOrder(apis: AutomaticApiTarget[], claudeCliAvailable: boolean): ManagerStep[] {
  const order: ManagerStep[] = [];
  if (claudeCliAvailable) {
    order.push("claude_cli");
  }
  order.push(...apis.filter((api) => isFreeAutomaticProvider(api)));
  order.push(...apis.filter((api) => !isFreeAutomaticProvider(api)));
  return order;
}

function managerStatusMessage(provider: AutomaticApiTarget, stage: ManagerWebStage): string {
  const name =
    provider === "gemini_api"
      ? "Gemini 공식 API(무료 우선)"
      : provider === "openrouter_api"
        ? "OpenRouter 무료 모델"
        : provider === "free_pool_api"
          ? "추가 무료 AI(Groq·NVIDIA·GLM 등)"
          : "승인된 OpenAI 유료 API";
  return stage === "planning"
    ? `${name}로 협업 계획을 자동 생성합니다.`
    : `${name}로 작업 AI들의 결과를 자동 취합합니다.`;
}

export async function runAutomaticManager(
  session: CradleSession,
  stage: ManagerWebStage,
  prompt: string,
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean
): Promise<string> {
  const order = managerProviderOrder(
    usableAutomaticProviders(automaticProviderStatuses, preferences),
    session.automaticCliTargets.includes("claude")
  );
  const status = stage === "planning" ? "planning" : "synthesizing";
  const context: AutomaticCallContext = { sessionId: session.id, role: stage === "planning" ? "planner" : "reviewer" };
  const approvalReason = stage === "planning" ? "협업 계획 만들기" : "작업 AI 결과 정리";

  for (const step of order) {
    if (step === "claude_cli") {
      setSessionStatus(session, status, "Claude가 플러그인과 함께 이 작업을 진행합니다.");
      try {
        return await runClaudeManagerCli(prompt, session.conversationId, preferences, sensitiveAcknowledged);
      } catch (error) {
        pendingChatNotice = isQuotaOrLimitError(error)
          ? "Claude 구독 사용량을 다 썼습니다. 무료 AI가 이어받습니다."
          : "Claude로 처리하지 못해 무료 AI가 이어받습니다.";
        setSessionStatus(session, status, pendingChatNotice);
        console.warn("Claude CLI 총괄 실패", error);
      }
      continue;
    }
    setSessionStatus(session, status, managerStatusMessage(step, stage));
    const result = await tryAutomaticProviders([step], prompt, context, approvalReason);
    if (result) {
      return result.response;
    }
  }

  return runClaudeManagerWebFirst(
    session,
    stage,
    prompt,
    preferences,
    sensitiveAcknowledged
  );
}

export async function runClaudeManagerWebFirst(
  session: CradleSession,
  stage: ManagerWebStage,
  prompt: string,
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean
): Promise<string> {
  if (rememberedWebAvailability.claude_web === "limited") {
    session.webAvailability.claude_web = "limited";
    return runClaudeManagerCli(prompt, session.conversationId, preferences, sensitiveAcknowledged);
  }

  session.managerHandoff = {
    stage,
    target: "claude_web",
    status: "waiting_web",
    prompt,
    error: null,
  };
  setSessionStatus(
    session,
    "waiting_web",
    stage === "planning"
      ? "Claude Web 총괄에게 작업 계획을 요청합니다."
      : "Claude Web 총괄에게 작업 AI들의 결과 취합·검토를 요청합니다."
  );

  const key = managerWaiterKey(session.id, stage);
  const result = await new Promise<ManagerWaiterResult>((resolve, reject) => {
    managerWaiters.set(key, { resolve, reject });
  });
  managerWaiters.delete(key);
  session.managerHandoff = null;

  if (result.kind === "response") {
    rememberedWebAvailability.claude_web = "available";
    session.webAvailability.claude_web = "available";
    dispatchSession(session);
    return result.response;
  }

  session.webAvailability.claude_web = "limited";
  return runClaudeManagerCli(prompt, session.conversationId, preferences, sensitiveAcknowledged);
}

export function submitManagerWebResponse(
  sessionId: string,
  stage: ManagerWebStage,
  response: string
): void {
  if (!activeSession || activeSession.id !== sessionId || activeSession.managerHandoff?.stage !== stage) {
    throw new Error("현재 Claude Web 총괄 요청이 아닙니다.");
  }
  const clean = response.trim();
  if (!clean) {
    throw new Error("Claude Web 응답을 붙여넣어 주세요.");
  }
  rememberedWebAvailability.claude_web = "available";
  activeSession.webAvailability.claude_web = "available";
  const key = managerWaiterKey(sessionId, stage);
  const waiter = managerWaiters.get(key);
  if (!waiter) {
    throw new Error("Claude Web 총괄 대기 상태를 찾을 수 없습니다.");
  }
  activeSession.managerHandoff = null;
  managerWaiters.delete(key);
  waiter.resolve({ kind: "response", response: clean });
  dispatchSession(activeSession);
}

export function markWebAgentLimited(target: WebAgentTarget): void {
  rememberedWebAvailability[target] = "limited";
  if (activeSession) {
    activeSession.webAvailability[target] = "limited";
    dispatchSession(activeSession);
  }
}

export function fallbackManagerWebToCli(sessionId: string, stage: ManagerWebStage): void {
  if (!activeSession || activeSession.id !== sessionId || activeSession.managerHandoff?.stage !== stage) {
    throw new Error("현재 Claude Web 총괄 요청이 아닙니다.");
  }
  markWebAgentLimited("claude_web");
  activeSession.managerHandoff.status = "fallback_cli";
  activeSession.managerHandoff.error = "Claude Web 한도 초과/사용 불가 — Claude CLI로 전환";
  const key = managerWaiterKey(sessionId, stage);
  const waiter = managerWaiters.get(key);
  if (!waiter) {
    throw new Error("Claude Web 총괄 대기 상태를 찾을 수 없습니다.");
  }
  managerWaiters.delete(key);
  waiter.resolve({ kind: "fallback" });
  dispatchSession(activeSession);
}

function fallbackCliTaskToAlternative(
  session: CradleSession,
  task: CradleTaskState,
  error: unknown
): boolean {
  if (!isCliTarget(task.target) || task.fallbackCount >= 1) {
    return false;
  }
  const from = task.target;
  const preference: OrchestrationCliTarget[] = ["codex", "cursor", "claude", "antigravity"];
  const alternative = preference.find(
    (candidate) => candidate !== from && session.automaticCliTargets.includes(candidate)
  );
  if (!alternative) {
    return false;
  }
  task.fallbackCount += 1;
  task.fallbackFrom = from;
  task.fallbackReason = `${from} 작업 환경 오류 → ${alternative} CLI로 재배정`;
  task.target = alternative;
  task.status = "queued";
  task.error = null;
  task.handoffPrompt = null;
  session.statusMessage = `${from} 작업 환경 오류를 감지해 ${alternative}로 자동 재배정합니다.`;
  dispatchSession(session);
  console.warn("CRADLE CLI 재배정", { from, alternative, error });
  return true;
}

async function fallbackCliTaskToWeb(
  session: CradleSession,
  task: CradleTaskState,
  error: unknown
): Promise<void> {
  if (!isCliTarget(task.target) || task.fallbackCount >= 1) {
    task.error = error instanceof Error ? error.message : String(error);
    task.status = session.status === "cancelled" ? "cancelled" : "failed";
    return;
  }
  const from = task.target;
  const webTarget = preferredWebTargetForCli(from);
  if (rememberedWebAvailability[webTarget] === "limited") {
    task.error = error instanceof Error ? error.message : String(error);
    task.status = "failed";
    return;
  }
  task.fallbackCount += 1;
  task.fallbackFrom = from;
  const reason = isQuotaOrLimitError(error) ? "사용량/한도 초과" : "작업 환경 오류";
  task.fallbackReason = `${from} CLI ${reason} → ${webTarget} Web으로 전환`;
  task.target = webTarget;
  await waitForWebTask(session, task);
}

async function runAutomaticApiTask(
  session: CradleSession,
  task: CradleTaskState,
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean
): Promise<void> {
  if (!isAutomaticApiTarget(task.target)) {
    throw new Error(`automatic API worker cannot execute target: ${task.target}`);
  }
  const provider = task.target;
  task.status = "running";
  reportWork("자동 AI", `🌐 맡김: ${task.title}`);
  task.error = null;
  task.handoffPrompt = null;
  dispatchSession(session);

  const testRun = await runTesterCommands(session, task);
  const directTesterResult = testerResultWithoutModel(testRun);
  if (directTesterResult) {
    task.output = directTesterResult;
    task.status = session.status === "cancelled" ? "cancelled" : "completed";
    dispatchSession(session);
    return;
  }
  await prepareTaskContext(session, task);
  const workerPrompt = buildWorkerPrompt(session, task);
  const context: AutomaticCallContext = {
    sessionId: session.id,
    taskId: task.id,
    role: "worker",
    cacheFingerprint: task.contextFingerprint || null,
  };
  const reason = `협업 작업: ${task.title}`;
  try {
    task.output = compactWorkerOutput(
      (await callAutomaticProvider(provider, workerPrompt, context, reason)).trim(),
      task.mode
    );
    task.status = session.status === "cancelled" ? "cancelled" : "completed";
  } catch (error) {
    const alternatives = usableAutomaticProviders(automaticProviderStatuses, await getAppPreferences())
      .filter((candidate) => candidate !== provider && isFreeAutomaticProvider(candidate));
    const alternative = session.status === "cancelled"
      ? null
      : await tryAutomaticProviders(alternatives, workerPrompt, context, reason);
    if (alternative) {
      task.fallbackCount += 1;
      task.fallbackFrom = provider;
      task.fallbackReason = `${provider} 사용 불가 → ${alternative.provider} 무료 AI로 전환`;
      task.target = alternative.provider;
      task.output = compactWorkerOutput(alternative.response, task.mode);
      task.status = "completed";
    } else if (session.status === "cancelled") {
      task.error = "협업 작업이 취소되었습니다.";
      task.status = "cancelled";
    } else if (task.fallbackCount < 1 && session.automaticCliTargets.length > 0) {
      // No free AI answered: an installed program does the task rather than a web page that
      // waits for the user to copy and paste.
      const program = session.automaticCliTargets[0];
      task.fallbackCount += 1;
      task.fallbackFrom = provider;
      task.fallbackReason = `${provider} 사용 불가 → ${program} 프로그램으로 전환`;
      task.target = program;
      task.status = "queued";
      task.error = null;
      reportWork("자동 AI", `↪ 무료 AI가 답하지 못해 ${agentLabel(program)}에게 넘깁니다: ${task.title}`);
      dispatchSession(session);
      await runAutomaticTask(session, task, preferences, sensitiveAcknowledged);
      return;
    } else if (task.fallbackCount < 1) {
      task.fallbackCount += 1;
      task.fallbackFrom = provider;
      const webTarget: WebAgentTarget = provider === "openai_api" ? "chatgpt_web" : "gemini_web";
      if (rememberedWebAvailability[webTarget] === "limited") {
        task.error = error instanceof Error ? error.message : String(error);
        task.status = "failed";
      } else {
        task.fallbackReason = `${provider} 사용 불가 → ${webTarget} 수동 Web fallback`;
        task.target = webTarget;
        await waitForWebTask(session, task);
      }
    } else {
      task.error = error instanceof Error ? error.message : String(error);
      task.status = "failed";
    }
  }
  dispatchSession(session);
}

/** Not a type guard on purpose: status can change while an awaited worker is running. */
function isSessionCancelled(session: CradleSession): boolean {
  return session.status === "cancelled";
}

async function runAutomaticTask(
  session: CradleSession,
  task: CradleTaskState,
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean,
  /** The work copy of an attempt that ran out of time: resumed instead of made anew. */
  resumeIn: CoderWorktree | null = null
): Promise<void> {
  if (!isCliTarget(task.target)) {
    throw new Error(`automatic worker cannot execute web target: ${task.target}`);
  }
  task.status = "running";
  task.error = null;
  task.handoffPrompt = null;
  dispatchSession(session);

  await prepareTaskContext(session, task);
  const worktree = resumeIn ?? (task.mode === "modify" && session.conversationId
    ? await createCoderWorktree(session.conversationId, task.id)
    : null);
  task.startedAt = Date.now();
  const worker = runAgentTask({
    agent: task.target,
    prompt: buildWorkerPrompt(session, task),
    workingDir: worktree?.path ?? null,
    conversationId: session.conversationId,
    // No time limit (0): the task card shows the estimate and the user keeps waiting, skips
    // the task or stops everything.
    timeoutSeconds: 0,
    sensitiveAcknowledged,
    emitRuntimeEvents: false,
    onStream: () => {
      // Stream ownership stays with the CRADLE task UI.
    },
  });
  activeCliTaskIds.add(worker.taskId);
  task.workerTaskId = worker.taskId;
  dispatchSession(session);

  let mergeAttempted = false;
  try {
    task.output = compactWorkerOutput((await worker.result).trim(), task.mode);
    if (isSessionCancelled(session)) {
      throw new Error("협업 작업이 취소되었습니다.");
    }
    if (worktree && session.conversationId) {
      mergeAttempted = true;
      const merge = await mergeCoderWorktree(session.conversationId, task.id);
      task.output = `${task.output}\n\nWORKTREE MERGE: ${merge.message}`;
      if (merge.conflictFiles.length > 0) {
        task.fallbackReason = `병합 충돌 파일: ${merge.conflictFiles.join(", ")} (변경 검토 화면에서 확인)`;
      }
      if (!merge.merged) {
        throw new Error(merge.message);
      }
    }
    task.status = session.status === "cancelled" ? "cancelled" : "completed";
  } catch (error) {
    if (mergeAttempted) {
      task.error = error instanceof Error ? error.message : String(error);
      task.status = "failed";
      dispatchSession(session);
      return;
    }
    // Out of time: the changes made so far are kept. The task resumes once in the same work
    // copy; if it runs out again, what it finished goes to review instead of being thrown away.
    // Skipped by the user: what it finished goes to review and the session moves on.
    if (task.skipRequested && !isSessionCancelled(session)) {
      activeCliTaskIds.delete(worker.taskId);
      const merge = worktree && session.conversationId
        ? await mergeCoderWorktree(session.conversationId, task.id).catch(() => null)
        : null;
      task.output = `사용자가 이 작업을 건너뛰었습니다. 그때까지 한 내용만 반영합니다.${merge ? `\n\nWORKTREE MERGE: ${merge.message}` : ""}`;
      task.status = "completed";
      task.fallbackReason = "사용자가 건너뜀 — 그때까지 고친 내용은 변경 검토 화면에 있습니다";
      dispatchSession(session);
      return;
    }
    // A resumed attempt that fails for any reason keeps what both attempts finished, too.
    const keepPartial = isTimeoutError(error) || task.resumedAfterTimeout === true;
    if (keepPartial && !isSessionCancelled(session)) {
      activeCliTaskIds.delete(worker.taskId);
      if (!task.resumedAfterTimeout) {
        task.resumedAfterTimeout = true;
        reportWork(agentLabel(task.target), `⏱ 시간 제한에 걸려 멈췄습니다. 고친 내용은 그대로 두고 남은 부분만 이어서 합니다: ${task.title}`);
        await runAutomaticTask(session, task, preferences, sensitiveAcknowledged, worktree);
        return;
      }
      if (worktree && session.conversationId) {
        const merge = await mergeCoderWorktree(session.conversationId, task.id).catch(() => null);
        const why = isTimeoutError(error) ? "시간 제한에 두 번 걸려" : "이어서 하던 중 오류가 나서";
        task.output = `${why} 일부만 끝냈습니다. 지금까지 고친 내용은 변경 검토 화면에서 확인할 수 있습니다.${merge ? `\n\nWORKTREE MERGE: ${merge.message}` : ""}`;
        task.status = "completed";
        task.fallbackReason = "시간 제한으로 일부만 완료 — 남은 부분은 다시 요청해 주세요";
        dispatchSession(session);
        return;
      }
    }
    if (worktree && session.conversationId) {
      await discardCoderWorktree(session.conversationId, task.id);
    }
    if (session.status === "cancelled") {
      task.error = "협업 작업이 취소되었습니다.";
      task.status = "cancelled";
    } else if (isQuotaOrLimitError(error)) {
      await fallbackCliTaskToWeb(session, task, error);
    } else if (isRecoverableEnvironmentError(error)) {
      if (!fallbackCliTaskToAlternative(session, task, error)) {
        await fallbackCliTaskToWeb(session, task, error);
      }
    } else {
      task.error = error instanceof Error ? error.message : String(error);
      task.status = "failed";
    }
  } finally {
    activeCliTaskIds.delete(worker.taskId);
  }
  dispatchSession(session);
}

async function waitForWebTask(session: CradleSession, task: CradleTaskState): Promise<void> {
  if (!isWebTarget(task.target)) {
    return;
  }
  await runTesterCommands(session, task);
  await prepareTaskContext(session, task);
  task.status = "waiting_web";
  task.error = null;
  task.handoffPrompt = buildWorkerPrompt(session, task);
  reportWork("웹 AI", `✋ 웹 응답을 붙여넣기를 기다리는 중: ${task.title}`);
  dispatchSession(session);
  return new Promise<void>((resolve) => {
    webWaiters.set(webWaiterKey(session.id, task.id), { resolve });
  });
}

async function runLimited(
  tasks: CradleTaskState[],
  limit: number,
  worker: (task: CradleTaskState) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const count = Math.min(limit, tasks.length);
  const runners = Array.from({ length: count }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      await worker(tasks[index]);
    }
  });
  await Promise.all(runners);
}

function dependencyFailed(session: CradleSession, task: CradleTaskState): string | null {
  for (const dependencyId of task.dependsOn) {
    const dependency = findTask(session, dependencyId);
    if (dependency.status === "failed" || dependency.status === "cancelled") {
      return dependencyId;
    }
  }
  return null;
}

function rerouteLimitedWebTaskToCli(session: CradleSession, task: CradleTaskState): void {
  if (!isWebTarget(task.target) || rememberedWebAvailability[task.target] !== "limited") {
    return;
  }
  const from = task.target;
  const fallback = preferredCliFallbackForWeb(from, session.automaticCliTargets);
  if (!fallback || task.fallbackCount >= 1) {
    task.status = "failed";
    task.error = `${from} 사용 불가이며 대체 CLI를 사용할 수 없습니다.`;
    return;
  }
  task.fallbackCount += 1;
  task.fallbackFrom = from;
  task.fallbackReason = `${from} Web 사용 불가 → ${fallback} CLI로 전환`;
  task.target = fallback;
  task.status = "queued";
  task.handoffPrompt = null;
}

async function runQueuedCliTasks(
  session: CradleSession,
  tasks: CradleTaskState[],
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean
): Promise<void> {
  const cliAnalyze = tasks.filter((task) => isCliTarget(task.target) && task.mode !== "modify");
  const cliModify = tasks.filter((task) => isCliTarget(task.target) && task.mode === "modify");
  await runLimited(cliAnalyze, MAX_AUTOMATIC_CLI_WORKERS, (task) =>
    runAutomaticTask(session, task, preferences, sensitiveAcknowledged)
  );
  for (const task of cliModify) {
    await runAutomaticTask(session, task, preferences, sensitiveAcknowledged);
  }
}

async function runQueuedApiTasks(
  session: CradleSession,
  tasks: CradleTaskState[],
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean
): Promise<void> {
  await runLimited(tasks.filter((task) => isAutomaticApiTarget(task.target)), 3, (task) =>
    runAutomaticApiTask(session, task, preferences, sensitiveAcknowledged)
  );
}

async function executePlanTasks(
  session: CradleSession,
  plan: OrchestrationPlan,
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean
): Promise<void> {
  const layers = topologicalLayers(plan.tasks);

  for (const layer of layers) {
    ensureNotCancelled(session);
    const layerStates = layer.map((spec) => findTask(session, spec.id));
    for (const task of layerStates) {
      const failedDependency = dependencyFailed(session, task);
      if (failedDependency) {
        task.status = "failed";
        task.error = `선행 작업 ${failedDependency}이 실패해 이 작업을 실행하지 않았습니다. 협업 기능이 가능한 재배정을 모두 시도한 뒤 중단했습니다.`;
        continue;
      }
      if (task.status === "queued") {
        rerouteLimitedWebTaskToCli(session, task);
      }
    }

    const runnable = layerStates.filter((task) => task.status === "queued");
    const webTasks = runnable.filter((task) => isWebTarget(task.target));
    const apiTasks = runnable.filter((task) => isAutomaticApiTarget(task.target));
    const cliTasks = runnable.filter((task) => isCliTarget(task.target));

    const webPromises = webTasks.map((task) => waitForWebTask(session, task));
    if (webTasks.length > 0) {
      setSessionStatus(session, "waiting_web", "자동 AI·AI 프로그램 작업을 실행하면서 마지막 수동 Web 응답을 기다립니다.");
    } else {
      setSessionStatus(session, "running", "자동 AI와 필요한 AI 프로그램를 실행 중입니다.");
    }

    await Promise.all([
      runQueuedApiTasks(session, apiTasks, preferences, sensitiveAcknowledged),
      runQueuedCliTasks(session, cliTasks, preferences, sensitiveAcknowledged),
    ]);
    await Promise.all(webPromises);
    ensureNotCancelled(session);

    // A user can mark a waiting Web Agent as unavailable. Those tasks are
    // converted to queued CLI fallbacks and run after the web waiter resolves.
    const webToCliFallbacks = layerStates.filter(
      (task) => task.status === "queued" && isCliTarget(task.target)
    );
    if (webToCliFallbacks.length > 0) {
      setSessionStatus(session, "running", "Web 사용 불가 작업을 CLI로 전환해 실행합니다.");
      await runQueuedCliTasks(session, webToCliFallbacks, preferences, sensitiveAcknowledged);
    }
    ensureNotCancelled(session);
  }
}

function remapRevisionTasks(tasks: OrchestrationTaskSpec[]): OrchestrationTaskSpec[] {
  const idMap = new Map(tasks.map((task) => [task.id, `rev1-${task.id}`] as const));
  return tasks.map((task) => ({
    ...task,
    id: idMap.get(task.id) ?? `rev1-${task.id}`,
    dependsOn: task.dependsOn.map((dependency) => idMap.get(dependency) ?? dependency),
  }));
}

async function synthesize(
  session: CradleSession,
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean
): Promise<{ finalAnswer: string; revisionTasks: OrchestrationTaskSpec[] }> {
  setSessionStatus(session, "synthesizing", "총괄 AI가 작업 AI들의 결과를 취합·검토합니다.");
  const raw = await runAutomaticManager(
    session,
    "synthesis",
    buildSynthesisPrompt(session, session.revisionRound === 0),
    preferences,
    sensitiveAcknowledged
  );
  try {
    const parsed = parseSynthesisEnvelope(raw);
    return {
      finalAnswer: extractUserFacingAnswer(parsed.finalAnswer) || parsed.finalAnswer,
      revisionTasks: parsed.revisionTasks,
    };
  } catch {
    const finalAnswer = extractUserFacingAnswer(raw);
    if (!finalAnswer) {
      throw new Error("Claude synthesis returned an empty response.");
    }
    return { finalAnswer, revisionTasks: [] };
  }
}

export function submitWebAgentResponse(
  sessionId: string,
  taskId: string,
  response: string
): void {
  if (!activeSession || activeSession.id !== sessionId) {
    throw new Error("현재 협업 작업이 아닙니다.");
  }
  const task = findTask(activeSession, taskId);
  if (!isWebTarget(task.target) || task.status !== "waiting_web") {
    throw new Error("응답을 기다리는 웹 AI 작업이 아닙니다.");
  }
  const clean = response.trim();
  if (!clean) {
    throw new Error("웹 AI 응답을 붙여넣어 주세요.");
  }
  rememberedWebAvailability[task.target] = "available";
  activeSession.webAvailability[task.target] = "available";
  task.output = compactWorkerOutput(clean, task.mode);
  task.error = null;
  task.status = "completed";
  const key = webWaiterKey(sessionId, taskId);
  const waiter = webWaiters.get(key);
  webWaiters.delete(key);
  waiter?.resolve();
  dispatchSession(activeSession);
}

export function fallbackWebTaskToCli(
  sessionId: string,
  taskId: string,
  reason = "웹 AI 한도 초과/사용 불가"
): void {
  if (!activeSession || activeSession.id !== sessionId) {
    throw new Error("현재 협업 작업이 아닙니다.");
  }
  const task = findTask(activeSession, taskId);
  if (!isWebTarget(task.target) || task.status !== "waiting_web") {
    throw new Error("CLI로 전환할 수 있는 웹 AI 작업이 아닙니다.");
  }
  const from = task.target;
  markWebAgentLimited(from);
  if (task.fallbackCount >= 1) {
    task.status = "failed";
    task.error = `${reason}; 이미 fallback을 사용했습니다.`;
  } else {
    const fallback = preferredCliFallbackForWeb(from, activeSession.automaticCliTargets);
    if (!fallback) {
      task.status = "failed";
      task.error = `${reason}; 사용 가능한 대체 CLI가 없습니다.`;
    } else {
      task.fallbackCount += 1;
      task.fallbackFrom = from;
      task.fallbackReason = `${from} Web 한도 초과/사용 불가 → ${fallback} CLI로 전환`;
      task.target = fallback;
      task.status = "queued";
      task.error = null;
      task.handoffPrompt = null;
    }
  }
  const key = webWaiterKey(sessionId, taskId);
  const waiter = webWaiters.get(key);
  webWaiters.delete(key);
  waiter?.resolve();
  dispatchSession(activeSession);
}

export function skipWebAgentTask(
  sessionId: string,
  taskId: string,
  reason = "사용자가 웹 AI 작업을 건너뜀"
): void {
  if (!activeSession || activeSession.id !== sessionId) {
    throw new Error("현재 협업 작업이 아닙니다.");
  }
  const task = findTask(activeSession, taskId);
  if (!isWebTarget(task.target) || task.status !== "waiting_web") {
    throw new Error("건너뛸 수 있는 웹 AI 작업이 아닙니다.");
  }
  task.status = "failed";
  task.error = reason;
  const key = webWaiterKey(sessionId, taskId);
  const waiter = webWaiters.get(key);
  webWaiters.delete(key);
  waiter?.resolve();
  dispatchSession(activeSession);
}

function canRetrySynthesis(session: CradleSession): boolean {
  return session.tasks.length > 0 && session.tasks.every((task) =>
    ["completed", "failed", "cancelled"].includes(task.status)
  );
}

async function finishWithSynthesis(
  session: CradleSession,
  preferences: AppPreferences,
  sensitiveAcknowledged: boolean
): Promise<string> {
  ensureNotCancelled(session);
  let synthesis = await synthesize(session, preferences, sensitiveAcknowledged);
  ensureNotCancelled(session);
  if (synthesis.revisionTasks.length > 0 && session.revisionRound === 0) {
    session.revisionRound = 1;
    const revisionTasks = remapRevisionTasks(synthesis.revisionTasks);
    const revisionRawPlan: OrchestrationPlan = {
      summary: "Claude review revision round",
      tasks: revisionTasks,
    };
    const revisionPlan = normalizePlanForAutomaticProviders(
      normalizePlanForWebFirst(revisionRawPlan, session.webAvailability),
      usableAutomaticProviders(automaticProviderStatuses, preferences),
      session.automaticCliTargets,
      session.webAvailability,
      preferences.freeAiFirst
    );
    session.tasks.push(...revisionPlan.tasks.map(stateFromSpec));
    setSessionStatus(session, "running", "Claude 검토 결과에 따라 한 번 더 보완 작업을 실행합니다.");
    await executePlanTasks(session, revisionPlan, preferences, sensitiveAcknowledged);
    ensureNotCancelled(session);
    synthesis = await synthesize(session, preferences, sensitiveAcknowledged);
  }

  session.finalAnswer = withChatNotice(extractUserFacingAnswer(synthesis.finalAnswer) || synthesis.finalAnswer);
  session.error = null;
  setSessionStatus(session, "completed", "협업 작업이 완료되었습니다.");
  return session.finalAnswer;
}

export async function cancelCradleOrchestration(sessionId: string): Promise<void> {
  if (!activeSession || activeSession.id !== sessionId) {
    throw new Error("현재 협업 작업이 아닙니다.");
  }
  if (["completed", "cancelled"].includes(activeSession.status)) {
    return;
  }

  const session = activeSession;
  session.status = "cancelled";
  session.statusMessage = "협업 작업을 중지했습니다.";
  session.managerHandoff = null;
  for (const task of session.tasks) {
    if (["queued", "running", "waiting_web"].includes(task.status)) {
      task.status = "cancelled";
      task.error = "협업 작업이 취소되었습니다.";
    }
  }

  for (const [key, waiter] of [...webWaiters.entries()]) {
    if (key.startsWith(`${session.id}:`)) {
      webWaiters.delete(key);
      waiter.resolve();
    }
  }
  for (const [key, waiter] of [...managerWaiters.entries()]) {
    if (key.startsWith(`${session.id}:manager:`)) {
      managerWaiters.delete(key);
      waiter.reject(new Error("협업 작업이 취소되었습니다."));
    }
  }
  const synthesisWaiter = synthesisWaiters.get(session.id);
  if (synthesisWaiter) {
    synthesisWaiters.delete(session.id);
    synthesisWaiter.reject(new Error("협업 작업이 취소되었습니다."));
  }
  dispatchSession(session);

  const running = [...activeCliTaskIds];
  await Promise.allSettled(running.map((taskId) => cancelAgent(taskId)));
}

export async function retryCradleSynthesis(sessionId: string): Promise<string> {
  if (!activeSession || activeSession.id !== sessionId) {
    throw new Error("현재 협업 작업이 아닙니다.");
  }
  const session = activeSession;
  if (session.status !== "failed" || !canRetrySynthesis(session)) {
    throw new Error("작업 AI들의 결과가 모두 끝난 정리 실패 상태에서만 다시 시도할 수 있습니다.");
  }

  const preferences = await getAppPreferences();
  const sensitiveAcknowledged = await confirmSensitiveAgentAccess(preferences);
  if (!sensitiveAcknowledged) {
    throw new Error("민감 파일 경고에서 Claude 정리 재시도를 취소했습니다.");
  }
  session.error = null;
  holdCradleActivity(session.id);
  try {
    const answer = await finishWithSynthesis(session, preferences, sensitiveAcknowledged);
    const waiter = synthesisWaiters.get(session.id);
    if (waiter) {
      synthesisWaiters.delete(session.id);
      waiter.resolve(answer);
    }
    return answer;
  } catch (error) {
    session.error = error instanceof Error ? error.message : String(error);
    setSessionStatus(session, "failed", "Claude 최종 정리에 실패했습니다. 정리만 다시 시도할 수 있습니다.");
    throw error;
  } finally {
    releaseCradleActivity(session.id);
  }
}

const cradleActivityHeld = new Set<string>();

function holdCradleActivity(sessionId: string): void {
  if (!cradleActivityHeld.has(sessionId)) {
    cradleActivityHeld.add(sessionId);
    void setCradleActivity(true);
  }
}

function releaseCradleActivity(sessionId: string): void {
  if (cradleActivityHeld.delete(sessionId)) {
    void setCradleActivity(false);
  }
}

function sessionPlaceholderPrompt(prompt: string): string {
  return prompt.trim();
}

export async function runCradleOrchestration(
  originalPrompt: string,
  conversationId?: string | null,
  conversationContext = ""
): Promise<string> {
  if (activeSession && !["completed", "failed", "cancelled"].includes(activeSession.status)) {
    throw new Error("이미 협업 작업이 진행 중입니다. 현재 작업을 완료한 뒤 다시 시도해주세요.");
  }
  const staleWaiter = activeSession ? synthesisWaiters.get(activeSession.id) : undefined;
  if (activeSession && staleWaiter) {
    synthesisWaiters.delete(activeSession.id);
    staleWaiter.reject(new Error("새 협업 작업이 시작되어 이전 정리 재시도를 종료했습니다."));
  }

  const preferences = await getAppPreferences();
  const sensitiveAcknowledged = await confirmSensitiveAgentAccess(preferences);
  if (!sensitiveAcknowledged) {
    throw new Error("민감 파일 경고에서 협업 작업 실행을 취소했습니다.");
  }

  if (conversationId) {
    try {
      await prepareCradleEnvironment(conversationId);
    } catch (error) {
      // Do not kill analysis-only sessions when Git is missing. CLI modify
      // workers will be automatically rerouted if their environment cannot run.
      console.warn("CRADLE 환경 사전 준비 경고:", error);
    }
  }

  // Programs over their subscription limit sit this session out; the free AIs take their tasks.
  const automaticCliTargets = (await detectAutomaticTargets()).filter((target) => !limitedUntil(target));
  try {
    automaticProviderStatuses = await getAutomaticProviderStatuses();
  } catch {
    automaticProviderStatuses = [];
  }
  const session: CradleSession = {
    id: createSessionId(),
    conversationId: conversationId ?? null,
    originalPrompt: extractCurrentUserRequest(originalPrompt.trim()),
    planSummary: "",
    tasks: [],
    status: "planning",
    statusMessage: "AI 연결 상태를 확인하고 협업 계획을 준비합니다.",
    revisionRound: 0,
    finalAnswer: null,
    error: null,
    managerHandoff: null,
    webAvailability: { ...rememberedWebAvailability },
    automaticCliTargets,
    webResearch: {
      status: "skipped",
      query: sessionPlaceholderPrompt(originalPrompt),
      provider: null,
      sourceUrls: [],
      researchPromptBlock: "",
      error: null,
    },
  };
  activeSession = session;
  dispatchSession(session);
  holdCradleActivity(session.id);

  try {
    if (preferences.autoWebSearch) {
      setSessionStatus(session, "planning", "백그라운드 웹 검색 필요 여부를 확인합니다.");
    }
    session.webResearch = await collectWebResearch(
      session.originalPrompt,
      preferences.autoWebSearch
    );
    const researchPromptBlock = session.webResearch.researchPromptBlock;
    if (session.webResearch.status === "ready") {
      setSessionStatus(session, "planning", "웹 자료를 준비했습니다. 총괄 AI에게 계획을 요청합니다.");
    } else if (session.webResearch.status === "failed") {
      setSessionStatus(session, "planning", "웹 검색에 실패했습니다. 기존 협업 흐름으로 계속합니다.");
    }

    const automaticApiTargets = usableAutomaticProviders(automaticProviderStatuses, preferences);
    const rawPlan = await runAutomaticManager(
      session,
      "planning",
      createPlanningPrompt(
        session.originalPrompt,
        automaticCliTargets,
        researchPromptBlock,
        automaticApiTargets,
        compactText(conversationContext, 2_400)
      ),
      preferences,
      sensitiveAcknowledged
    );
    const parsedPlan = parseOrchestrationPlan(rawPlan);
    const plan = normalizePlanForAutomaticProviders(
      normalizePlanForWebFirst(parsedPlan, session.webAvailability),
      automaticApiTargets,
      automaticCliTargets,
      session.webAvailability,
      preferences.freeAiFirst
    );
    session.planSummary = plan.summary;
    session.tasks = plan.tasks.map(stateFromSpec);
    setSessionStatus(session, "running", "협업 계획을 검증했습니다. 무료 AI를 우선해 각 AI 작업을 시작합니다.");

    await executePlanTasks(session, plan, preferences, sensitiveAcknowledged);

    try {
      return await finishWithSynthesis(session, preferences, sensitiveAcknowledged);
    } catch (error) {
      if (session.status === "cancelled") {
        throw error;
      }
      session.error = error instanceof Error ? error.message : String(error);
      setSessionStatus(session, "failed", "Claude 최종 정리에 실패했습니다. 정리만 다시 시도할 수 있습니다.");
      releaseCradleActivity(session.id);
      return await new Promise<string>((resolve, reject) => {
        synthesisWaiters.set(session.id, { resolve, reject });
      });
    }
  } catch (error) {
    if (session.status === "cancelled") {
      session.error = "협업 작업이 취소되었습니다.";
      dispatchSession(session);
      throw new Error(session.error);
    }
    session.error = error instanceof Error ? error.message : String(error);
    setSessionStatus(session, "failed", "협업 작업 실행 중 오류가 발생했습니다.");
    throw error;
  } finally {
    for (const key of [...webWaiters.keys()]) {
      if (key.startsWith(`${session.id}:`)) {
        webWaiters.delete(key);
      }
    }
    for (const key of [...managerWaiters.keys()]) {
      if (key.startsWith(`${session.id}:manager:`)) {
        managerWaiters.delete(key);
      }
    }
    synthesisWaiters.delete(session.id);
    releaseCradleActivity(session.id);
  }
}

/** A line for the work log and progress bar about where CRADLE sent a task. */
function reportWork(agent: string, text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<WorkActivityEvent>(WORK_ACTIVITY_EVENT, { detail: { agent, text } }));
}

let pendingChatNotice = "";

function withChatNotice(text: string): string {
  const notice = pendingChatNotice.trim();
  pendingChatNotice = "";
  if (!notice) {
    return text;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("ai-character:limit-notice", { detail: notice }));
  }
  if (text.startsWith(notice)) {
    return text;
  }
  return `${notice}\n\n${text}`;
}

function composeDirectPrompt(
  prompt: string,
  conversationContext: string,
  researchBlock: string,
  mode: "chat" | "facts",
  answerOnly = false
): string {
  const role = mode === "facts"
    ? "You answer a factual question. Use the research block when it is present. Do not invent numbers, dates, or prices. Say what you could not verify."
    : "You are the assistant in the AI Character desktop app, answering this chat. Answer the user directly in their language.";
  return [
    role,
    personaInstruction(),
    "Do not pretend to be another model. Do not create an orchestration plan, worker list, or CRADLE handoff.",
    answerOnly
      ? "The user chose chat mode: do not create, edit or delete any files. Answer in the reply only."
      : "Do not edit files unless the user asked for a file change.",
    conversationContext ? `Recent conversation (compact):\n${compactText(conversationContext, 2_400)}` : "",
    researchBlock,
    "USER REQUEST:",
    prompt,
  ].filter(Boolean).join("\n\n");
}

async function answerDirectly(
  prompt: string,
  conversationId: string | null | undefined,
  conversationContext: string,
  researchBlock = "",
  streamId: string | null = null,
  mode: "chat" | "facts" = "chat",
  choice: ModelChoice | null = null,
  /** "file" when the request is program work but CRADLE is off: the progress and apply screens
   * show. "answer-only": the user picked 💬 채팅, so no files are touched. */
  runKind: "chat" | "file" | "answer-only" = "chat"
): Promise<string> {
  pendingChatNotice = "";
  const preferences = await getAppPreferences();
  try {
    automaticProviderStatuses = await getAutomaticProviderStatuses();
  } catch {
    automaticProviderStatuses = [];
  }
  const composed = composeDirectPrompt(prompt, conversationContext, researchBlock, mode, runKind === "answer-only")
    + (runKind === "file" ? `

${LONG_COMMAND_RULE}` : "");
  const agentKind = runKind === "file" ? "file" : "chat";
  const apis = usableAutomaticProviders(automaticProviderStatuses, preferences);
  const context: AutomaticCallContext = { sessionId: conversationId ?? null, role: mode === "facts" ? "researcher" : "chat" };
  const freeApis = apis.filter(isFreeAutomaticProvider);
  const paidApis = apis.filter((api) => !isFreeAutomaticProvider(api));
  const blocked = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("취소") || message.includes("민감 파일");
  };
  // The program picked in the chat menu for this conversation (else 기본 프로그램 in settings)
  // answers first; its name is used in notices.
  // A program over its subscription limit is skipped until it resets: the other program
  // answers, or the free AIs when both are over.
  const picked = choice?.agent ?? preferences.defaultAgent;
  const otherProgram: AgentKind = picked === "claude" ? "codex" : "claude";
  const pickedUntil = limitedUntil(picked);
  const otherUntil = limitedUntil(otherProgram);
  const primary: AgentKind = pickedUntil && !otherUntil ? otherProgram : picked;
  const primaryModel = primary === picked ? choice?.model || null : null;
  const primaryName = agentLabel(primary);
  if (pickedUntil && !otherUntil) {
    reportWork("구독 한도", `${agentLabel(picked)} 사용량 초과 — ${formatResumeTime(pickedUntil)}까지 ${primaryName}가 대신 답합니다`);
  }
  if (pickedUntil && otherUntil) {
    reportWork("구독 한도", `${agentLabel(picked)}·${agentLabel(otherProgram)} 모두 사용량 초과 — 무료 AI가 먼저 답합니다`);
    const free = await tryAutomaticProviders(freeApis, composed, { ...context, streamId }, "구독 사용량 초과로 무료 AI가 답변");
    if (free) {
      pendingChatNotice = `구독 프로그램 사용량을 다 써서 무료 AI가 답했습니다. ${formatResumeTime(Math.min(pickedUntil, otherUntil))}부터 다시 구독 프로그램을 씁니다.`;
      return withChatNotice(free.response);
    }
  }

  // 무료 AI 먼저 쓰기 (off by default): facts go to the free AIs before the subscribed program.
  // Otherwise every question takes the path below: the picked program, then the other
  // subscribed program, and free AIs only as the last fallback.
  if (mode === "facts" && preferences.freeAiFirst) {
    const free = await tryAutomaticProviders(freeApis, composed, { ...context, streamId }, "정보 조사");
    if (free) {
      return free.response;
    }
    try {
      const text = await askAgentCompat(primary, composed, conversationId, primaryModel, agentKind);
      pendingChatNotice = `무료 AI로 정보를 확인하지 못해 ${primaryName}가 답했습니다.`;
      return withChatNotice(text);
    } catch (error) {
      if (blocked(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      if (isQuotaOrLimitError(error)) {
        pendingChatNotice = `${primaryName} 사용량을 다 썼습니다.`;
      }
    }
    if (!pendingChatNotice) {
      pendingChatNotice = `무료 AI와 ${primaryName}로 정보를 확인하지 못했습니다.`;
    }
    const paid = await tryAutomaticProviders(paidApis, composed, context, `무료 AI와 ${primaryName}를 쓸 수 없어 유료 API로 답변`);
    if (paid) {
      return withChatNotice(paid.response);
    }
    throw new Error(withChatNotice(pendingChatNotice || "무료 AI로 정보를 확인하지 못했습니다. 잠시 뒤 다시 보내세요."));
  }

  try {
    return await askAgentCompat(primary, composed, conversationId, primaryModel, agentKind);
  } catch (error) {
    // File work that ran out of time: its changes are still in the work copy, so it resumes once.
    if (agentKind === "file" && isTimeoutError(error)) {
      reportWork(primaryName, "⏱ 시간 제한에 걸려 멈췄습니다. 고친 내용은 그대로 두고 남은 부분만 이어서 합니다");
      try {
        return await askAgentCompat(primary, `${composed}\n\n${RESUME_AFTER_TIMEOUT}`, conversationId, primaryModel, agentKind);
      } catch (resumeError) {
        throw new Error(
          `${isTimeoutError(resumeError) ? "시간 제한에 두 번 걸려" : "이어서 하던 중 오류가 나서"} 작업을 일부만 끝냈습니다. ` +
          "지금까지 고친 내용은 변경 검토 화면에 있으니 확인한 뒤 적용하고, 남은 부분은 나눠서 다시 요청해 주세요."
        );
      }
    }
    if (blocked(error)) {
      throw error instanceof Error ? error : new Error(error instanceof Error ? error.message : String(error));
    }
    const backup: AgentKind = primary === "claude" ? "codex" : "claude";
    const backupUsable = !limitedUntil(backup);
    if (needsLocalFiles(prompt) && backupUsable) {
      // Web-only AIs cannot see the work folder and would only ask the user to paste files,
      // so a file question goes to the other program that runs inside the folder.
      const primaryReason = isQuotaOrLimitError(error) ? "사용량을 다 썼습니다" : "응답하지 못했습니다";
      try {
        const text = await askAgentCompat(backup, composed, conversationId);
        pendingChatNotice = `${primaryName}가 ${primaryReason}. 이 답은 ${agentLabel(backup)}가 작업 폴더를 보고 이어받았습니다.`;
        return withChatNotice(text);
      } catch (claudeError) {
        if (blocked(claudeError)) {
          throw claudeError instanceof Error ? claudeError : new Error(String(claudeError));
        }
        const detail = (value: unknown) => compactText(value instanceof Error ? value.message : String(value), 300);
        throw new Error(
          `작업 폴더를 볼 수 있는 AI가 지금 답하지 못해 폴더 내용을 확인하지 못했습니다.
` +
          `· ${primaryName}: ${detail(error)}
· ${agentLabel(backup)}: ${detail(claudeError)}
` +
          "설정 → 프로그램 · 로그인에서 두 프로그램의 로그인 상태를 확인해 주세요."
        );
      }
    }
    if (!preferences.freeAiFirst && backupUsable) {
      try {
        const text = await askAgentCompat(backup, composed, conversationId, null, agentKind);
        pendingChatNotice = `${primaryName}가 ${isQuotaOrLimitError(error) ? "사용량을 다 썼습니다" : "응답하지 못했습니다"}. 이 답은 ${agentLabel(backup)}가 이어받았습니다.`;
        return withChatNotice(text);
      } catch (backupError) {
        if (blocked(backupError)) {
          throw backupError instanceof Error ? backupError : new Error(String(backupError));
        }
      }
    }
    pendingChatNotice = isQuotaOrLimitError(error)
      ? `${primaryName} 사용량을 다 썼습니다. 이 답은 무료 AI가 이어받았습니다.`
      : `${primaryName}로 답하지 못했습니다. 이 답은 무료 AI가 이어받았습니다.`;
    const free = await tryAutomaticProviders(
      freeApis,
      composed,
      { ...context, streamId },
      pendingChatNotice
    );
    if (free) {
      return withChatNotice(free.response);
    }
    const paid = await tryAutomaticProviders(
      paidApis,
      composed,
      context,
      `${primaryName}와 무료 AI를 쓸 수 없어 유료 API로 답변`
    );
    if (paid) {
      return withChatNotice(paid.response);
    }
    throw new Error(isQuotaOrLimitError(error)
      ? `${primaryName} 사용량을 다 썼고, 무료 AI도 지금은 답하지 못합니다. 한도가 초기화된 뒤 다시 보내세요.`
      : (error instanceof Error ? error.message : String(error)));
  }
}

/** How a request was routed, for the note under the answer. */
export type RouteDecision = { intent: RequestIntent; decidedBy: "words" | "ai" | "user" };

/**
 * When the words leave it open ("이 부분 제대로 고쳐"), a free AI answers one word: is this a
 * change to the program/files or a chat question? No answer within a few seconds: chat.
 */
async function askAiForIntent(
  current: string,
  history: string,
  conversationId: string | null | undefined
): Promise<RequestIntent | null> {
  const preferences = await getAppPreferences();
  let statuses: AutomaticProviderStatus[] = [];
  try {
    statuses = await getAutomaticProviderStatuses();
  } catch {
    return null;
  }
  const free = usableAutomaticProviders(statuses, preferences).filter(isFreeAutomaticProvider);
  if (!free.length) return null;
  const question = [
    "Classify the user's latest message in a desktop coding assistant.",
    "PROGRAM = they want files, code or the program in their work folder created, changed, fixed or run.",
    "CHAT = a question, explanation, or text to write or edit in the reply itself.",
    "Answer with exactly one word: PROGRAM or CHAT.",
    history ? `Recent conversation:\n${compactText(history, 1_200)}` : "",
    `Latest message:\n${compactText(current, 1_200)}`,
  ].filter(Boolean).join("\n\n");
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 6_000));
  const answer = await Promise.race([
    tryAutomaticProviders(free.slice(0, 2), question, { sessionId: conversationId ?? null, role: "chat" }, "요청 종류 판단"),
    timeout,
  ]);
  const word = answer?.response.trim().toUpperCase() ?? "";
  if (word.startsWith("PROGRAM")) return "project";
  if (word.startsWith("CHAT")) return "chat";
  return null;
}

async function routeRequest(
  current: string,
  history: string,
  conversationId: string | null | undefined,
  mode: RequestMode
): Promise<RouteDecision> {
  const judged = judgeRequestIntent(current, history);
  if (mode === "program") return { intent: "project", decidedBy: "user" };
  if (mode === "chat") {
    return { intent: judged.intent === "project" ? "chat" : judged.intent, decidedBy: "user" };
  }
  if (judged.sure) return { intent: judged.intent, decidedBy: "words" };
  // The conversation already has file changes waiting: "고쳐" is about those files.
  if (conversationId) {
    const pending = await getWorkspaceChanges(conversationId).catch(() => []);
    if (pending.length) return { intent: "project", decidedBy: "words" };
  }
  const byAi = await askAiForIntent(current, history, conversationId).catch(() => null);
  return byAi ? { intent: byAi, decidedBy: "ai" } : { intent: judged.intent, decidedBy: "words" };
}

export async function askCradleCompat(
  prompt: string,
  conversationId?: string | null,
  conversationContext = "",
  streamId: string | null = null,
  /** The program and model picked in the chat menu for this conversation. */
  choice: ModelChoice | null = null,
  /** 🤖 AI 모드 / 💬 채팅 / 🛠 프로그램 from the chat's mode button. */
  mode: RequestMode = "auto",
  onRouted?: (decision: RouteDecision) => void
): Promise<string> {
  const preferences = await getAppPreferences();
  const current = extractCurrentUserRequest(prompt);
  const history = compactText(conversationContext.trim(), 2_400);

  const decision = await routeRequest(current, history, conversationId, mode);
  onRouted?.(decision);
  const intent = decision.intent;
  const runKind = intent === "project" ? "file" : mode === "chat" ? "answer-only" : "chat";

  if (!preferences.cradleEnabled) {
    return answerDirectly(current, conversationId, history, "", streamId, "chat", choice, runKind);
  }

  if (intent === "chat" || intent === "research") {
    let researchBlock = "";
    if (intent === "research" && preferences.autoWebSearch) {
      const research = await collectWebResearch(current, true);
      researchBlock = research.researchPromptBlock;
    }
    return answerDirectly(current, conversationId, history, researchBlock, streamId, intent === "research" ? "facts" : "chat", choice, runKind);
  }

  return runCradleOrchestration(current, conversationId, history);
}

/**
 * 이 작업 건너뛰기: stops the program working on one task. What it changed so far is kept for
 * review, and the session goes on with the next tasks.
 */
export async function skipCradleTask(taskId: string): Promise<void> {
  const task = activeSession?.tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.status !== "running" || !task.workerTaskId) {
    throw new Error("지금 실행 중인 작업만 건너뛸 수 있습니다.");
  }
  task.skipRequested = true;
  reportWork(agentLabel(task.target), `⏭ 사용자가 건너뜀: ${task.title}`);
  await cancelAgent(task.workerTaskId);
}

export function getActiveCradleSession(): CradleSession | null {
  return activeSession ? cloneSession(activeSession) : null;
}
