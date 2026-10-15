import { getAppPreferences } from "./agent-client";
import { safeConfirm } from "./safe-confirm";
import { setWorkLogStatus, setWorkLogTechnical } from "./work-log-store";
import {
  cancelCradleOrchestration,
  fallbackManagerWebToCli,
  fallbackWebTaskToCli,
  getActiveCradleSession,
  retryCradleSynthesis,
  skipWebAgentTask,
  submitManagerWebResponse,
  submitWebAgentResponse,
} from "./orchestration-engine";
import type {
  CradleSession,
  CradleTaskState,
  ManagerWebHandoff,
  OrchestrationTarget,
  TaskRole,
  WebAgentTarget,
} from "./orchestration-types";
import {
  copyWebAgentPrompt,
  openWebAgent,
  prepareAlternateWebAgentHandoff,
  prepareWebAgentHandoff,
  WEB_AGENT_LABELS,
} from "./web-agent-handoff";
import { closeWebAccounts } from "./web-accounts";
import type { WebAccountSlot } from "./web-accounts";

const TARGET_LABELS: Record<OrchestrationTarget, string> = {
  claude: "Claude CLI",
  codex: "Codex CLI",
  cursor: "Cursor CLI",
  antigravity: "Antigravity CLI",
  claude_web: "Claude Web",
  chatgpt_web: "ChatGPT Web",
  gemini_web: "Gemini Web",
  gemini_api: "Gemini API (자동)",
  openrouter_api: "OpenRouter 무료 모델 (자동)",
  free_pool_api: "추가 무료 AI (Groq·NVIDIA·GLM 등)",
  openai_api: "OpenAI API (자동·옵션)",
};

const FRIENDLY_TARGETS: Record<OrchestrationTarget, string> = {
  claude: "파일 작업",
  codex: "파일 작업",
  cursor: "파일 작업",
  antigravity: "파일 작업",
  claude_web: "Claude",
  chatgpt_web: "ChatGPT",
  gemini_web: "Gemini",
  gemini_api: "자동 분석",
  openrouter_api: "자동 분석",
  free_pool_api: "자동 분석",
  openai_api: "자동 분석",
};

const ROLE_LABELS: Record<TaskRole, string> = {
  planner: "계획",
  coder: "코딩",
  reviewer: "검토",
  tester: "테스트",
  documenter: "문서",
};

const STATUS_LABELS: Record<CradleTaskState["status"], string> = {
  queued: "대기",
  running: "진행 중",
  waiting_web: "웹에서 이어서",
  completed: "완료",
  failed: "실패/건너뜀",
  cancelled: "취소",
};

function isWebTarget(target: OrchestrationTarget): target is WebAgentTarget {
  return target === "claude_web" || target === "chatgpt_web" || target === "gemini_web";
}

function button(label: string, className = "ai-cradle-action"): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
}

function jsonFileButton(onText: (text: string) => void): HTMLButtonElement {
  const element = button("JSON 파일 열기", "ai-cradle-action");
  element.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json,.txt";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        onText(text);
      }).catch((error) => {
        element.textContent = "파일을 읽지 못했습니다";
        element.title = error instanceof Error ? error.message : String(error);
        window.setTimeout(() => {
          element.textContent = "JSON 파일 열기";
          element.title = "";
        }, 3000);
      });
    });
    input.click();
  });
  return element;
}

function extraMethods(...nodes: Array<HTMLElement | null>): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "ai-cradle-extra-methods";
  const summary = document.createElement("summary");
  summary.textContent = "다른 방법";
  const body = document.createElement("div");
  body.className = "ai-cradle-extra-methods-body";
  for (const node of nodes) {
    if (node) body.append(node);
  }
  details.append(summary, body);
  return details;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function friendlySessionStatus(session: CradleSession): string {
  if (session.managerHandoff || session.status === "waiting_web") {
    return "웹 창에서 보낸 뒤, 결과만 붙여넣으면 됩니다.";
  }
  if (session.status === "planning") return "준비 중…";
  if (session.status === "running") return "자동으로 처리 중…";
  if (session.status === "synthesizing") return "답을 정리 중…";
  if (session.status === "completed") return "완료. 답을 채팅에 넣었습니다.";
  if (session.status === "failed") return "다시 시도할 수 있어요.";
  if (session.status === "cancelled") return "중지했습니다.";
  return session.statusMessage;
}

