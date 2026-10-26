import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { safeConfirm } from "./safe-confirm";
import { isUsageLimitMessage, noteRunFailure, noteRunSuccess } from "./subscription-limits";
import { setWorkLogStatus, setWorkLogTechnical } from "./work-log-store";

export type AgentKind =
  | "claude"
  | "codex"
  | "cursor"
  | "antigravity";

/** The one place the programs are named in the UI. */
export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "ChatGPT (Codex)",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

/** Name for any program id, including ones read from stored rows. */
export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent as AgentKind] ?? agent;
}

/** Name without the bracketed detail, for tight spots like the chat toolbar. */
export function agentShortLabel(agent: string): string {
  return agentLabel(agent).replace(/ \(.*\)$/, "");
}

export type RunAgentOptions = {
  agent: AgentKind;
  prompt: string;
  workingDir?: string | null;
  conversationId?: string | null;
  timeoutSeconds?: number;
  sensitiveAcknowledged?: boolean;
  emitRuntimeEvents?: boolean;
  kind?: "chat" | "file";
  /** Model to run instead of the one in settings; "" or omitted keeps the settings. */
  model?: string | null;
  onStream?: (event: AgentStreamEvent) => void;
};

/** The program and model picked in the chat's menu for the conversation being answered. */
export type ModelChoice = { agent: AgentKind; model: string };

export type AgentModel = { id: string; label: string; note: string };

/** Models the program can run, read from the program itself (cached for ten minutes). */
export async function listAgentModels(agent: AgentKind, refresh = false): Promise<AgentModel[]> {
  return invoke<AgentModel[]>("list_agent_models", { agent, refresh });
}

export type AppPreferences = {
  defaultAgent: AgentKind;
  cradleEnabled: boolean;
  autoWebSearch: boolean;
  geminiApiEnabled: boolean;
  /** Free AIs (Gemini) before the subscribed programs. Off: ChatGPT and Claude answer first,
   * free AIs are the last fallback. */
  freeAiFirst: boolean;
  allowPaidOpenAiApi: boolean;
  closeWebAccountAfterHandoff: boolean;
  closeWebAccountWhenCradleDone: boolean;
  timeoutSeconds: number;
  warnSensitiveFiles: boolean;
  agentExtraArgs: Partial<Record<AgentKind, string[]>>;
  agentModels: Partial<Record<AgentKind, string>>;
  agentModelPresets: Partial<Record<AgentKind, string[]>>;
};

export type AgentTask = {
  taskId: string;
  result: Promise<string>;
};

export type AgentStreamEvent = {
  taskId: string;
  /** "activity" is one line on what the program is doing now, for the work log. */
  stream: "stdout" | "stderr" | "activity";
  text: string;
};

/** One line on what a running program is doing ("📄 읽는 중: main.py"), from any run. */
export const WORK_ACTIVITY_EVENT = "ai-character:work-activity";
/** `agent`: a program id, or a plain name such as "자동 AI" for CRADLE's other workers. */
export type WorkActivityEvent = { agent: string; text: string };

export type AgentTaskStartEvent = {
  taskId: string;
  agent: AgentKind;
  conversationId: string | null;
  kind: "chat" | "file";
};

export type AgentTaskEndEvent = {
  taskId: string;
  agent: AgentKind;
  conversationId: string | null;
  status: "completed" | "cancelled" | "failed";
  kind?: "chat" | "file";
  userMessage?: string;
  error?: string;
};

export type WorkspaceChangeKind = "added" | "modified" | "deleted";

export type WorkspaceChange = {
  path: string;
  kind: WorkspaceChangeKind;
  binary: boolean;
  originalSize: number;
  workspaceSize: number;
  conflict: boolean;
  conflictReason: string | null;
};

export type ApplyWorkspaceResult = {
  checkpointId: string;
  appliedCount: number;
};

export type AgentRunStatus = "running" | "completed" | "cancelled" | "failed";

