import {
  applyWorkspaceChanges,
  cancelAgent,
  discardWorkspaceChanges,
  getWorkspaceChanges,
  getWorkspaceDiff,
  getAppPreferences,
  type AppPreferences,
  type AgentStreamEvent,
  type AgentTaskEndEvent,
  type AgentTaskStartEvent,
  type WorkspaceChange,
} from "./agent-client";

export const MAX_OUTPUT_CHARS = 12_000;

function appendOutput(output: HTMLPreElement, text: string): void {
  const next = (output.textContent ?? "") + text;
  output.textContent =
    next.length > MAX_OUTPUT_CHARS
      ? next.slice(-MAX_OUTPUT_CHARS)
      : next;
  output.scrollTop = output.scrollHeight;
}

function changePrefix(change: WorkspaceChange): string {
  if (change.kind === "added") {
    return "A";
  }
  if (change.kind === "deleted") {
    return "D";
  }
  return "M";
}

export function initializeAgentRuntimeUi(): void {
  if (document.querySelector("#agent-runtime-panel")) {
    return;
  }

  const chatPanel = document.querySelector<HTMLElement>("#chat-panel");
  const chatForm = document.querySelector<HTMLFormElement>("#chat-form");
  const toolbar = document.querySelector<HTMLElement>("#chat-history-toolbar");
  if (!chatPanel || !chatForm || !chatPanel.contains(chatForm)) {
    return;
  }

  const agentBadge = document.createElement("span");
  agentBadge.id = "agent-runtime-agent";
  agentBadge.textContent = "Agent: 확인 중…";
  agentBadge.title = "현재 기본 Agent";
  toolbar?.append(agentBadge);

  const agentLabel = (agent: string): string => ({
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
    antigravity: "Antigravity",
  }[agent] ?? agent);

  const updateAgentBadge = (preferences: AppPreferences): void => {
    agentBadge.textContent = preferences.cradleEnabled
      ? "여러 Agent"
      : `Agent: ${agentLabel(preferences.defaultAgent)}`;
    agentBadge.title = preferences.cradleEnabled
      ? "질문은 바로 답하고, 파일 작업은 설치된 Cursor·Codex·Claude 등에 나눕니다."
      : "현재 기본 Agent";
  };

  void getAppPreferences().then(updateAgentBadge).catch(() => {
    agentBadge.textContent = "Agent: 확인 실패";
  });

  window.addEventListener("ai-character:preferences-updated", (event: Event) => {
    updateAgentBadge((event as CustomEvent<AppPreferences>).detail);
  });

  const runtimeParent = chatForm.parentElement;
  if (!runtimeParent) {
    return;
  }

  const panel = document.createElement("section");
  panel.id = "agent-runtime-panel";
  panel.hidden = true;
  panel.setAttribute("aria-live", "polite");

  const header = document.createElement("div");
  header.id = "agent-runtime-header";

  const status = document.createElement("span");
  status.id = "agent-runtime-status";
  status.textContent = "대기";

  const stopButton = document.createElement("button");
  stopButton.id = "agent-stop-button";
  stopButton.type = "button";
  stopButton.textContent = "중지";
  stopButton.disabled = true;

  const output = document.createElement("pre");
  output.id = "agent-runtime-output";
  output.setAttribute("aria-label", "Agent 실시간 출력");

  const technicalDetails = document.createElement("details");
  technicalDetails.id = "agent-runtime-details";
  technicalDetails.hidden = true;
  const technicalSummary = document.createElement("summary");
  technicalSummary.textContent = "기술 로그";
  const technicalOutput = document.createElement("pre");
  technicalOutput.id = "agent-runtime-technical-output";
  technicalDetails.append(technicalSummary, technicalOutput);

  header.append(status, stopButton);

  const logDetails = document.createElement("details");
  logDetails.id = "agent-runtime-log";
  const logSummary = document.createElement("summary");
  logSummary.textContent = "진행 로그";
  logDetails.append(logSummary, output);
  panel.append(header, logDetails, technicalDetails);

  const changePanel = document.createElement("section");
  changePanel.id = "agent-change-panel";
  changePanel.hidden = true;

  const changeTitle = document.createElement("div");
  changeTitle.id = "agent-change-title";
  changeTitle.textContent = "적용할 파일";

  const changeList = document.createElement("div");
  changeList.id = "agent-change-list";

  const diffOutput = document.createElement("pre");
  diffOutput.id = "agent-diff-output";
  diffOutput.setAttribute("aria-label", "파일 변경 diff");

  const changeActions = document.createElement("div");
  changeActions.id = "agent-change-actions";

  const applyButton = document.createElement("button");
  applyButton.id = "agent-apply-button";
  applyButton.type = "button";
  applyButton.textContent = "원본에 적용";

  const discardButton = document.createElement("button");
  discardButton.id = "agent-discard-button";
  discardButton.type = "button";
  discardButton.textContent = "취소";

  changeActions.append(applyButton, discardButton);
  changePanel.append(changeTitle, changeList, diffOutput, changeActions);
  panel.append(changePanel);
  runtimeParent.insertBefore(panel, chatForm);

  let activeTaskId: string | null = null;
  let reviewConversationId: string | null = null;
  let reviewLoadSequence = 0;

  function setReviewBusy(busy: boolean): void {
    applyButton.disabled = busy;
    discardButton.disabled = busy;
  }

  function clearChangeReview(): void {
    reviewConversationId = null;
    changeList.replaceChildren();
    diffOutput.textContent = "";
    changePanel.hidden = true;
    setReviewBusy(false);
  }

  async function selectChange(
    conversationId: string,
    change: WorkspaceChange,
    button: HTMLButtonElement
  ): Promise<void> {
    for (const item of Array.from(changeList.querySelectorAll<HTMLButtonElement>("button"))) {
      item.dataset.selected = item === button ? "true" : "false";
    }
    const conflictHeader = change.conflict
      ? `충돌: ${change.conflictReason ?? "원본이 작업 시작 후 변경되었습니다."}\n\n`
      : "";
    diffOutput.textContent = change.binary
      ? `${conflictHeader}Binary file changed: ${change.path}`
      : `${conflictHeader}diff 불러오는 중…`;

    if (change.binary) {
      return;
    }

    try {
      const diff = await getWorkspaceDiff(conversationId, change.path);
      diffOutput.textContent = diff;
    } catch (error) {
      diffOutput.textContent = `[error] ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function loadChangeReview(conversationId: string): Promise<void> {
    const sequence = ++reviewLoadSequence;
    try {
      const changes = await getWorkspaceChanges(conversationId);
      if (sequence !== reviewLoadSequence) {
        return;
      }
      if (changes.length === 0) {
        clearChangeReview();
        return;
      }

      const hasConflicts = changes.some((change) => change.conflict);
      reviewConversationId = conversationId;
      changePanel.hidden = false;
      changeTitle.textContent = hasConflicts
        ? `적용할 파일 ${changes.length}개 · 충돌 — 원본이 밖에서 바뀌어 적용할 수 없습니다.`
        : `적용할 파일 ${changes.length}개`;
      changeList.replaceChildren();
      diffOutput.textContent = "파일을 선택하면 diff가 표시됩니다.";
      setReviewBusy(false);
      applyButton.disabled = hasConflicts;

      for (const change of changes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "agent-change-item";
        button.dataset.kind = change.kind;
        button.dataset.conflict = change.conflict ? "true" : "false";
        button.textContent = `${change.conflict ? "[충돌] " : ""}[${changePrefix(change)}] ${change.path}`;
        button.title = change.conflict
          ? change.conflictReason ?? "원본이 작업 시작 후 변경되었습니다."
          : change.binary
            ? "바이너리 파일"
            : change.path;
        button.addEventListener("click", () => {
          void selectChange(conversationId, change, button);
        });
        changeList.append(button);
      }

      const first = changeList.querySelector<HTMLButtonElement>("button");
      if (first) {
        first.click();
      }
    } catch (error) {
      if (sequence !== reviewLoadSequence) {
        return;
      }
      clearChangeReview();
      appendOutput(
        output,
        `\n[diff error] ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  window.addEventListener(
    "ai-character:agent-task-start",
    (event: Event) => {
      const detail = (event as CustomEvent<AgentTaskStartEvent>).detail;
      activeTaskId = detail.taskId;
      reviewLoadSequence += 1;
      clearChangeReview();
      panel.hidden = false;
      output.textContent = "";
      technicalOutput.textContent = "";
      technicalDetails.hidden = true;
      agentBadge.textContent = `Agent: ${agentLabel(detail.agent)}`;
      status.textContent = "파일 작업 중…";
      stopButton.disabled = false;
    }
  );

  window.addEventListener(
    "ai-character:agent-stream",
    (event: Event) => {
      const detail = (event as CustomEvent<AgentStreamEvent>).detail;
      if (!activeTaskId || detail.taskId !== activeTaskId) {
        return;
      }
      const text =
        detail.stream === "stderr"
          ? `[stderr] ${detail.text}`
          : detail.text;
      appendOutput(output, text);
    }
  );

  window.addEventListener(
    "ai-character:agent-task-end",
    (event: Event) => {
      const detail = (event as CustomEvent<AgentTaskEndEvent>).detail;
      if (!activeTaskId || detail.taskId !== activeTaskId) {
        return;
      }

      if (detail.status === "completed") {
        status.textContent = "파일 작업 끝. 답을 정리하고 있습니다.";
      } else if (detail.status === "cancelled") {
        status.textContent = "중지됨";
      } else {
        status.textContent = detail.userMessage ?? "다시 시도해 주세요";
        if (detail.error) {
          technicalDetails.hidden = false;
          technicalOutput.textContent = detail.error;
        }
      }

      activeTaskId = null;
      stopButton.disabled = true;
      if (detail.conversationId) {
        void loadChangeReview(detail.conversationId);
      } else {
        clearChangeReview();
      }
    }
  );

  stopButton.addEventListener("click", async () => {
    if (!activeTaskId) {
      return;
    }

    const taskId = activeTaskId;
    stopButton.disabled = true;
    status.textContent = "중지 요청 중…";

    try {
      await cancelAgent(activeTaskId);
    } catch (error) {
      if (activeTaskId === taskId) {
        stopButton.disabled = false;
        status.textContent = "중지 요청 실패";
      }
      appendOutput(
        output,
        `\n[error] ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  });

  applyButton.addEventListener("click", async () => {
    if (!reviewConversationId) {
      return;
    }
    const conversationId = reviewConversationId;
    setReviewBusy(true);
    status.textContent = "원본 적용 중…";
    try {
      const result = await applyWorkspaceChanges(conversationId);
      reviewConversationId = null;
      changeList.replaceChildren();
      diffOutput.textContent = `변경 ${result.appliedCount}개를 원본에 적용했습니다.\n체크포인트: ${result.checkpointId}`;
      changeTitle.textContent = "변경 적용 완료";
      status.textContent = "원본 적용 완료";
    } catch (error) {
      setReviewBusy(false);
      status.textContent = "원본 적용 실패";
      appendOutput(
        output,
        `\n[apply error] ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  });

  discardButton.addEventListener("click", async () => {
    if (!reviewConversationId) {
      return;
    }
    const conversationId = reviewConversationId;
    setReviewBusy(true);
    status.textContent = "변경 취소 중…";
    try {
      await discardWorkspaceChanges(conversationId);
      clearChangeReview();
      status.textContent = "변경 취소됨";
    } catch (error) {
      setReviewBusy(false);
      status.textContent = "변경 취소 실패";
      appendOutput(
        output,
        `\n[discard error] ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  });
}