function collapsiblePrompt(promptText: string): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "ai-cradle-prompt-details";
  const summary = document.createElement("summary");
  summary.textContent = "세부 프롬프트 보기";
  summary.title = "내부 프롬프트는 기본 접힘";
  const prompt = document.createElement("pre");
  prompt.className = "ai-cradle-web-prompt";
  prompt.textContent = promptText;
  details.append(summary, prompt);
  return details;
}

export function initializeCradleOrchestrationUi(): void {
  if (document.querySelector("#ai-cradle-panel")) {
    return;
  }

  const chatPanel = document.querySelector<HTMLElement>("#chat-panel");
  const chatForm = document.querySelector<HTMLFormElement>("#chat-form");
  if (!chatPanel || !chatForm || !chatPanel.contains(chatForm)) {
    return;
  }

  const parent = chatForm.parentElement;
  if (!parent) {
    return;
  }

  const panel = document.createElement("section");
  panel.id = "ai-cradle-panel";
  panel.hidden = true;
  panel.setAttribute("aria-live", "polite");

  const header = document.createElement("div");
  header.className = "ai-cradle-header";
  const title = document.createElement("strong");
  title.textContent = "CRADLE 자동 분배";
  const manager = document.createElement("span");
  manager.className = "ai-cradle-manager";
  manager.textContent = "채팅만 하면 됩니다";
  const headerActions = document.createElement("div");
  headerActions.className = "ai-cradle-header-actions";
  const retryButton = button("합성 다시 시도", "ai-cradle-action ai-cradle-retry");
  retryButton.hidden = true;
  const stopButton = button("CRADLE 중지", "ai-cradle-action ai-cradle-secondary");
  stopButton.hidden = true;
  const hideButton = button("닫기", "ai-cradle-action ai-cradle-secondary");
  hideButton.title = "작업 패널 닫기. 로그에서 다시 볼 수 있습니다.";
  headerActions.append(retryButton, stopButton, hideButton);
  header.append(title, headerActions);

  const progress = document.createElement("div");
  progress.className = "ai-cradle-progress";
  progress.hidden = true;
  const progressBar = document.createElement("div");
  progressBar.className = "ai-cradle-progress-bar";
  progress.append(progressBar);

  const summary = document.createElement("div");
  summary.className = "ai-cradle-summary";
  const status = document.createElement("div");
  status.className = "ai-cradle-status";
  status.textContent = "준비";
  const technicalStatus = document.createElement("details");
  technicalStatus.className = "ai-cradle-technical-status";
  const technicalSummary = document.createElement("summary");
  technicalSummary.textContent = "자세한 상태 · 자동 Provider 우선";
  const technicalBody = document.createElement("div");
  technicalBody.className = "ai-cradle-technical-body";
  technicalStatus.append(technicalSummary, technicalBody, manager);

  const managerHandoffHost = document.createElement("div");
  managerHandoffHost.className = "ai-cradle-manager-handoff-host";

  const taskList = document.createElement("div");
  taskList.id = "ai-cradle-task-list";

  panel.append(header, progress, summary, status, technicalStatus, managerHandoffHost, taskList);
  parent.insertBefore(panel, chatForm);

  let lastSession: CradleSession | null = null;
  let trackedSessionId: string | null = null;
  let sessionCleanupDoneFor: string | null = null;
  const autoPreparedHandoffs = new Set<string>();
  const handoffAccountByKey = new Map<string, string>();
  const handoffAccountLabelByKey = new Map<string, string>();
  const sessionOpenedAccountIds = new Set<string>();

  async function switchHandoffAccount(
    autoKey: string,
    account: WebAccountSlot,
    closePrevious: boolean
  ): Promise<void> {
    const previousId = handoffAccountByKey.get(autoKey);
    if (closePrevious && previousId && previousId !== account.id) {
      const prefs = await getAppPreferences();
      if (prefs.closeWebAccountAfterHandoff) {
        await closeWebAccounts([previousId]);
        sessionOpenedAccountIds.delete(previousId);
      }
    }
    handoffAccountByKey.set(autoKey, account.id);
    handoffAccountLabelByKey.set(autoKey, account.label);
    sessionOpenedAccountIds.add(account.id);
  }

  async function finishHandoff(autoKey: string): Promise<void> {
    const accountId = handoffAccountByKey.get(autoKey);
    if (!accountId) {
      return;
    }
    const prefs = await getAppPreferences();
    if (prefs.closeWebAccountAfterHandoff) {
      await closeWebAccounts([accountId]);
      sessionOpenedAccountIds.delete(accountId);
    }
    handoffAccountByKey.delete(autoKey);
    handoffAccountLabelByKey.delete(autoKey);
  }

  async function closeSessionWebWindows(): Promise<void> {
    const prefs = await getAppPreferences();
    if (!prefs.closeWebAccountWhenCradleDone) {
      return;
    }
    const ids = [...sessionOpenedAccountIds];
    if (ids.length === 0) {
      return;
    }
    await closeWebAccounts(ids);
    sessionOpenedAccountIds.clear();
    handoffAccountByKey.clear();
    handoffAccountLabelByKey.clear();
  }

  function accountHint(autoKey: string): string {
    const label = handoffAccountLabelByKey.get(autoKey);
    return label ? `사용 중: ${label}` : "";
  }

  stopButton.addEventListener("click", async () => {
    if (!lastSession) {
      return;
    }
    if (!safeConfirm("현재 CRADLE 작업을 중지할까요? 실행 중인 CLI 작업에도 중지 요청을 보냅니다.")) {
      return;
    }
    stopButton.disabled = true;
    try {
      await cancelCradleOrchestration(lastSession.id);
    } catch (error) {
      setMessage(`CRADLE 중지 실패: ${errorText(error)}`);
    } finally {
      stopButton.disabled = false;
    }
  });

  hideButton.addEventListener("click", () => {
    panel.hidden = true;
  });
  window.addEventListener("ai-character:work-ui-hide", () => {
    panel.hidden = true;
  });
  window.addEventListener("ai-character:stop-active-work", () => {
    if (!lastSession) {
      return;
    }
    if (!["planning", "running", "waiting_web", "synthesizing"].includes(lastSession.status)) {
      return;
    }
    void cancelCradleOrchestration(lastSession.id).catch((error) => {
      setMessage(`CRADLE 중지 실패: ${errorText(error)}`);
    });
  });

  retryButton.addEventListener("click", async () => {
    if (!lastSession) {
      return;
    }
    retryButton.disabled = true;
    setMessage("Claude 최종 합성만 다시 시도합니다. Worker는 다시 실행하지 않습니다.");
    try {
      await retryCradleSynthesis(lastSession.id);
    } catch (error) {
      setMessage(`합성 재시도 실패: ${errorText(error)}`);
    } finally {
      retryButton.disabled = false;
    }
  });

  function setMessage(message: string): void {
    status.textContent = message;
  }

  async function runPrepareHandoff(
    key: string,
    target: WebAgentTarget,
    promptText: string,
    prepareButton: HTMLButtonElement
  ): Promise<void> {
    prepareButton.disabled = true;
    try {
      const account = await prepareWebAgentHandoff(target, promptText);
      await switchHandoffAccount(key, account, true);
      autoPreparedHandoffs.add(key);
      setMessage(
        `${account.label} 창을 열고 프롬프트를 복사했습니다. 그 창에서 보낸 뒤 응답만 붙여넣으세요.`
      );
    } catch (error) {
      setMessage(`웹 준비 실패: ${errorText(error)}`);
    } finally {
      prepareButton.disabled = false;
    }
  }

  async function runAlternateHandoff(
    key: string,
    target: WebAgentTarget,
    promptText: string,
    button: HTMLButtonElement
  ): Promise<void> {
    const currentId = handoffAccountByKey.get(key);
    if (!currentId) {
      setMessage("먼저 '한 번에 열기+복사'로 기본 계정 창을 여세요.");
      return;
    }
    button.disabled = true;
    try {
      const account = await prepareAlternateWebAgentHandoff(target, promptText, currentId);
      await switchHandoffAccount(key, account, true);
      setMessage(
        `${account.label} 창을 열었습니다. (전송/수집은 직접) 붙여넣어 보낸 뒤 응답만 여기에 넣으세요.`
      );
    } catch (error) {
      setMessage(`다른 계정 창 열기 실패: ${errorText(error)}`);
    } finally {
      button.disabled = false;
    }
  }

  function addCommonWebActions(
    actions: HTMLElement,
    target: WebAgentTarget,
    promptText: string,
    autoKey: string,
    accountHintEl: HTMLElement
  ): { prepareButton: HTMLButtonElement; extraButtons: HTMLButtonElement[] } {
    const prepareButton = button("한 번에 열기+복사", "ai-cradle-action ai-cradle-primary");
    const alternateButton = button("다른 계정 창 열기+복사", "ai-cradle-action");
    const openButton = button("웹 열기");
    const copyButton = button("프롬프트 복사");
    actions.append(prepareButton);
    accountHintEl.textContent = accountHint(autoKey);

    prepareButton.addEventListener("click", () => {
      void runPrepareHandoff(autoKey, target, promptText, prepareButton).then(() => {
        accountHintEl.textContent = accountHint(autoKey);
      });
    });

    alternateButton.addEventListener("click", () => {
      void runAlternateHandoff(autoKey, target, promptText, alternateButton).then(() => {
        accountHintEl.textContent = accountHint(autoKey);
      });
    });

    openButton.addEventListener("click", async () => {
      openButton.disabled = true;
      try {
        const account = await openWebAgent(target);
        await switchHandoffAccount(autoKey, account, false);
        accountHintEl.textContent = accountHint(autoKey);
        setMessage(`${account.label} 창을 열었습니다.`);
      } catch (error) {
        setMessage(`웹 열기 실패: ${errorText(error)}`);
      } finally {
        openButton.disabled = false;
      }
    });

    copyButton.addEventListener("click", async () => {
      copyButton.disabled = true;
      try {
        await copyWebAgentPrompt(promptText);
        setMessage("프롬프트를 클립보드에 복사했습니다. 웹에서 붙여넣어 전송하세요.");
      } catch (error) {
        setMessage(`프롬프트 복사 실패: ${errorText(error)}`);
      } finally {
        copyButton.disabled = false;
      }
    });

    if (!autoPreparedHandoffs.has(autoKey)) {
      autoPreparedHandoffs.add(autoKey);
      window.setTimeout(() => {
        void runPrepareHandoff(autoKey, target, promptText, prepareButton);
      }, 250);
    }

    return { prepareButton, extraButtons: [alternateButton, openButton, copyButton] };
  }

  function renderManagerHandoff(session: CradleSession, handoff: ManagerWebHandoff): HTMLElement {
    const box = document.createElement("section");
    box.className = "ai-cradle-web-handoff ai-cradle-manager-handoff";

    const help = document.createElement("div");
    help.className = "ai-cradle-web-help";
    help.textContent = handoff.stage === "planning"
      ? "웹 창이 열리면 보내기만 하세요. 나온 결과만 아래에 붙여넣으면 됩니다."
      : "마지막 정리만 웹에서 이어가면 됩니다. 결과만 아래에 붙여넣으세요.";

    const prompt = collapsiblePrompt(handoff.prompt);
    const autoKey = `${session.id}:manager:${handoff.stage}`;

    const accountHintEl = document.createElement("div");
    accountHintEl.className = "ai-cradle-web-account-hint";
    const actions = document.createElement("div");
    actions.className = "ai-cradle-web-actions";
    const { extraButtons } = addCommonWebActions(actions, "claude_web", handoff.prompt, autoKey, accountHintEl);
    const cliButton = button("한도 초과/사용 불가 → CLI로 전환", "ai-cradle-action ai-cradle-secondary");

    const response = document.createElement("textarea");
    response.className = "ai-cradle-web-response";
    response.rows = 6;
    response.placeholder = "결과를 여기에 붙여넣으세요";
    response.setAttribute("aria-label", "Claude Web 총괄 응답");

    const submitButton = button("총괄 결과 전달", "ai-cradle-action ai-cradle-primary");
    const fileButton = jsonFileButton((text) => {
      response.value = text;
    });
    submitButton.addEventListener("click", () => {
      void (async () => {
        try {
          submitManagerWebResponse(session.id, handoff.stage, response.value);
          response.value = "";
          await finishHandoff(autoKey);
          setMessage("Claude Web 총괄 응답을 전달했습니다. 계정 창은 설정에 따라 닫힙니다.");
        } catch (error) {
          setMessage(errorText(error));
        }
      })();
    });

    cliButton.addEventListener("click", () => {
      if (!safeConfirm("Claude Web이 한도 초과/사용 불가 상태인가요? 이 앱 세션에서는 Claude CLI를 대신 사용합니다.")) {
        return;
      }
      try {
        fallbackManagerWebToCli(session.id, handoff.stage);
        setMessage("Claude Web을 제한됨으로 표시하고 Claude CLI로 전환합니다.");
      } catch (error) {
        setMessage(errorText(error));
      }
    });

    box.append(
      help,
      accountHintEl,
      actions,
      response,
      submitButton,
      extraMethods(...extraButtons, cliButton, fileButton, prompt)
    );
    return box;
  }

  function renderWebHandoff(session: CradleSession, task: CradleTaskState): HTMLElement {
    const target = task.target as WebAgentTarget;
    const box = document.createElement("div");
    box.className = "ai-cradle-web-handoff";

    const help = document.createElement("div");
    help.className = "ai-cradle-web-help";
    help.textContent = `${WEB_AGENT_LABELS[target]} 창에서 보낸 뒤, 결과만 아래에 붙여넣으면 됩니다.`;

    const promptText = task.handoffPrompt ?? task.prompt;
    const prompt = collapsiblePrompt(promptText);
    const autoKey = `${session.id}:task:${task.id}`;

    const accountHintEl = document.createElement("div");
    accountHintEl.className = "ai-cradle-web-account-hint";
    const actions = document.createElement("div");
    actions.className = "ai-cradle-web-actions";
    const { extraButtons } = addCommonWebActions(actions, target, promptText, autoKey, accountHintEl);
    const fallbackButton = button("웹 한도 초과/사용 불가 → CLI", "ai-cradle-action ai-cradle-secondary");
    const skipButton = button("건너뛰기", "ai-cradle-action ai-cradle-secondary");

    const response = document.createElement("textarea");
    response.className = "ai-cradle-web-response";
    response.rows = 5;
    response.placeholder = "결과를 여기에 붙여넣으세요";
    response.setAttribute("aria-label", `${TARGET_LABELS[task.target]} 응답`);

    const submitButton = button("결과 전달", "ai-cradle-action ai-cradle-primary");
    const fileButton = jsonFileButton((text) => {
      response.value = text;
    });

    submitButton.addEventListener("click", () => {
      void (async () => {
        try {
          submitWebAgentResponse(session.id, task.id, response.value);
          response.value = "";
          await finishHandoff(autoKey);
          setMessage(`${TARGET_LABELS[task.target]} 응답을 전달했습니다. 계정 창은 설정에 따라 닫힙니다.`);
        } catch (error) {
          setMessage(errorText(error));
        }
      })();
    });

    fallbackButton.addEventListener("click", () => {
      if (!safeConfirm(`${WEB_AGENT_LABELS[target]}이 한도 초과/사용 불가 상태인가요? 사용 가능한 CLI로 전환합니다.`)) {
        return;
      }
      try {
        fallbackWebTaskToCli(session.id, task.id);
        setMessage(`${WEB_AGENT_LABELS[target]}을 제한됨으로 표시하고 CLI fallback을 요청했습니다.`);
      } catch (error) {
        setMessage(errorText(error));
      }
    });

    skipButton.addEventListener("click", () => {
      if (!safeConfirm(`${TARGET_LABELS[task.target]} 작업을 건너뛸까요?`)) {
        return;
      }
      void (async () => {
        try {
          skipWebAgentTask(session.id, task.id);
          await finishHandoff(autoKey);
          setMessage(`${TARGET_LABELS[task.target]} 작업을 건너뛰었습니다.`);
        } catch (error) {
          setMessage(errorText(error));
        }
      })();
    });

    box.append(
      help,
      accountHintEl,
      actions,
      response,
      submitButton,
      extraMethods(...extraButtons, fallbackButton, skipButton, fileButton, prompt)
    );
    return box;
  }

  function renderTask(session: CradleSession, task: CradleTaskState): HTMLElement {
    const card = document.createElement("article");
    card.className = "ai-cradle-task";
    card.dataset.status = task.status;

    const taskHeader = document.createElement("div");
    taskHeader.className = "ai-cradle-task-header";
    const label = document.createElement("strong");
    label.textContent = task.title;
    const meta = document.createElement("span");
    const role = task.role ? `${ROLE_LABELS[task.role]} · ` : "";
    meta.textContent = `${role}${FRIENDLY_TARGETS[task.target]} · ${STATUS_LABELS[task.status]}`;
    taskHeader.append(label, meta);
    card.append(taskHeader);

    if (task.status === "waiting_web" && isWebTarget(task.target)) {
      card.append(renderWebHandoff(session, task));
    } else if (task.status === "failed" && task.error) {
      const failure = document.createElement("div");
      failure.className = "ai-cradle-task-error";
      failure.textContent = task.error;
      card.append(failure);
    }

    const extras: HTMLElement[] = [];
    if (task.prompt) {
      const instruction = document.createElement("div");
      instruction.className = "ai-cradle-task-instruction";
      instruction.textContent = task.prompt;
      extras.push(instruction);
    }
    if (task.fallbackReason) {
      const fallback = document.createElement("div");
      fallback.className = "ai-cradle-task-fallback";
      fallback.textContent = task.fallbackReason;
      extras.push(fallback);
    }
    if (task.status === "completed" && task.output) {
      const output = document.createElement("pre");
      output.textContent = task.output;
      extras.push(output);
    }
    if (extras.length > 0 && task.status !== "waiting_web") {
      const details = document.createElement("details");
      details.className = "ai-cradle-task-result";
      const resultSummary = document.createElement("summary");
      resultSummary.textContent = task.status === "completed" ? "결과 보기" : "자세히";
      details.append(resultSummary, ...extras);
      card.append(details);
    }

    return card;
  }

  function render(session: CradleSession): void {
    if (trackedSessionId !== session.id) {
      trackedSessionId = session.id;
      autoPreparedHandoffs.clear();
    }
    if (
      ["completed", "failed", "cancelled"].includes(session.status) &&
      sessionCleanupDoneFor !== session.id
    ) {
      sessionCleanupDoneFor = session.id;
      void closeSessionWebWindows();
    }
    lastSession = session;
    const compact = ["completed", "failed", "cancelled"].includes(session.status);
    panel.classList.toggle("is-compact", compact);
    if (compact) {
      panel.hidden = true;
    } else {
      panel.hidden = false;
    }
    const finished = session.tasks.filter((task) =>
      ["completed", "failed", "cancelled"].includes(task.status)
    ).length;
    const total = session.tasks.length;
    progress.hidden = total === 0;
    progressBar.style.width = total > 0 ? `${Math.round((finished / total) * 100)}%` : "0%";
    progress.title = total > 0 ? `${finished}/${total}` : "";
    summary.textContent = session.planSummary
      ? session.planSummary
      : total > 0
        ? `${total}개 작업 · ${finished}개 끝`
        : "작업을 준비하고 있습니다.";
    status.textContent = friendlySessionStatus(session);
    technicalBody.textContent = session.statusMessage;
    setWorkLogStatus(status.textContent);
    if (session.error) {
      setWorkLogTechnical(session.error);
    }
    manager.textContent = session.revisionRound > 0 ? "한 번 더 보완 중" : "채팅만 하면 됩니다";
    managerHandoffHost.replaceChildren(
      ...(session.managerHandoff ? [renderManagerHandoff(session, session.managerHandoff)] : [])
    );
    if (session.status === "completed" && session.tasks.length > 0) {
      const archive = document.createElement("details");
      archive.className = "ai-cradle-task-archive";
      const archiveSummary = document.createElement("summary");
      archiveSummary.textContent = "작업 내역";
      archive.append(archiveSummary, ...session.tasks.map((task) => renderTask(session, task)));
      taskList.replaceChildren(archive);
    } else {
      taskList.replaceChildren(...session.tasks.map((task) => renderTask(session, task)));
    }
    const running = ["planning", "running", "waiting_web", "synthesizing"].includes(session.status);
    const retryable = session.status === "failed" && session.tasks.length > 0 &&
      session.tasks.every((task) => ["completed", "failed", "cancelled"].includes(task.status));
    stopButton.hidden = !(running || retryable);
    retryButton.hidden = !retryable;
  }

  window.addEventListener("ai-character:cradle-session", (event: Event) => {
    render((event as CustomEvent<CradleSession>).detail);
  });

  window.addEventListener("ai-character:preferences-updated", () => {
    void getAppPreferences().then((preferences) => {
      if (!preferences.cradleEnabled && !lastSession) {
        panel.hidden = true;
      }
    });
  });

  const current = getActiveCradleSession();
  if (current) {
    render(current);
  } else {
    void getAppPreferences().then((preferences) => {
      if (preferences.cradleEnabled) {
        panel.hidden = true;
      }
    });
  }
}