export type AgentRunRecord = {
  id: number;
  taskId: string;
  conversationId: string | null;
  agent: AgentKind;
  model: string | null;
  status: AgentRunStatus;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  errorSummary: string | null;
  errorDetail: string | null;
};

export type CheckpointRecord = {
  id: string;
  createdAt: number;
  conversationId: string | null;
  changedCount: number;
  purpose: "apply" | "restore_safety" | string;
};

export type RestoreCheckpointResult = {
  restoredCheckpointId: string;
  safetyCheckpointId: string;
  restoredCount: number;
};

export type CradleEnvironmentStatus = {
  gitInstalled: boolean;
  gitVersion: string | null;
  gitPath: string | null;
  workspaceGitReady: boolean;
  workspacePath: string | null;
  installSupported: boolean;
  installHint: string;
  message: string;
};

export type FreeAutoReadiness = {
  geminiApiConfigured: boolean;
  openrouterApiConfigured: boolean;
  jinaApiConfigured: boolean;
  claudeCliReady: boolean;
  cradleEnabled: boolean;
  autoWebSearch: boolean;
  geminiApiEnabled: boolean;
  handsFreeReady: boolean;
  keysEnvPath: string | null;
  message: string;
  nextSteps: string[];
};


function createTaskId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function userFacingAgentError(message: string): string {
  const lower = message.toLowerCase();
  if (isUsageLimitMessage(message)) {
    // Keeps "사용량 초과" so callers can tell a limit from other failures.
    return "AI 프로그램 구독 사용량 초과입니다. 한도가 풀릴 때까지 다른 AI가 대신 답하고, 풀리면 다시 이 프로그램을 씁니다.";
  }
  if (message.includes("CLI를 찾을 수 없습니다") || message.includes("실행 파일을 찾을 수 없습니다") || lower.includes("enoent")) {
    return "선택한 AI 프로그램를 찾을 수 없습니다. 설정에서 설치 상태와 실행 파일 경로를 확인해주세요.";
  }
  if (message.includes("시간을 초과") || message.includes("제한을 초과") || lower.includes("timeout") || lower.includes("timed out")) {
    return "AI 프로그램 실행 시간이 설정된 제한을 초과했습니다. 제한 시간을 늘리거나 작업을 나눠서 다시 시도해주세요.";
  }
  if (message.includes("프로젝트 폴더") || lower.includes("working directory")) {
    return "프로젝트 폴더를 사용할 수 없습니다. 설정에서 프로젝트 경로와 접근 권한을 확인해주세요.";
  }
  if (message.includes("권한") || lower.includes("permission denied") || lower.includes("eacces")) {
    return "파일 또는 실행 파일에 접근할 권한이 없습니다. macOS/Windows 권한과 파일 권한을 확인해주세요.";
  }
  if (message.includes("민감 파일 경고")) {
    return "민감 파일 확인이 필요해 AI 프로그램 실행을 시작하지 않았습니다.";
  }
  if (message.includes("취소") || lower.includes("cancel")) {
    return "AI 프로그램 실행이 취소되었습니다.";
  }
  return "AI 프로그램 실행 중 오류가 발생했습니다. 기술 로그에서 상세 내용을 확인해주세요.";
}

export async function getProjectDirectory(): Promise<string | null> {
  return invoke<string | null>("get_project_dir");
}

export async function chooseProjectDirectory(): Promise<string> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "프로젝트 폴더 선택",
  });

  if (!selected || Array.isArray(selected)) {
    throw new Error("프로젝트 폴더 선택이 취소되었습니다.");
  }

  return setProjectDirectory(selected);
}

export type ConversationDir = {
  /** The folder this conversation works in: its own, or the default one. */
  path: string | null;
  /** True when the conversation picked its own folder. */
  custom: boolean;
  defaultPath: string | null;
  recent: string[];
};

export const CONVERSATION_DIR_EVENT = "ai-character:conversation-dir-changed";

