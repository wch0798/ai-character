import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { safeConfirm } from "./safe-confirm";
import { setWorkLogStatus, setWorkLogTechnical } from "./work-log-store";

export type AgentKind =
  | "claude"
  | "codex"
  | "cursor"
  | "antigravity";

export type RunAgentOptions = {
  agent: AgentKind;
  prompt: string;
  workingDir?: string | null;
  conversationId?: string | null;
  timeoutSeconds?: number;
  sensitiveAcknowledged?: boolean;
  emitRuntimeEvents?: boolean;
  kind?: "chat" | "file";
  onStream?: (event: AgentStreamEvent) => void;
};

export type AppPreferences = {
  defaultAgent: AgentKind;
  cradleEnabled: boolean;
  autoWebSearch: boolean;
  geminiApiEnabled: boolean;
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
  stream: "stdout" | "stderr";
  text: string;
};

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
  if (message.includes("CLI를 찾을 수 없습니다") || message.includes("실행 파일을 찾을 수 없습니다") || lower.includes("enoent")) {
    return "선택한 Agent CLI를 찾을 수 없습니다. 설정에서 설치 상태와 실행 파일 경로를 확인해주세요.";
  }
  if (message.includes("시간을 초과") || message.includes("제한을 초과") || lower.includes("timeout") || lower.includes("timed out")) {
    return "Agent 실행 시간이 설정된 제한을 초과했습니다. Timeout을 늘리거나 작업을 나눠서 다시 시도해주세요.";
  }
  if (message.includes("프로젝트 폴더") || lower.includes("working directory")) {
    return "프로젝트 폴더를 사용할 수 없습니다. 설정에서 프로젝트 경로와 접근 권한을 확인해주세요.";
  }
  if (message.includes("권한") || lower.includes("permission denied") || lower.includes("eacces")) {
    return "파일 또는 실행 파일에 접근할 권한이 없습니다. macOS/Windows 권한과 파일 권한을 확인해주세요.";
  }
  if (message.includes("민감 파일 경고")) {
    return "민감 파일 확인이 필요해 Agent 실행을 시작하지 않았습니다.";
  }
  if (message.includes("취소") || lower.includes("cancel")) {
    return "Agent 실행이 취소되었습니다.";
  }
  return "Agent 실행 중 오류가 발생했습니다. 기술 로그에서 상세 내용을 확인해주세요.";
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

export async function ensureProjectDirectory(): Promise<string> {
  const saved = await getProjectDirectory();
  if (saved) {
    return saved;
  }
  return chooseProjectDirectory();
}

export async function setProjectDirectory(path: string): Promise<string> {
  return invoke<string>("set_project_dir", { path });
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
        options.workingDir ?? await ensureProjectDirectory();

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
      return answer;
    } catch (error) {
      const message = errorMessage(error);
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
      `Agent 작업 복사본에는 keys.env 등 비밀 파일이 들어가지 않습니다.\n` +
      `계속 실행할까요?`
  );
}

export async function askClaudeCompat(
  prompt: string,
  conversationId?: string | null
): Promise<string> {
  const preferences = await getAppPreferences();
  const sensitiveAcknowledged = await confirmSensitiveAgentAccess(preferences);
  if (!sensitiveAcknowledged) {
    throw new Error("민감 파일 경고에서 Agent 실행을 취소했습니다.");
  }

  try {
    return await runAgentText({
      agent: preferences.defaultAgent,
      prompt,
      conversationId: conversationId ?? null,
      timeoutSeconds: preferences.timeoutSeconds,
      sensitiveAcknowledged,
      kind: "chat",
    });
  } catch (error) {
    const raw = errorMessage(error);
    const friendly = userFacingAgentError(raw);
    setWorkLogTechnical(raw);
    setWorkLogStatus(friendly);
    throw new Error(friendly);
  }
}