export async function getConversationDir(conversationId: string | null): Promise<ConversationDir> {
  return invoke<ConversationDir>("get_conversation_dir", { conversationId });
}

/** `path: null` makes the conversation follow the default folder again. */
export async function setConversationDir(conversationId: string, path: string | null): Promise<ConversationDir> {
  const status = await invoke<ConversationDir>("set_conversation_dir", { conversationId, path });
  window.dispatchEvent(new CustomEvent(CONVERSATION_DIR_EVENT, { detail: { conversationId, status } }));
  return status;
}

export async function chooseConversationDirectory(conversationId: string): Promise<string> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "이 대화의 작업 폴더 선택",
  });
  if (!selected || Array.isArray(selected)) {
    throw new Error("작업 폴더 선택이 취소되었습니다.");
  }
  const status = await setConversationDir(conversationId, selected);
  return status.path ?? selected;
}

export async function ensureProjectDirectory(conversationId?: string | null): Promise<string> {
  if (conversationId) {
    const status = await getConversationDir(conversationId);
    return status.path ?? chooseConversationDirectory(conversationId);
  }
  const saved = await getProjectDirectory();
  if (saved) {
    return saved;
  }
  return chooseProjectDirectory();
}

export async function setProjectDirectory(path: string): Promise<string> {
  const saved = await invoke<string>("set_project_dir", { path });
  window.dispatchEvent(new CustomEvent(CONVERSATION_DIR_EVENT, { detail: { conversationId: null } }));
  return saved;
}

export async function detectAgent(agent: AgentKind): Promise<string> {
  return invoke<string>("detect_agent", { agent });
}

export type AgentRuntimePaths = {
  cli: string | null;
  app: string | null;
};

export async function detectAgentRuntime(
  agent: AgentKind
): Promise<AgentRuntimePaths> {
  return invoke<AgentRuntimePaths>("detect_agent_runtime", { agent });
}

export async function getAppPreferences(): Promise<AppPreferences> {
  return invoke<AppPreferences>("get_app_preferences");
}

export function resetRecommendedSettings(): Promise<string> {
  return invoke<string>("reset_recommended_settings");
}

export async function setAppPreferences(
  preferences: AppPreferences
): Promise<AppPreferences> {
  return invoke<AppPreferences>("set_app_preferences", {
    defaultAgent: preferences.defaultAgent,
    timeoutSeconds: preferences.timeoutSeconds,
    warnSensitiveFiles: preferences.warnSensitiveFiles,
    cradleEnabled: preferences.cradleEnabled,
    autoWebSearch: preferences.autoWebSearch,
    geminiApiEnabled: preferences.geminiApiEnabled,
    allowPaidOpenAiApi: preferences.allowPaidOpenAiApi,
    closeWebAccountAfterHandoff: preferences.closeWebAccountAfterHandoff,
    closeWebAccountWhenCradleDone: preferences.closeWebAccountWhenCradleDone,
    agentExtraArgs: preferences.agentExtraArgs,
    agentModels: preferences.agentModels,
    agentModelPresets: preferences.agentModelPresets,
    freeAiFirst: preferences.freeAiFirst,
  });
}


export async function getAgentRuns(limit = 30): Promise<AgentRunRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return invoke<AgentRunRecord[]>("list_agent_runs", { limit: safeLimit });
}

export async function getProjectCheckpoints(limit = 30): Promise<CheckpointRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return invoke<CheckpointRecord[]>("list_checkpoints", { limit: safeLimit });
}

export async function restoreProjectCheckpoint(
  checkpointId: string
): Promise<RestoreCheckpointResult> {
  return invoke<RestoreCheckpointResult>("restore_checkpoint", { checkpointId });
}

export async function getSensitiveFiles(): Promise<string[]> {
  return invoke<string[]>("get_sensitive_files");
}

export async function getCradleEnvironmentStatus(
  conversationId?: string | null
): Promise<CradleEnvironmentStatus> {
  return invoke<CradleEnvironmentStatus>("get_cradle_environment_status", {
    conversationId: conversationId ?? null,
  });
}

export async function getFreeAutoReadiness(): Promise<FreeAutoReadiness> {
  return invoke<FreeAutoReadiness>("get_free_auto_readiness");
}

export async function openKeysEnvFile(): Promise<string> {
  return invoke<string>("open_keys_env_file");
}

export async function openUsageDashboard(): Promise<string> {
  return invoke<string>("open_usage_dashboard");
}

export type AgentLogin = {
  id: AgentKind;
  /** null when this program gives no reliable way to check. */
  loggedIn: boolean | null;
  account: string | null;
  detail: string;
};

/** Reuses an answer from the last minute unless `force` (the CLIs can take seconds to answer). */
export async function getAgentLogins(force = false): Promise<AgentLogin[]> {
  return invoke<AgentLogin[]>("get_agent_logins", { force });
}

/** The last answer however old, or null before the first check; returns at once. */
export async function getLastAgentLogins(): Promise<AgentLogin[] | null> {
  return invoke<AgentLogin[] | null>("get_last_agent_logins");
}

export async function getUsageSnapshot(): Promise<unknown> {
  return invoke("get_usage_snapshot");
}

export async function ensureKeysEnvFile(): Promise<string> {
  return invoke<string>("ensure_keys_env_file");
}

export async function prepareCradleEnvironment(
  conversationId?: string | null
): Promise<CradleEnvironmentStatus> {
  return invoke<CradleEnvironmentStatus>("prepare_cradle_environment", {
    conversationId: conversationId ?? null,
  });
}

export async function launchGitInstaller(): Promise<void> {
  return invoke<void>("launch_git_installer");
}

export type RuntimeComponentStatus = {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
  canAutoInstall: boolean;
};

export type RuntimeSetupStatus = {
  platform: string;
  components: RuntimeComponentStatus[];
  allReady: boolean;
  message: string;
};

export type InstallStepResult = {
  id: string;
  ok: boolean;
  message: string;
};

export async function getRuntimeSetupStatus(): Promise<RuntimeSetupStatus> {
  return invoke<RuntimeSetupStatus>("get_runtime_setup_status");
}

export async function installWindowsRuntimes(): Promise<InstallStepResult[]> {
  return invoke<InstallStepResult[]>("install_windows_runtimes");
}

export async function installAgentCli(
  agent: AgentKind
): Promise<InstallStepResult> {
  return invoke<InstallStepResult>("install_agent_cli", { agent });
}

export async function installAllRequiredRuntimes(): Promise<
  InstallStepResult[]
> {
  return invoke<InstallStepResult[]>("install_all_required_runtimes");
}

export async function launchAgentLogin(agent: AgentKind): Promise<string> {
  return invoke<string>("launch_agent_login", { agent });
}

export async function launchGithubLogin(): Promise<string> {
  return invoke<string>("launch_github_login");
}

export type ClaudePlugin = {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  description: string;
  installed: boolean;
  enabled: boolean;
  source: string;
};

export type ClaudePluginSnapshot = {
  claudeReady: boolean;
  marketplaceReady: boolean;
  claudePath: string;
  message: string;
  marketplaces: string[];
  installed: ClaudePlugin[];
  available: ClaudePlugin[];
};

export async function getClaudePlugins(
  live = false
): Promise<ClaudePluginSnapshot> {
  return invoke<ClaudePluginSnapshot>("get_claude_plugins", { live });
}

export async function addClaudePluginMarketplace(
  source: string
): Promise<string> {
  return invoke<string>("add_claude_plugin_marketplace", { source });
}

export async function installClaudePlugin(spec: string): Promise<string> {
  return invoke<string>("install_claude_plugin", { spec });
}

export async function setClaudePluginEnabled(
  spec: string,
  enabled: boolean
): Promise<string> {
  return invoke<string>("set_claude_plugin_enabled", { spec, enabled });
}

export async function uninstallClaudePlugin(spec: string): Promise<string> {
  return invoke<string>("uninstall_claude_plugin", { spec });
}

export async function openClaudePluginCatalog(
  kind: "catalog" | "repo" = "catalog"
): Promise<string> {
  return invoke<string>("open_claude_plugin_catalog", { kind });
}

export async function setAgentPath(
  agent: AgentKind,
  path: string
): Promise<string> {
  return invoke<string>("set_agent_path", { agent, path });
}

export async function chooseAgentExecutable(agent: AgentKind): Promise<string> {
  const selected = await open({
    directory: false,
    multiple: false,
    title: `${agent} 실행 파일 선택`,
  });
  if (!selected || Array.isArray(selected)) {
    throw new Error("실행 파일 선택이 취소되었습니다.");
  }
  return setAgentPath(agent, selected);
}

export function runAgentTask(options: RunAgentOptions): AgentTask {
  const taskId = createTaskId();
  const result = (async () => {
    let unlisten: UnlistenFn | null = null;

    try {
      unlisten = await listen<AgentStreamEvent>("agent-stream", (event) => {
        if (event.payload.taskId !== taskId) {
          return;
        }
        options.onStream?.(event.payload);
        // What a program is doing is shown for every run, including CRADLE's planner and
        // workers, which keep their other output to their own screen.
        if (event.payload.stream === "activity") {
          window.dispatchEvent(
            new CustomEvent<WorkActivityEvent>(WORK_ACTIVITY_EVENT, {
              detail: { agent: options.agent, text: event.payload.text.trim() },
            })
          );
          return;
        }
        // A CRADLE worker's own output stays on its screen; programs that do not report steps
        // (Codex, Cursor) still show their latest line as what they are doing.
        if (options.emitRuntimeEvents === false && event.payload.stream === "stdout" && options.agent !== "claude") {
          const last = event.payload.text.split("\n").map((line) => line.trim()).filter(Boolean).pop();
          // JSON is a worker's machine-readable result, not a step to show.
          if (last && !/^[{[]/.test(last)) {
            window.dispatchEvent(
              new CustomEvent<WorkActivityEvent>(WORK_ACTIVITY_EVENT, {
                detail: { agent: options.agent, text: last.length > 120 ? `${last.slice(0, 120)}…` : last },
              })
            );
          }
        }
        if (options.emitRuntimeEvents !== false) {
          window.dispatchEvent(
            new CustomEvent("ai-character:agent-stream", { detail: event.payload })
          );
        }
      });
    } catch (error) {
      console.warn("Agent 스트림 이벤트 연결 실패:", error);
    }

    try {
      const projectDir =
        options.workingDir ?? await ensureProjectDirectory(options.conversationId);

      const startDetail: AgentTaskStartEvent = {
        taskId,
        agent: options.agent,
        conversationId: options.conversationId ?? null,
        kind: options.kind ?? "file",
      };
      if (options.emitRuntimeEvents !== false) {
        window.dispatchEvent(
          new CustomEvent("ai-character:agent-task-start", { detail: startDetail })
        );
      }

      const answer = await invoke<string>("run_agent", {
        agent: options.agent,
        prompt: options.prompt,
        workingDir: projectDir,
        conversationId: options.conversationId ?? null,
        taskId,
        timeoutSeconds: options.timeoutSeconds,
        sensitiveAcknowledged: options.sensitiveAcknowledged ?? true,
        model: options.model || null,
        kind: options.kind ?? "file",
      });

      const endDetail: AgentTaskEndEvent = {
        taskId,
        agent: options.agent,
        conversationId: options.conversationId ?? null,
        status: "completed",
        kind: options.kind ?? "file",
      };
      if (options.emitRuntimeEvents !== false) {
        window.dispatchEvent(
          new CustomEvent("ai-character:agent-task-end", { detail: endDetail })
        );
      }
      noteRunSuccess(options.agent);
      return answer;
    } catch (error) {
      const message = errorMessage(error);
      // Over the subscription limit: skipped until it resets (subscription-limits).
      noteRunFailure(options.agent, message);
      const cancelled =
        message.includes("취소") ||
        message.toLowerCase().includes("cancel");

      const endDetail: AgentTaskEndEvent = {
        taskId,
        agent: options.agent,
        conversationId: options.conversationId ?? null,
        status: cancelled ? "cancelled" : "failed",
        kind: options.kind ?? "file",
        userMessage: userFacingAgentError(message),
        error: message,
      };
      if (options.emitRuntimeEvents !== false) {
        window.dispatchEvent(
          new CustomEvent("ai-character:agent-task-end", { detail: endDetail })
        );
      }
      throw error;
    } finally {
      unlisten?.();
    }
  })();

  return { taskId, result };
}

export async function runAgentText(options: RunAgentOptions): Promise<string> {
  return runAgentTask(options).result;
}

export async function cancelAgent(taskId: string): Promise<void> {
  await invoke("cancel_agent", { taskId });
}

export async function getWorkspaceChanges(
  conversationId: string
): Promise<WorkspaceChange[]> {
  return invoke<WorkspaceChange[]>("get_workspace_changes", { conversationId });
}

export async function getWorkspaceDiff(
  conversationId: string,
  path: string
): Promise<string> {
  return invoke<string>("get_workspace_diff", { conversationId, path });
}

export async function applyWorkspaceChanges(
  conversationId: string
): Promise<ApplyWorkspaceResult> {
  return invoke<ApplyWorkspaceResult>("apply_workspace_changes", { conversationId });
}

export async function discardWorkspaceChanges(
  conversationId: string
): Promise<void> {
  await invoke("discard_workspace_changes", { conversationId });
}

export async function confirmSensitiveAgentAccess(
  preferences: AppPreferences
): Promise<boolean> {
  // Conversation workspace copies already exclude keys.env / .env secrets.
  // Optional warning only lists leftover sensitive filenames in the project tree.
  if (!preferences.warnSensitiveFiles) {
    return true;
  }
  const sensitive = await getSensitiveFiles();
  if (sensitive.length === 0) {
    return true;
  }
  const preview = sensitive.slice(0, 5).join(", ");
  const more =
    sensitive.length > 5 ? ` 외 ${sensitive.length - 5}개` : "";
  return safeConfirm(
    `프로젝트에 민감해 보이는 파일이 있습니다:\n${preview}${more}\n\n` +
      `AI 작업 복사본에는 keys.env 등 비밀 파일이 들어가지 않습니다.\n` +
      `계속 실행할까요?`
  );
}

export async function askAgentCompat(
  agent: AgentKind,
  prompt: string,
  conversationId?: string | null,
  model?: string | null,
  kind: "chat" | "file" = "chat"
): Promise<string> {
  const preferences = await getAppPreferences();
  const sensitiveAcknowledged = await confirmSensitiveAgentAccess(preferences);
  if (!sensitiveAcknowledged) {
    throw new Error("민감 파일 경고에서 AI 프로그램 실행을 취소했습니다.");
  }

  try {
    return await runAgentText({
      agent,
      prompt,
      conversationId: conversationId ?? null,
      timeoutSeconds: preferences.timeoutSeconds,
      sensitiveAcknowledged,
      kind,
      model,
    });
  } catch (error) {
    const raw = errorMessage(error);
    const friendly = userFacingAgentError(raw);
    setWorkLogTechnical(raw);
    setWorkLogStatus(friendly);
    throw new Error(friendly);
  }
}

export async function askClaudeCompat(
  prompt: string,
  conversationId?: string | null
): Promise<string> {
  const preferences = await getAppPreferences();
  return askAgentCompat(preferences.defaultAgent, prompt, conversationId);
}
