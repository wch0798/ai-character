import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAutomaticProviderStatuses } from "./automatic-provider";
import {
  chooseAgentExecutable,
  chooseProjectDirectory,
  detectAgent,
  getAppPreferences,
  getAgentRuns,
  getCradleEnvironmentStatus,
  getFreeAutoReadiness,
  openKeysEnvFile,
  getProjectCheckpoints,
  getProjectDirectory,
  getRuntimeSetupStatus,
  installAllRequiredRuntimes,
  installAgentCli,
  launchAgentLogin,
  launchGitInstaller,
  prepareCradleEnvironment,
  restoreProjectCheckpoint,
  setAppPreferences,
  getUsageSnapshot,
  type AgentKind,
  type AgentRunRecord,
  type CheckpointRecord,
  type FreeAutoReadiness,
} from "./agent-client";
import {
  listWebAccounts,
  openAllWebAccounts,
  openWebAccount,
  updateWebAccounts,
  WEB_ACCOUNT_PROVIDER_LABELS,
  type WebAccountSlot,
} from "./web-accounts";
import { createBrowserHistoryStore } from "./chat-history";
import {
  exportAllChatsJson,
  importChatsFromJson,
} from "./chat-backup";
import {
  BOOTH_FREE_ORIGINAL_PICKS,
  dedupeUserLive2DModels,
  getUserLive2DDir,
  importUserLive2DModel,
  importUserLive2DZip,
  listUserLive2DModels,
  openBoothFreePick,
  openBoothLive2D,
  openNizima,
  openUserLive2DDir,
  removeUserLive2DModel,
  USER_LIVE2D_CHANGED_EVENT,
} from "./user-live2d";

type AgentRow = {
  agent: AgentKind;
  label: string;
};

const AGENTS: AgentRow[] = [
  { agent: "claude", label: "Claude" },
  { agent: "codex", label: "Codex" },
  { agent: "cursor", label: "Cursor" },
  { agent: "antigravity", label: "Antigravity" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeButton(label: string, className?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) {
    button.className = className;
  }
  return button;
}

export function initializeSettingsUi(): void {
  if (document.querySelector("#ai-settings-panel")) {
    return;
  }

  const chatPanel = document.querySelector<HTMLElement>("#chat-panel");
  const toolbar = document.querySelector<HTMLElement>("#chat-history-toolbar");
  const toolbarEnd = document.querySelector<HTMLElement>(".chat-toolbar-end");
  const chatCloseButton = document.querySelector<HTMLElement>("#chat-close-button");
  if (!chatPanel || !toolbar) {
    return;
  }

  const launcher = makeButton("설정", "ai-settings-button");
  launcher.id = "ai-settings-button";
  launcher.title = "설정";
  launcher.setAttribute("aria-label", "설정 열기");

  const overlay = document.createElement("section");
  overlay.id = "ai-settings-panel";
  overlay.hidden = true;
  overlay.setAttribute("aria-label", "AI-Character 설정");

  const header = document.createElement("div");
  header.className = "ai-settings-header";

  const title = document.createElement("strong");
  title.textContent = "설정";

  const closeButton = makeButton("닫기", "ai-settings-close");
  header.append(title, closeButton);

  const message = document.createElement("div");
  message.className = "ai-settings-message";
  message.setAttribute("aria-live", "polite");

  const projectSection = document.createElement("section");
  projectSection.className = "ai-settings-section";
  const projectTitle = document.createElement("h3");
  projectTitle.textContent = "프로젝트";
  const projectPath = document.createElement("div");
  projectPath.className = "ai-settings-path";
  projectPath.textContent = "프로젝트 폴더 확인 중…";
  const projectButton = makeButton("프로젝트 폴더 변경", "ai-settings-action");
  projectSection.append(projectTitle, projectPath, projectButton);

  const environmentSection = document.createElement("section");
  environmentSection.className = "ai-settings-section";
  const environmentTitle = document.createElement("h3");
  environmentTitle.textContent = "CRADLE 환경 준비";
  const environmentStatus = document.createElement("div");
  environmentStatus.className = "ai-settings-help";
  environmentStatus.textContent = "Git과 작업 환경을 확인하는 중…";
  const environmentActions = document.createElement("div");
  environmentActions.style.display = "flex";
  environmentActions.style.flexWrap = "wrap";
  environmentActions.style.gap = "6px";
  const refreshEnvironmentButton = makeButton("환경 다시 확인", "ai-settings-action");
  const prepareEnvironmentButton = makeButton("환경 준비", "ai-settings-action");
  const installGitButton = makeButton("Git 설치", "ai-settings-action");
  installGitButton.hidden = true;
  environmentActions.append(refreshEnvironmentButton, prepareEnvironmentButton, installGitButton);
  environmentSection.append(environmentTitle, environmentStatus, environmentActions);

  const easySection = document.createElement("section");
  easySection.className = "ai-settings-section ai-settings-easy";
  const easyTitle = document.createElement("h3");
  easyTitle.textContent = "한 번에 쓰기 (추천)";
  const easyLead = document.createElement("div");
  easyLead.className = "ai-settings-help";
  easyLead.textContent =
    "채팅만 하면 됩니다. 키는 앱이 아니라 로컬 파일에만 둡니다.";
  const easyStatus = document.createElement("div");
  easyStatus.className = "ai-settings-easy-status";
  easyStatus.textContent = "자동 준비 상태 확인 중…";
  const easyPath = document.createElement("div");
  easyPath.className = "ai-settings-help";
  easyPath.textContent = "키 파일: 확인 중…";
  const easyChecklist = document.createElement("ul");
  easyChecklist.className = "ai-settings-easy-list";
  const easyNext = document.createElement("div");
  easyNext.className = "ai-settings-help";
  const easyActions = document.createElement("div");
  easyActions.className = "ai-settings-easy-actions";
  const enableFreeAutoButton = makeButton("무료 자동 모드 켜기", "ai-settings-action");
  const installRuntimesButton = makeButton(
    "필수 프로그램 설치",
    "ai-settings-action"
  );
  const openKeysButton = makeButton("키 파일 열기", "ai-settings-action");
  const refreshReadyButton = makeButton("상태 다시 확인", "ai-settings-action");
  easyActions.append(
    enableFreeAutoButton,
    installRuntimesButton,
    openKeysButton,
    refreshReadyButton
  );
  easySection.append(easyTitle, easyLead, easyStatus, easyPath, easyChecklist, easyNext, easyActions);

  const accountsSection = document.createElement("section");
  accountsSection.className = "ai-settings-section ai-settings-accounts";
  const accountsTitle = document.createElement("h3");
  accountsTitle.textContent = "계정 · 로그인";
  const accountsLead = document.createElement("div");
  accountsLead.className = "ai-settings-help";
  accountsLead.textContent =
    "사용량에 나오는 Claude·Codex·Cursor·Antigravity는 여기 로그인과 API 키가 있어야 연결됨으로 표시됩니다. 미연결이면 그 줄의 로그인을 누르세요.";
  const loginStatusList = document.createElement("div");
  loginStatusList.className = "ai-web-accounts-list ai-login-status-list";
  const webWindowsTitle = document.createElement("h3");
  webWindowsTitle.textContent = "웹 창 (CRADLE 전달용)";
  const webWindowsHelp = document.createElement("div");
  webWindowsHelp.className = "ai-settings-help";
  webWindowsHelp.textContent =
    "사람이 브라우저에서 보고 복사할 창입니다. Agent CLI 로그인과는 별개입니다.";
  const accountsList = document.createElement("div");
  accountsList.className = "ai-web-accounts-list";
  const accountsActions = document.createElement("div");
  accountsActions.className = "ai-settings-easy-actions";
  const openAllAccountsButton = makeButton("모든 웹 창 열기", "ai-settings-action");
  const refreshAccountsButton = makeButton("계정 상태 새로고침", "ai-settings-action");
  accountsActions.append(openAllAccountsButton, refreshAccountsButton);
  const closeAfterHandoffLabel = document.createElement("label");
  closeAfterHandoffLabel.className = "ai-settings-checkbox";
  const closeAfterHandoffCheckbox = document.createElement("input");
  closeAfterHandoffCheckbox.type = "checkbox";
  const closeAfterHandoffText = document.createElement("span");
  closeAfterHandoffText.textContent = "응답 전달 후 이 작업의 계정 창 닫기";
  const closeAfterHandoffHelp = document.createElement("small");
  closeAfterHandoffHelp.className = "ai-settings-help";
  closeAfterHandoffHelp.textContent = "전송/수집은 사람이 하고, 앱은 창만 정리합니다. (기본 켜짐)";
  const closeAfterHandoffCopy = document.createElement("span");
  closeAfterHandoffCopy.className = "ai-settings-checkbox-copy";
  closeAfterHandoffCopy.append(closeAfterHandoffText, closeAfterHandoffHelp);
  closeAfterHandoffLabel.append(closeAfterHandoffCheckbox, closeAfterHandoffCopy);
  const closeWhenDoneLabel = document.createElement("label");
  closeWhenDoneLabel.className = "ai-settings-checkbox";
  const closeWhenDoneCheckbox = document.createElement("input");
  closeWhenDoneCheckbox.type = "checkbox";
  const closeWhenDoneText = document.createElement("span");
  closeWhenDoneText.textContent = "CRADLE 끝나면 남은 계정 창 닫기";
  const closeWhenDoneHelp = document.createElement("small");
  closeWhenDoneHelp.className = "ai-settings-help";
  closeWhenDoneHelp.textContent = "설정에서 미리 연 로그인 창까지 닫지 않고, 이번 CRADLE에서 연 창만 정리합니다.";
  const closeWhenDoneCopy = document.createElement("span");
  closeWhenDoneCopy.className = "ai-settings-checkbox-copy";
  closeWhenDoneCopy.append(closeWhenDoneText, closeWhenDoneHelp);
  closeWhenDoneLabel.append(closeWhenDoneCheckbox, closeWhenDoneCopy);
  accountsSection.append(
    accountsTitle,
    accountsLead,
    loginStatusList,
    webWindowsTitle,
    webWindowsHelp,
    accountsList,
    closeAfterHandoffLabel,
    closeWhenDoneLabel,
    accountsActions
  );

  const runtimeSection = document.createElement("section");
  runtimeSection.className = "ai-settings-section";
  const runtimeTitle = document.createElement("h3");
  runtimeTitle.textContent = "기본 실행";

  const cradleLabel = document.createElement("label");
  cradleLabel.className = "ai-settings-checkbox";
  const cradleCheckbox = document.createElement("input");
  cradleCheckbox.type = "checkbox";
  const cradleText = document.createElement("span");
  cradleText.textContent = "CRADLE 자동 분배";
  const cradleHelp = document.createElement("small");
  cradleHelp.className = "ai-settings-help";
  cradleHelp.textContent =
    "질문은 바로 답하고, 파일 작업은 Cursor·Codex·Claude·Antigravity 등 설치된 Agent에 나눕니다.";
  const cradleCopy = document.createElement("span");
  cradleCopy.className = "ai-settings-checkbox-copy";
  cradleCopy.append(cradleText, cradleHelp);
  cradleLabel.append(cradleCheckbox, cradleCopy);

  const webSearchLabel = document.createElement("label");
  webSearchLabel.className = "ai-settings-checkbox";
  const webSearchCheckbox = document.createElement("input");
  webSearchCheckbox.type = "checkbox";
  const webSearchText = document.createElement("span");
  webSearchText.textContent = "🌐 백그라운드 웹 자동검색";
  const webSearchHelp = document.createElement("small");
  webSearchHelp.className = "ai-settings-help";
  webSearchHelp.textContent = "최신/조사 요청일 때만 검색합니다.";
  const webSearchCopy = document.createElement("span");
  webSearchCopy.className = "ai-settings-checkbox-copy";
  webSearchCopy.append(webSearchText, webSearchHelp);
  webSearchLabel.append(webSearchCheckbox, webSearchCopy);

  const geminiApiLabel = document.createElement("label");
  geminiApiLabel.className = "ai-settings-checkbox";
  const geminiApiCheckbox = document.createElement("input");
  geminiApiCheckbox.type = "checkbox";
  const geminiApiText = document.createElement("span");
  geminiApiText.textContent = "Gemini 공식 API 자동 사용";
  const geminiApiHelp = document.createElement("small");
  geminiApiHelp.className = "ai-settings-help";
  geminiApiHelp.textContent = "가능할 때 공식 API로 바로 답합니다.";
  const geminiApiCopy = document.createElement("span");
  geminiApiCopy.className = "ai-settings-checkbox-copy";
  geminiApiCopy.append(geminiApiText, geminiApiHelp);
  geminiApiLabel.append(geminiApiCheckbox, geminiApiCopy);

  const openAiApiLabel = document.createElement("label");
  openAiApiLabel.className = "ai-settings-checkbox";
  const openAiApiCheckbox = document.createElement("input");
  openAiApiCheckbox.type = "checkbox";
  const openAiApiText = document.createElement("span");
  openAiApiText.textContent = "OpenAI 유료 API 사용 허용";
  const openAiApiHelp = document.createElement("small");
  openAiApiHelp.className = "ai-settings-help";
  openAiApiHelp.textContent = "기본 OFF. OPENAI_API_KEY가 있어도 이 옵션을 직접 켜기 전에는 호출하지 않습니다.";
  const openAiApiCopy = document.createElement("span");
  openAiApiCopy.className = "ai-settings-checkbox-copy";
  openAiApiCopy.append(openAiApiText, openAiApiHelp);
  openAiApiLabel.append(openAiApiCheckbox, openAiApiCopy);

  const providerStatusBox = document.createElement("div");
  providerStatusBox.className = "ai-settings-help";
  providerStatusBox.textContent = "자동 Provider 상태 확인 중…";

  const defaultAgentLabel = document.createElement("label");
  defaultAgentLabel.className = "ai-settings-field";
  const defaultAgentText = document.createElement("span");
  defaultAgentText.textContent = "기본 Agent (CRADLE OFF)";
  const defaultAgentSelect = document.createElement("select");
  defaultAgentSelect.className = "ai-settings-select";
  for (const row of AGENTS) {
    const option = document.createElement("option");
    option.value = row.agent;
    option.textContent = row.label;
    defaultAgentSelect.append(option);
  }
  defaultAgentLabel.append(defaultAgentText, defaultAgentSelect);

  const timeoutLabel = document.createElement("label");
  timeoutLabel.className = "ai-settings-field";
  const timeoutText = document.createElement("span");
  timeoutText.textContent = "Timeout (초)";
  const timeoutInput = document.createElement("input");
  timeoutInput.className = "ai-settings-number";
  timeoutInput.type = "number";
  timeoutInput.min = "10";
  timeoutInput.max = "3600";
  timeoutInput.step = "10";
  timeoutLabel.append(timeoutText, timeoutInput);

  const sensitiveLabel = document.createElement("label");
  sensitiveLabel.className = "ai-settings-checkbox";
  const sensitiveCheckbox = document.createElement("input");
  sensitiveCheckbox.type = "checkbox";
  const sensitiveText = document.createElement("span");
  sensitiveText.textContent = "민감 파일 접근 전 경고";
  const sensitiveHelp = document.createElement("div");
  sensitiveHelp.className = "ai-settings-help";
  sensitiveHelp.textContent =
    "대화별 복사본에는 키 파일이 들어가지 않으며, 이 경고 때문에 작업이 멈추지는 않습니다.";
  sensitiveLabel.append(sensitiveCheckbox, sensitiveText);

  const saveRuntimeButton = makeButton("실행 설정 저장", "ai-settings-action");
  const simpleSection = document.createElement("section");
  simpleSection.className = "ai-settings-section";
  const simpleTitle = document.createElement("h3");
  simpleTitle.textContent = "답변";
  const simpleLead = document.createElement("div");
  simpleLead.className = "ai-settings-help";
  simpleLead.textContent = "보통은 건드리지 않아도 됩니다.";
  simpleSection.append(
    simpleTitle,
    simpleLead,
    cradleLabel,
    webSearchLabel,
    geminiApiLabel,
    openAiApiLabel,
    saveRuntimeButton
  );

  runtimeSection.append(
    runtimeTitle,
    providerStatusBox,
    defaultAgentLabel,
    timeoutLabel,
    sensitiveLabel,
    sensitiveHelp
  );

  const agentsSection = document.createElement("section");
  agentsSection.className = "ai-settings-section";
  const agentsTitle = document.createElement("h3");
  agentsTitle.textContent = "Agents";
  const agentsLead = document.createElement("div");
  agentsLead.className = "ai-settings-help";
  agentsLead.textContent =
    "Windows에서 .exe와 .cmd는 모두 정식입니다. .cmd는 공식/npm 실행 파일이며 앱이 cmd로 실행합니다. 둘 다 있으면 .exe를 씁니다. 없을 때만 ‘찾을 수 없음 (설치)’를 누르세요.";
  const agentsGrid = document.createElement("div");
  agentsGrid.className = "ai-agent-settings-list";
  agentsSection.append(agentsTitle, agentsLead, agentsGrid);

  const runHistorySection = document.createElement("section");
  runHistorySection.className = "ai-settings-section";
  const runHistoryHeader = document.createElement("div");
  runHistoryHeader.className = "ai-agent-run-history-header";
  const runHistoryTitle = document.createElement("h3");
  runHistoryTitle.textContent = "최근 Agent 실행";
  const refreshRunHistoryButton = makeButton("새로고침", "ai-settings-action");
  runHistoryHeader.append(runHistoryTitle, refreshRunHistoryButton);
  const runHistoryList = document.createElement("div");
  runHistoryList.className = "ai-agent-run-history";
  const runHistoryEmpty = document.createElement("div");
  runHistoryEmpty.className = "ai-agent-run-history-empty";
  runHistoryEmpty.textContent = "실행 기록이 없습니다.";
  runHistoryList.append(runHistoryEmpty);
  runHistorySection.append(runHistoryHeader, runHistoryList);

  const checkpointSection = document.createElement("section");
  checkpointSection.className = "ai-settings-section";
  const checkpointHeader = document.createElement("div");
  checkpointHeader.className = "ai-checkpoint-history-header";
  const checkpointTitle = document.createElement("h3");
  checkpointTitle.textContent = "체크포인트 복원";
  const refreshCheckpointButton = makeButton("새로고침", "ai-settings-action");
  checkpointHeader.append(checkpointTitle, refreshCheckpointButton);
  const checkpointHelp = document.createElement("p");
  checkpointHelp.className = "ai-checkpoint-help";
  checkpointHelp.textContent = "원본 적용 직전 상태입니다. 복원 직전 현재 원본도 안전 체크포인트로 자동 저장됩니다.";
  const checkpointList = document.createElement("div");
  checkpointList.className = "ai-checkpoint-history";
  const checkpointEmpty = document.createElement("div");
  checkpointEmpty.className = "ai-checkpoint-history-empty";
  checkpointEmpty.textContent = "체크포인트가 없습니다.";
  checkpointList.append(checkpointEmpty);
  checkpointSection.append(checkpointHeader, checkpointHelp, checkpointList);

  const safetySection = document.createElement("section");
  safetySection.className = "ai-settings-section";
  const safetyTitle = document.createElement("h3");
  safetyTitle.textContent = "안전";
  const safetyList = document.createElement("div");
  safetyList.className = "ai-settings-safety-list";
  for (const text of [
    "원본 변경은 적용 버튼을 눌러야 반영됩니다.",
    "충돌이 있으면 원본 적용을 차단합니다.",
    "Agent는 대화별 작업 복사본에서 실행됩니다.",
  ]) {
    const item = document.createElement("div");
    item.className = "ai-settings-safety-item";
    item.textContent = `✓ ${text}`;
    safetyList.append(item);
  }
  safetySection.append(safetyTitle, safetyList);

  const backupSection = document.createElement("section");
  backupSection.className = "ai-settings-section";
  const backupTitle = document.createElement("h3");
  backupTitle.textContent = "대화 백업";
  const backupLead = document.createElement("div");
  backupLead.className = "ai-settings-help";
  backupLead.textContent =
    "채팅 기록을 JSON으로 내보내거나 가져옵니다. 대화 목록에서도 같은 기능을 쓸 수 있습니다.";
  const backupActions = document.createElement("div");
  backupActions.className = "ai-settings-easy-actions";
  const exportChatsButton = makeButton("전체 내보내기", "ai-settings-action");
  const importMergeButton = makeButton("가져오기(병합)", "ai-settings-action");
  const importReplaceButton = makeButton("가져오기(교체)", "ai-settings-action");
  backupActions.append(exportChatsButton, importMergeButton, importReplaceButton);
  backupSection.append(backupTitle, backupLead, backupActions);

  const characterSection = document.createElement("section");
  characterSection.className = "ai-settings-section";
  const characterTitle = document.createElement("h3");
  characterTitle.textContent = "nizima / Booth 모델";
  const characterLead = document.createElement("div");
  characterLead.className = "ai-settings-help";
  characterLead.textContent =
    "Booth/nizima에서 ZIP을 받은 뒤 ZIP 업로드, 또는 압축 푼 폴더를 추가하세요. (이 Mac에만 저장)";
  const characterPath = document.createElement("div");
  characterPath.className = "ai-settings-path";
  characterPath.textContent = "저장 위치 확인 중…";
  const boothPicksTitle = document.createElement("div");
  boothPicksTitle.className = "ai-settings-help";
  boothPicksTitle.textContent =
    "추천 무료 원작 5개 (Booth 0엔 · 인기순 · 원작만)";
  const boothPicks = document.createElement("div");
  boothPicks.className = "ai-booth-picks";
  for (const pick of BOOTH_FREE_ORIGINAL_PICKS) {
    const row = document.createElement("div");
    row.className = "ai-user-live2d-row";
    const label = document.createElement("span");
    label.textContent = `${pick.name} · ${pick.note}`;
    const openBtn = makeButton("열기", "ai-settings-action");
    openBtn.addEventListener("click", () => {
      void openBoothFreePick(pick.url).catch((error) => {
        message.textContent = errorText(error);
      });
    });
    row.append(label, openBtn);
    boothPicks.append(row);
  }
  const characterList = document.createElement("div");
  characterList.className = "ai-user-live2d-list";
  const characterActions = document.createElement("div");
  characterActions.className = "ai-settings-easy-actions";
  const importZipButton = makeButton("ZIP/RAR 업로드", "ai-settings-action");
  const importModelButton = makeButton("모델 폴더 추가", "ai-settings-action");
  const dedupeModelsButton = makeButton("중복 정리", "ai-settings-action");
  const openModelDirButton = makeButton("폴더 열기", "ai-settings-action");
  const openNizimaButton = makeButton("nizima", "ai-settings-action");
  const openBoothButton = makeButton("Booth 무료", "ai-settings-action");
  characterActions.append(
    importZipButton,
    importModelButton,
    dedupeModelsButton,
    openModelDirButton,
    openNizimaButton,
    openBoothButton
  );
  characterSection.append(
    characterTitle,
    characterLead,
    boothPicksTitle,
    boothPicks,
    characterPath,
    characterList,
    characterActions
  );

  const tabs = document.createElement("div");
  tabs.className = "ai-settings-tabs";
  tabs.setAttribute("role", "tablist");

  const basicPane = document.createElement("div");
  basicPane.className = "ai-settings-pane";
  basicPane.dataset.pane = "basic";
  basicPane.append(
    easySection,
    simpleSection,
    projectSection,
    safetySection
  );

  const accountsPane = document.createElement("div");
  accountsPane.className = "ai-settings-pane";
  accountsPane.dataset.pane = "accounts";
  accountsPane.hidden = true;
  accountsPane.append(accountsSection);

  const chatPane = document.createElement("div");
  chatPane.className = "ai-settings-pane";
  chatPane.dataset.pane = "chat";
  chatPane.hidden = true;
  chatPane.append(backupSection);

  const characterPane = document.createElement("div");
  characterPane.className = "ai-settings-pane";
  characterPane.dataset.pane = "character";
  characterPane.hidden = true;
  characterPane.append(characterSection);

  const advancedPane = document.createElement("div");
  advancedPane.className = "ai-settings-pane";
  advancedPane.dataset.pane = "advanced";
  advancedPane.hidden = true;
  advancedPane.append(
    environmentSection,
    runtimeSection,
    agentsSection,
    runHistorySection,
    checkpointSection
  );

  const tabDefs: Array<{
    id: "basic" | "accounts" | "chat" | "character" | "advanced";
    label: string;
  }> = [
    { id: "basic", label: "기본" },
    { id: "accounts", label: "로그인" },
    { id: "chat", label: "대화" },
    { id: "character", label: "캐릭터" },
    { id: "advanced", label: "고급" },
  ];
  const panes = {
    basic: basicPane,
    accounts: accountsPane,
    chat: chatPane,
    character: characterPane,
    advanced: advancedPane,
  } as const;

  const setActiveTab = (id: keyof typeof panes) => {
    for (const def of tabDefs) {
      const button = tabs.querySelector<HTMLButtonElement>(
        `[data-tab="${def.id}"]`
      );
      const pane = panes[def.id];
      const active = def.id === id;
      if (button) {
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
      }
      pane.hidden = !active;
    }
    if (id === "accounts") {
      void refreshLoginStatus();
      void refreshWebAccounts();
    }
  };

  for (const def of tabDefs) {
    const button = makeButton(def.label, "ai-settings-tab");
    button.dataset.tab = def.id;
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => setActiveTab(def.id));
    tabs.append(button);
  }
  setActiveTab("basic");

  overlay.append(
    header,
    tabs,
    message,
    basicPane,
    accountsPane,
    chatPane,
    characterPane,
    advancedPane
  );
  if (toolbarEnd && chatCloseButton && toolbarEnd.contains(chatCloseButton)) {
    toolbarEnd.insertBefore(launcher, chatCloseButton);
  } else {
    toolbar.append(launcher);
  }
  chatPanel.append(overlay);

  const positionSettingsPanel = (): void => {
    const top = toolbar.offsetTop + toolbar.offsetHeight + 4;
    overlay.style.top = `${top}px`;
  };

  const closeSettings = (): void => {
    overlay.hidden = true;
    window.dispatchEvent(
      new CustomEvent("ai-character:settings-closed")
    );
  };

  const openSettings = (): void => {
    chatPanel.classList.add("open");
    positionSettingsPanel();
    overlay.hidden = false;
    overlay.scrollTop = 0;
    void getCurrentWindow()
      .setIgnoreCursorEvents(false)
      .catch(() => undefined);
    window.dispatchEvent(
      new CustomEvent("ai-character:settings-opened")
    );
    void refreshAll();
    void renderUserModels();
  };

  const pathNodes = new Map<AgentKind, HTMLElement>();
  const statusNodes = new Map<AgentKind, HTMLElement>();
  const actionButtons = new Map<AgentKind, HTMLButtonElement>();
  const installButtons = new Map<AgentKind, HTMLButtonElement>();
  const agentArgsInputs = new Map<AgentKind, HTMLTextAreaElement>();
  const agentAdvancedSummaries = new Map<AgentKind, HTMLElement>();
  const agentModelSelects = new Map<AgentKind, HTMLSelectElement>();
  const agentModelInputs = new Map<AgentKind, HTMLInputElement>();
  const agentModelPresets = new Map<AgentKind, string[]>();

  const countExtraArgs = (agent: AgentKind): number => {
    const input = agentArgsInputs.get(agent);
    return (input?.value ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean).length;
  };

  const updateAdvancedSummary = (agent: AgentKind): void => {
    const summary = agentAdvancedSummaries.get(agent);
    if (!summary) return;
    const count = countExtraArgs(agent);
    summary.textContent = count > 0 ? `고급 옵션 · ${count}개 설정됨` : "고급 옵션";
  };

  const renderModelOptions = (agent: AgentKind, selected: string): void => {
    const select = agentModelSelects.get(agent);
    const input = agentModelInputs.get(agent);
    if (!select || !input) {
      return;
    }
    const presets = agentModelPresets.get(agent) ?? [];
    select.replaceChildren();
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "CLI 기본값";
    select.append(defaultOption);
    for (const model of presets) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      select.append(option);
    }
    if (selected && !presets.includes(selected)) {
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = `${selected} (사용자 지정)`;
      select.append(option);
    }
    select.value = selected;
    input.value = selected;
  };

  for (const row of AGENTS) {
    const card = document.createElement("div");
    card.className = "ai-agent-settings-row";

    const info = document.createElement("div");
    info.className = "ai-agent-settings-info";

    const name = document.createElement("strong");
    name.textContent = row.label;

    const status = document.createElement("span");
    status.className = "ai-agent-settings-status";
    status.textContent = "확인 전";

    const path = document.createElement("code");
    path.className = "ai-agent-settings-path";
    path.textContent = "-";

    const choose = makeButton("경로 지정", "ai-settings-action");
    const login = makeButton("로그인", "ai-settings-action");
    const install = makeButton("찾을 수 없음 (설치)", "ai-settings-action ai-settings-install");
    install.hidden = true;
    install.title = `${row.label} 공식 설치 파일을 받아 설치합니다`;
    const rowActions = document.createElement("div");
    rowActions.className = "ai-agent-settings-actions";
    rowActions.append(choose, login);

    const modelField = document.createElement("div");
    modelField.className = "ai-agent-model-field";

    const modelTitle = document.createElement("span");
    modelTitle.textContent = "모델 프리셋";

    const modelSelect = document.createElement("select");
    modelSelect.className = "ai-agent-model-select";
    const defaultModelOption = document.createElement("option");
    defaultModelOption.value = "";
    defaultModelOption.textContent = "CLI 기본값";
    modelSelect.append(defaultModelOption);

    const modelInput = document.createElement("input");
    modelInput.className = "ai-agent-model-input";
    modelInput.type = "text";
    modelInput.maxLength = 128;
    modelInput.placeholder = "모델 이름";

    const modelActions = document.createElement("div");
    modelActions.className = "ai-agent-model-actions";
    const addPreset = makeButton("프리셋 추가", "ai-settings-action");
    const deletePreset = makeButton("프리셋 삭제", "ai-settings-action");
    modelActions.append(addPreset, deletePreset);
    modelField.append(modelTitle, modelSelect, modelInput, modelActions);

    const advanced = document.createElement("details");
    advanced.className = "ai-agent-advanced";
    const summary = document.createElement("summary");
    summary.textContent = "고급 옵션";
    const advancedBody = document.createElement("div");
    advancedBody.className = "ai-agent-advanced-body";

    const argsLabel = document.createElement("label");
    argsLabel.className = "ai-agent-args-field";
    const argsText = document.createElement("span");
    argsText.textContent = "추가 CLI 인자";
    const argsHelp = document.createElement("span");
    argsHelp.className = "ai-agent-args-help";
    argsHelp.textContent = "보통은 비워두세요. 해당 Agent CLI에 별도 옵션이 필요할 때만 사용합니다.";
    const argsInput = document.createElement("textarea");
    argsInput.className = "ai-agent-args-input";
    argsInput.rows = 2;
    argsInput.placeholder = "예: --flag\nvalue";
    const argsRule = document.createElement("span");
    argsRule.className = "ai-agent-args-rule";
    argsRule.textContent = "입력 규칙: 한 줄에 인자 하나";
    argsLabel.append(argsText, argsHelp, argsInput, argsRule);
    advancedBody.append(argsLabel);
    advanced.append(summary, advancedBody);

    info.append(name, status, install, path);
    card.append(info, rowActions, modelField, advanced);
    agentsGrid.append(card);

    pathNodes.set(row.agent, path);
    statusNodes.set(row.agent, status);
    actionButtons.set(row.agent, choose);
    installButtons.set(row.agent, install);
    agentArgsInputs.set(row.agent, argsInput);
    agentAdvancedSummaries.set(row.agent, summary);
    agentModelSelects.set(row.agent, modelSelect);
    agentModelInputs.set(row.agent, modelInput);
    agentModelPresets.set(row.agent, []);

    argsInput.addEventListener("input", () => {
      updateAdvancedSummary(row.agent);
    });

    modelSelect.addEventListener("change", () => {
      modelInput.value = modelSelect.value;
    });

    addPreset.addEventListener("click", () => {
      const value = modelInput.value.trim();
      if (!value) {
        message.textContent = `${row.label} 모델 이름을 입력해주세요.`;
        return;
      }
      if (value.length > 128) {
        message.textContent = `${row.label} 모델 이름은 128자 이하여야 합니다.`;
        return;
      }
      const presets = [...(agentModelPresets.get(row.agent) ?? [])];
      if (!presets.includes(value)) {
        if (presets.length >= 16) {
          message.textContent = `${row.label} 모델 프리셋은 최대 16개까지 저장할 수 있습니다.`;
          return;
        }
        presets.push(value);
        agentModelPresets.set(row.agent, presets);
      }
      renderModelOptions(row.agent, value);
      message.textContent = `${row.label} 모델 프리셋을 추가했습니다. 실행 설정 저장을 눌러 확정하세요.`;
    });

    deletePreset.addEventListener("click", () => {
      const selected = modelSelect.value || modelInput.value.trim();
      if (!selected) {
        message.textContent = "삭제할 모델 프리셋을 선택해주세요.";
        return;
      }
      const presets = (agentModelPresets.get(row.agent) ?? []).filter(
        (model) => model !== selected
      );
      agentModelPresets.set(row.agent, presets);
      renderModelOptions(row.agent, "");
      message.textContent = `${row.label} 모델 프리셋을 삭제했습니다. 실행 설정 저장을 눌러 확정하세요.`;
    });

    choose.addEventListener("click", async () => {
      choose.disabled = true;
      message.textContent = `${row.label} 실행 파일을 선택하세요.`;
      try {
        const selected = await chooseAgentExecutable(row.agent);
        path.textContent = selected;
        path.title = selected;
        status.textContent = "설치됨";
        status.dataset.state = "ok";
        status.hidden = false;
        install.hidden = true;
        message.textContent = `${row.label} 경로를 저장했습니다.`;
      } catch (error) {
        message.textContent = errorText(error);
      } finally {
        choose.disabled = false;
      }
    });

    login.addEventListener("click", async () => {
      login.disabled = true;
      message.textContent = `${row.label} 로그인을 시작합니다…`;
      try {
        message.textContent = await launchAgentLogin(row.agent);
      } catch (error) {
        message.textContent = errorText(error);
      } finally {
        login.disabled = false;
      }
    });

    install.addEventListener("click", async () => {
      install.disabled = true;
      choose.disabled = true;
      login.disabled = true;
      status.hidden = true;
      install.hidden = false;
      install.textContent = "설치 중…";
      message.textContent = `${row.label} 설치 파일을 받아 설치합니다…`;
      try {
        const result = await installAgentCli(row.agent);
        message.textContent = result.ok
          ? `${row.label} 설치 완료. ${result.message}`
          : `${row.label} 설치 실패. ${result.message}`;
        await refreshAgents();
      } catch (error) {
        status.hidden = false;
        status.textContent = "찾을 수 없음";
        status.dataset.state = "missing";
        install.hidden = false;
        install.textContent = "찾을 수 없음 (설치)";
        message.textContent = errorText(error);
      } finally {
        install.disabled = false;
        choose.disabled = false;
        login.disabled = false;
      }
    });
  }

  function formatRunStatus(status: AgentRunRecord["status"]): string {
    if (status === "completed") return "성공";
    if (status === "cancelled") return "취소";
    if (status === "failed") return "실패";
    return "실행 중";
  }

  function formatDuration(durationMs: number | null): string {
    if (durationMs == null) return "-";
    if (durationMs < 1000) return `${durationMs}ms`;
    return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}초`;
  }

  function renderRunHistory(records: AgentRunRecord[]): void {
    runHistoryList.replaceChildren();
    if (records.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ai-agent-run-history-empty";
      empty.textContent = "실행 기록이 없습니다.";
      runHistoryList.append(empty);
      return;
    }

    for (const record of records) {
      const row = document.createElement("article");
      row.className = "ai-agent-run-history-row";
      row.dataset.status = record.status;

      const top = document.createElement("div");
      top.className = "ai-agent-run-history-top";
      const agent = document.createElement("strong");
      agent.textContent = AGENTS.find((item) => item.agent === record.agent)?.label ?? record.agent;
      const status = document.createElement("span");
      status.className = "ai-agent-run-history-status";
      status.textContent = formatRunStatus(record.status);
      top.append(agent, status);

      const meta = document.createElement("div");
      meta.className = "ai-agent-run-history-meta";
      const started = new Date(record.startedAt).toLocaleString();
      const model = record.model ? ` · ${record.model}` : "";
      const conversation = record.conversationId ? ` · 대화 ${record.conversationId.slice(0, 8)}` : "";
      meta.textContent = `${started} · ${formatDuration(record.durationMs)}${model}${conversation}`;

      row.append(top, meta);

      if (record.errorSummary) {
        const error = document.createElement("div");
        error.className = "ai-agent-run-history-error";
        error.textContent = record.errorSummary;
        row.append(error);
      }

      if (record.errorDetail) {
        const details = document.createElement("details");
        details.className = "ai-agent-run-history-detail";
        const summary = document.createElement("summary");
        summary.textContent = "기술 상세";
        const pre = document.createElement("pre");
        pre.textContent = record.errorDetail;
        details.append(summary, pre);
        row.append(details);
      }

      runHistoryList.append(row);
    }
  }

  function checkpointPurpose(record: CheckpointRecord): string {
    return record.purpose === "restore_safety" ? "복원 전 안전 백업" : "원본 적용 전";
  }

  function renderCheckpoints(records: CheckpointRecord[]): void {
    checkpointList.replaceChildren();
    if (records.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ai-checkpoint-history-empty";
      empty.textContent = "체크포인트가 없습니다.";
      checkpointList.append(empty);
      return;
    }

    for (const record of records) {
      const row = document.createElement("article");
      row.className = "ai-checkpoint-history-row";

      const info = document.createElement("div");
      info.className = "ai-checkpoint-history-info";
      const title = document.createElement("strong");
      title.textContent = checkpointPurpose(record);
      const meta = document.createElement("div");
      meta.className = "ai-checkpoint-history-meta";
      const created = new Date(record.createdAt).toLocaleString();
      const conversation = record.conversationId
        ? ` · 대화 ${record.conversationId.slice(0, 8)}`
        : "";
      meta.textContent = `${created} · ${record.changedCount}개 파일${conversation}`;
      const id = document.createElement("code");
      id.className = "ai-checkpoint-history-id";
      id.textContent = record.id;
      info.append(title, meta, id);

      const restore = makeButton("복원", "ai-settings-action");
      restore.addEventListener("click", async () => {
        const ok = window.confirm(
          `체크포인트 ${record.id} 상태로 원본 프로젝트를 복원할까요?\n\n복원 직전 현재 원본은 새 안전 체크포인트로 저장됩니다.`
        );
        if (!ok) return;
        restore.disabled = true;
        message.textContent = "체크포인트 복원 중…";
        try {
          const result = await restoreProjectCheckpoint(record.id);
          message.textContent = `체크포인트를 복원했습니다 (${result.restoredCount}개 파일). 복원 전 상태: ${result.safetyCheckpointId}`;
          await refreshCheckpoints();
        } catch (error) {
          message.textContent = errorText(error);
        } finally {
          restore.disabled = false;
        }
      });

      row.append(info, restore);
      checkpointList.append(row);
    }
  }

  async function refreshCheckpoints(): Promise<void> {
    refreshCheckpointButton.disabled = true;
    try {
      const records = await getProjectCheckpoints(30);
      renderCheckpoints(records);
    } catch (error) {
      checkpointList.replaceChildren();
      const failure = document.createElement("div");
      failure.className = "ai-checkpoint-history-empty";
      failure.textContent = `체크포인트를 읽지 못했습니다: ${errorText(error)}`;
      checkpointList.append(failure);
    } finally {
      refreshCheckpointButton.disabled = false;
    }
  }

  async function refreshRunHistory(): Promise<void> {
    refreshRunHistoryButton.disabled = true;
    try {
      const records = await getAgentRuns(20);
      renderRunHistory(records);
    } catch (error) {
      runHistoryList.replaceChildren();
      const failure = document.createElement("div");
      failure.className = "ai-agent-run-history-empty";
      failure.textContent = `실행 기록을 읽지 못했습니다: ${errorText(error)}`;
      runHistoryList.append(failure);
    } finally {
      refreshRunHistoryButton.disabled = false;
    }
  }

  async function refreshProject(): Promise<void> {
    try {
      const path = await getProjectDirectory();
      projectPath.textContent = path ?? "지정되지 않음";
    } catch (error) {
      projectPath.textContent = "프로젝트 폴더를 읽지 못했습니다.";
      message.textContent = errorText(error);
    }
  }

  async function refreshPreferences(): Promise<void> {
    try {
      const preferences = await getAppPreferences();
      defaultAgentSelect.value = preferences.defaultAgent;
      cradleCheckbox.checked = preferences.cradleEnabled;
      webSearchCheckbox.checked = preferences.autoWebSearch;
      geminiApiCheckbox.checked = preferences.geminiApiEnabled;
      openAiApiCheckbox.checked = preferences.allowPaidOpenAiApi;
      closeAfterHandoffCheckbox.checked = preferences.closeWebAccountAfterHandoff;
      closeWhenDoneCheckbox.checked = preferences.closeWebAccountWhenCradleDone;
      timeoutInput.value = String(preferences.timeoutSeconds);
      sensitiveCheckbox.checked = preferences.warnSensitiveFiles;
      for (const row of AGENTS) {
        const input = agentArgsInputs.get(row.agent);
        if (input) {
          input.value = (preferences.agentExtraArgs[row.agent] ?? []).join("\n");
          updateAdvancedSummary(row.agent);
        }
        const presets = [...(preferences.agentModelPresets[row.agent] ?? [])];
        agentModelPresets.set(row.agent, presets);
        renderModelOptions(row.agent, preferences.agentModels[row.agent] ?? "");
      }
    } catch (error) {
      message.textContent = errorText(error);
    }
  }

  async function refreshAgents(): Promise<void> {
    await Promise.all(
      AGENTS.map(async ({ agent }) => {
        const path = pathNodes.get(agent);
        const status = statusNodes.get(agent);
        const button = actionButtons.get(agent);
        const install = installButtons.get(agent);
        if (!path || !status || !button) {
          return;
        }
        button.disabled = true;
        if (install) {
          install.disabled = true;
        }
        status.hidden = false;
        status.textContent = "검색 중…";
        status.dataset.state = "loading";
        try {
          const detected = await detectAgent(agent);
          path.textContent = detected;
          path.title = detected;
          status.textContent = "설치됨";
          status.dataset.state = "ok";
          status.hidden = false;
          if (install) {
            install.hidden = true;
          }
        } catch {
          path.textContent = "자동 감지 실패 — 설치를 눌러 공식 파일을 받으세요.";
          path.removeAttribute("title");
          status.hidden = true;
          status.textContent = "찾을 수 없음";
          status.dataset.state = "missing";
          if (install) {
            install.hidden = false;
            install.textContent = "찾을 수 없음 (설치)";
          }
        } finally {
          button.disabled = false;
          if (install) {
            install.disabled = false;
          }
        }
      })
    );
  }

  async function refreshEnvironment(): Promise<void> {
    refreshEnvironmentButton.disabled = true;
    prepareEnvironmentButton.disabled = true;
    try {
      const status = await getCradleEnvironmentStatus();
      const gitLabel = status.gitInstalled
        ? `Git ✓ ${status.gitVersion ?? "설치됨"}`
        : "Git ✗ 설치 필요";
      const workspaceLabel = status.workspaceGitReady
        ? "Workspace Git ✓"
        : "Workspace Git: 첫 CRADLE 코드 작업 시 자동 준비";
      environmentStatus.textContent = `${gitLabel} / ${workspaceLabel} — ${status.message}`;
      installGitButton.hidden = status.gitInstalled || !status.installSupported;
      prepareEnvironmentButton.disabled = !status.gitInstalled;
    } catch (error) {
      environmentStatus.textContent = `CRADLE 환경 상태를 읽지 못했습니다: ${errorText(error)}`;
      installGitButton.hidden = false;
    } finally {
      refreshEnvironmentButton.disabled = false;
      if (!installGitButton.hidden) {
        prepareEnvironmentButton.disabled = true;
      }
    }
  }

  async function refreshLoginStatus(): Promise<void> {
    try {
      const snapshot = (await getUsageSnapshot()) as {
        providers?: Array<{
          id?: string;
          label?: string;
          account?: {
            connected?: boolean;
            email?: string | null;
            keyHint?: string | null;
            name?: string | null;
            plan?: string | null;
            loginWith?: string | null;
            linesExtra?: string[];
          };
        }>;
        keys?: Array<{
          env?: string;
          label?: string;
          configured?: boolean;
          hint?: string | null;
        }>;
      };
      renderLoginStatus(snapshot);
    } catch (error) {
      loginStatusList.replaceChildren();
      const failure = document.createElement("div");
      failure.className = "ai-settings-help";
      failure.textContent = `로그인 상태를 읽지 못했습니다: ${errorText(error)}`;
      loginStatusList.append(failure);
    }
  }

  function renderLoginStatus(snapshot: {
    providers?: Array<{
      id?: string;
      label?: string;
      account?: {
        connected?: boolean;
        email?: string | null;
        keyHint?: string | null;
        name?: string | null;
        plan?: string | null;
        loginWith?: string | null;
        linesExtra?: string[];
      };
    }>;
    keys?: Array<{
      env?: string;
      label?: string;
      configured?: boolean;
      hint?: string | null;
    }>;
  }): void {
    const agentIds: AgentKind[] = ["claude", "codex", "cursor", "antigravity"];
    const rows: HTMLElement[] = [];

    for (const id of agentIds) {
      const provider = (snapshot.providers ?? []).find((item) => item.id === id);
      const account = provider?.account;
      const connected = Boolean(account?.connected || account?.email || account?.keyHint);
      const connectedDetail = [
        account?.plan && `요금제 ${account.plan}`,
        account?.loginWith && `로그인 ${account.loginWith}`,
      ]
        .filter(Boolean)
        .join(" · ");
      const detail = connected
        ? connectedDetail || "로그인되어 있어요"
        : "로그인 정보 없음 — 로그인이 필요합니다";
      rows.push(
        makeLoginRow({
          label: provider?.label || id,
          connected,
          detail,
          actionLabel: connected ? "다시 로그인" : "로그인",
          onAction: () => startAgentLogin(id, provider?.label || id),
        })
      );
    }

    for (const key of snapshot.keys ?? []) {
      rows.push(
        makeLoginRow({
          label: key.label || key.env || "API 키",
          connected: Boolean(key.configured),
          detail: key.configured
            ? "키가 준비되어 있어요"
            : "keys.env에 없음 — 키 파일을 열어 넣으세요",
          actionLabel: "키 파일 열기",
          onAction: () => openKeysButton.click(),
        })
      );
    }

    loginStatusList.replaceChildren(...rows);
  }

  function makeLoginRow(options: {
    label: string;
    connected: boolean;
    detail: string;
    actionLabel: string;
    onAction: () => void | Promise<void>;
  }): HTMLElement {
    const row = document.createElement("div");
    row.className = "ai-web-account-row";
    const meta = document.createElement("div");
    meta.className = "ai-web-account-meta";
    const title = document.createElement("strong");
    const dot = document.createElement("span");
    dot.className = `usage-dot ${options.connected ? "is-on" : ""}`;
    title.append(
      dot,
      document.createTextNode(
        ` ${options.label} · ${options.connected ? "연결됨" : "미연결"}`
      )
    );
    const state = document.createElement("small");
    state.className = "ai-settings-help";
    state.textContent = options.detail;
    meta.append(title, state);
    const actions = document.createElement("div");
    actions.className = "ai-web-account-actions";
    const button = makeButton(options.actionLabel, "ai-settings-action");
    button.addEventListener("click", () => {
      void options.onAction();
    });
    actions.append(button);
    row.append(meta, actions);
    return row;
  }

  async function startAgentLogin(agent: AgentKind, label: string): Promise<void> {
    message.textContent = `${label} 로그인을 시작합니다…`;
    try {
      message.textContent = `${await launchAgentLogin(agent)} 완료되면 아래 상태가 연결됨으로 바뀝니다.`;
      for (let i = 0; i < 12; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
        await refreshLoginStatus();
      }
    } catch (error) {
      message.textContent = errorText(error);
    }
  }

  async function refreshWebAccounts(): Promise<void> {
    try {
      const accounts = await listWebAccounts();
      renderWebAccounts(accounts);
    } catch (error) {
      accountsList.replaceChildren();
      const failure = document.createElement("div");
      failure.className = "ai-settings-help";
      failure.textContent = `계정 목록을 읽지 못했습니다: ${errorText(error)}`;
      accountsList.append(failure);
    }
  }

  function renderWebAccounts(accounts: WebAccountSlot[]): void {
    accountsList.replaceChildren(
      ...accounts.map((account) => {
        const row = document.createElement("div");
        row.className = "ai-web-account-row";

        const meta = document.createElement("div");
        meta.className = "ai-web-account-meta";
        const title = document.createElement("strong");
        title.textContent = `${WEB_ACCOUNT_PROVIDER_LABELS[account.provider]} · ${account.label}`;
        const state = document.createElement("small");
        state.className = "ai-settings-help";
        const bits = [
          account.preferred ? "기본" : null,
          account.enabled ? "사용" : "꺼짐",
          account.open ? "창 열림" : "창 닫힘",
        ].filter(Boolean);
        state.textContent = bits.join(" · ");
        meta.append(title, state);

        const actions = document.createElement("div");
        actions.className = "ai-web-account-actions";
        const openButton = makeButton("열기", "ai-settings-action");
        const preferredButton = makeButton(
          account.preferred ? "기본 ✓" : "기본으로",
          "ai-settings-action"
        );
        preferredButton.disabled = account.preferred;
        actions.append(openButton, preferredButton);
        row.append(meta, actions);

        openButton.addEventListener("click", async () => {
          openButton.disabled = true;
          message.textContent = `${account.label} 창을 엽니다…`;
          try {
            await openWebAccount(account.id);
            message.textContent = `${account.label} 창을 열었습니다. 이 창에서만 해당 계정으로 로그인하세요.`;
            await refreshWebAccounts();
          } catch (error) {
            message.textContent = errorText(error);
          } finally {
            openButton.disabled = false;
          }
        });

        preferredButton.addEventListener("click", async () => {
          preferredButton.disabled = true;
          try {
            const next = accounts.map((item) => ({
              ...item,
              preferred:
                item.provider === account.provider ? item.id === account.id : item.preferred,
            }));
            await updateWebAccounts(next);
            message.textContent = `${account.label}을(를) ${WEB_ACCOUNT_PROVIDER_LABELS[account.provider]} 기본 계정으로 지정했습니다.`;
            await refreshWebAccounts();
          } catch (error) {
            message.textContent = errorText(error);
            preferredButton.disabled = false;
          }
        });

        return row;
      })
    );
  }

  async function refreshAutomaticProviders(): Promise<void> {
    try {
      const statuses = await getAutomaticProviderStatuses();
      providerStatusBox.textContent = statuses.map((provider) => {
        const label = provider.provider === "gemini_api" ? "Gemini API" : "OpenAI API";
        const state = provider.available ? `구성됨 · ${provider.model}` : (provider.reason ?? "사용 불가");
        return `${label}: ${state}`;
      }).join(" / ");
    } catch (error) {
      providerStatusBox.textContent = `자동 Provider 상태를 읽지 못했습니다: ${errorText(error)}`;
    }
  }

  function renderFreeAutoReadiness(readiness: FreeAutoReadiness): void {
    easyStatus.textContent = readiness.message;
    easyStatus.dataset.state = readiness.handsFreeReady ? "ready" : "needs-setup";
    easyPath.textContent = readiness.keysEnvPath
      ? `키 파일: ${readiness.keysEnvPath}`
      : "키 파일: 아직 없음 (키 파일 열기로 생성)";
    const rows: Array<[string, boolean]> = [
      ["CRADLE 자동 분배", readiness.cradleEnabled],
      ["Gemini 공식 API 키", readiness.geminiApiConfigured && readiness.geminiApiEnabled],
      ["Jina 웹검색 키 (선택)", readiness.jinaApiConfigured],
      ["Claude CLI (코드 수정용)", readiness.claudeCliReady],
    ];
    easyChecklist.replaceChildren(
      ...rows.map(([label, ok]) => {
        const item = document.createElement("li");
        item.dataset.state = ok ? "ok" : "missing";
        item.textContent = `${ok ? "✓" : "·"} ${label}`;
        return item;
      })
    );
    easyNext.textContent = readiness.nextSteps.length > 0
      ? readiness.nextSteps.join(" ")
      : "추가 설정 없이 채팅을 시작하세요.";
    enableFreeAutoButton.textContent =
      readiness.cradleEnabled && readiness.autoWebSearch && readiness.geminiApiEnabled
        ? "무료 자동 설정 다시 적용"
        : "무료 자동 모드 켜기";
  }

  async function refreshFreeAutoReadiness(): Promise<void> {
    try {
      const readiness = await getFreeAutoReadiness();
      renderFreeAutoReadiness(readiness);
    } catch (error) {
      easyStatus.textContent = `자동 준비 상태를 읽지 못했습니다: ${errorText(error)}`;
      easyStatus.dataset.state = "needs-setup";
      easyChecklist.replaceChildren();
      easyNext.textContent = "";
    }
  }

  async function refreshAll(): Promise<void> {
    message.textContent = "";
    await Promise.all([
      refreshProject(),
      refreshPreferences(),
      refreshEnvironment(),
      refreshFreeAutoReadiness(),
      refreshWebAccounts(),
      refreshLoginStatus(),
      refreshAutomaticProviders(),
      refreshAgents(),
      refreshRunHistory(),
      refreshCheckpoints(),
    ]);
  }

  saveRuntimeButton.addEventListener("click", async () => {
    const timeoutSeconds = Number(timeoutInput.value);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) {
      message.textContent = "Timeout은 10초에서 3600초 사이의 정수여야 합니다.";
      return;
    }

    saveRuntimeButton.disabled = true;
    message.textContent = "실행 설정 저장 중…";
    try {
      const agentExtraArgs: Partial<Record<AgentKind, string[]>> = {};
      const agentModels: Partial<Record<AgentKind, string>> = {};
      const agentModelPresetValues: Partial<Record<AgentKind, string[]>> = {};
      for (const row of AGENTS) {
        const input = agentArgsInputs.get(row.agent);
        const args = (input?.value ?? "")
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean);
        if (args.length > 0) {
          agentExtraArgs[row.agent] = args;
        }
        const model = agentModelInputs.get(row.agent)?.value.trim() ?? "";
        if (model) {
          agentModels[row.agent] = model;
        }
        const presets = agentModelPresets.get(row.agent) ?? [];
        if (presets.length > 0) {
          agentModelPresetValues[row.agent] = presets;
        }
      }

      const saved = await setAppPreferences({
        defaultAgent: defaultAgentSelect.value as AgentKind,
        cradleEnabled: cradleCheckbox.checked,
        autoWebSearch: webSearchCheckbox.checked,
        geminiApiEnabled: geminiApiCheckbox.checked,
        allowPaidOpenAiApi: openAiApiCheckbox.checked,
        closeWebAccountAfterHandoff: closeAfterHandoffCheckbox.checked,
        closeWebAccountWhenCradleDone: closeWhenDoneCheckbox.checked,
        timeoutSeconds,
        warnSensitiveFiles: sensitiveCheckbox.checked,
        agentExtraArgs,
        agentModels,
        agentModelPresets: agentModelPresetValues,
      });
      defaultAgentSelect.value = saved.defaultAgent;
      cradleCheckbox.checked = saved.cradleEnabled;
      webSearchCheckbox.checked = saved.autoWebSearch;
      geminiApiCheckbox.checked = saved.geminiApiEnabled;
      openAiApiCheckbox.checked = saved.allowPaidOpenAiApi;
      closeAfterHandoffCheckbox.checked = saved.closeWebAccountAfterHandoff;
      closeWhenDoneCheckbox.checked = saved.closeWebAccountWhenCradleDone;
      timeoutInput.value = String(saved.timeoutSeconds);
      sensitiveCheckbox.checked = saved.warnSensitiveFiles;
      for (const row of AGENTS) {
        const input = agentArgsInputs.get(row.agent);
        if (input) {
          input.value = (saved.agentExtraArgs[row.agent] ?? []).join("\n");
          updateAdvancedSummary(row.agent);
        }
        const presets = [...(saved.agentModelPresets[row.agent] ?? [])];
        agentModelPresets.set(row.agent, presets);
        renderModelOptions(row.agent, saved.agentModels[row.agent] ?? "");
      }
      await refreshAutomaticProviders();
      window.dispatchEvent(
        new CustomEvent("ai-character:preferences-updated", { detail: saved })
      );
      message.textContent = "CRADLE/Agent 실행 설정을 저장했습니다.";
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      saveRuntimeButton.disabled = false;
    }
  });

  refreshEnvironmentButton.addEventListener("click", () => {
    void refreshEnvironment();
  });

  refreshReadyButton.addEventListener("click", () => {
    void refreshFreeAutoReadiness();
  });

  refreshAccountsButton.addEventListener("click", () => {
    void refreshWebAccounts();
    void refreshLoginStatus();
  });

  openAllAccountsButton.addEventListener("click", async () => {
    openAllAccountsButton.disabled = true;
    message.textContent = "모든 계정 창을 엽니다…";
    try {
      const opened = await openAllWebAccounts();
      message.textContent = `${opened.length}개 계정 창을 열었습니다. 창마다 다른 계정으로 로그인하세요. 로그인은 창끼리 섞이지 않습니다.`;
      await refreshWebAccounts();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      openAllAccountsButton.disabled = false;
    }
  });

  openKeysButton.addEventListener("click", async () => {
    openKeysButton.disabled = true;
    message.textContent = "키 파일을 엽니다…";
    try {
      const path = await openKeysEnvFile();
      message.textContent = `키 파일을 열었습니다: ${path} — 값을 저장한 뒤 상태 새로고침을 누르세요.`;
      await refreshFreeAutoReadiness();
      await refreshLoginStatus();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      openKeysButton.disabled = false;
    }
  });

  enableFreeAutoButton.addEventListener("click", async () => {
    enableFreeAutoButton.disabled = true;
    message.textContent = "무료 자동 모드를 켭니다…";
    try {
      const current = await getAppPreferences();
      const saved = await setAppPreferences({
        ...current,
        cradleEnabled: true,
        autoWebSearch: true,
        geminiApiEnabled: true,
        allowPaidOpenAiApi: current.allowPaidOpenAiApi,
      });
      cradleCheckbox.checked = saved.cradleEnabled;
      webSearchCheckbox.checked = saved.autoWebSearch;
      geminiApiCheckbox.checked = saved.geminiApiEnabled;
      openAiApiCheckbox.checked = saved.allowPaidOpenAiApi;
      await refreshFreeAutoReadiness();
      await refreshAutomaticProviders();
      window.dispatchEvent(
        new CustomEvent("ai-character:preferences-updated", { detail: saved })
      );
      const readiness = await getFreeAutoReadiness();
      message.textContent = readiness.handsFreeReady
        ? "무료 자동 모드가 켜졌습니다. 채팅만 입력하면 됩니다."
        : `설정은 켜졌습니다. ${readiness.nextSteps[0] ?? "GEMINI_API_KEY를 확인하세요."}`;
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      enableFreeAutoButton.disabled = false;
    }
  });

  installRuntimesButton.addEventListener("click", async () => {
    installRuntimesButton.disabled = true;
    message.textContent =
      "Git / Node / Claude / Cursor / Codex 설치를 진행합니다… (관리자 권한·시간이 필요할 수 있습니다)";
    try {
      const steps = await installAllRequiredRuntimes();
      const failed = steps.filter((step) => !step.ok);
      const okCount = steps.filter((step) => step.ok).length;
      message.textContent =
        failed.length === 0
          ? `설치 완료 (${okCount}개). Agent는 각 앱에서 한 번 로그인하세요.`
          : `일부 완료 (${okCount}/${steps.length}). ${failed
              .map((step) => step.message)
              .join(" / ")}`;
      await refreshFreeAutoReadiness();
      await refreshAgents();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      installRuntimesButton.disabled = false;
    }
  });

  // 첫 실행(Windows): 빠진 필수 프로그램을 자동 설치한다.
  void getRuntimeSetupStatus()
    .then(async (status) => {
      if (status.allReady || status.platform !== "windows") {
        return;
      }
      const missing = status.components
        .filter((item) => !item.ready)
        .map((item) => item.label)
        .join(", ");
      const key = "ai-character-runtime-auto-install";
      if (localStorage.getItem(key) === "1") {
        message.textContent = `아직 없는 프로그램: ${missing}. 설정 → ‘필수 프로그램 설치’로 다시 설치하세요.`;
        return;
      }
      localStorage.setItem(key, "1");
      installRuntimesButton.disabled = true;
      message.textContent = `없는 프로그램을 자동 설치합니다: ${missing}`;
      try {
        const steps = await installAllRequiredRuntimes();
        const failed = steps.filter((step) => !step.ok);
        const okCount = steps.filter((step) => step.ok).length;
        message.textContent =
          failed.length === 0
            ? `설치 완료 (${okCount}개). Agent는 각 앱에서 한 번 로그인하세요.`
            : `일부 완료 (${okCount}/${steps.length}). ${failed
                .map((step) => step.message)
                .join(" / ")}`;
        await refreshFreeAutoReadiness();
        await refreshAgents();
      } catch (error) {
        message.textContent = errorText(error);
      } finally {
        installRuntimesButton.disabled = false;
      }
    })
    .catch(() => {
      // ignore
    });

  prepareEnvironmentButton.addEventListener("click", async () => {
    prepareEnvironmentButton.disabled = true;
    message.textContent = "CRADLE 환경을 확인하고 준비합니다…";
    try {
      const status = await prepareCradleEnvironment();
      message.textContent = status.message;
      await refreshEnvironment();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      prepareEnvironmentButton.disabled = false;
    }
  });

  installGitButton.addEventListener("click", async () => {
    installGitButton.disabled = true;
    message.textContent = "Git 설치 도우미를 엽니다. 시스템 안내에 따라 설치해주세요.";
    try {
      await launchGitInstaller();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      installGitButton.disabled = false;
    }
  });

  refreshRunHistoryButton.addEventListener("click", () => {
    void refreshRunHistory();
  });

  refreshCheckpointButton.addEventListener("click", () => {
    void refreshCheckpoints();
  });

  projectButton.addEventListener("click", async () => {
    projectButton.disabled = true;
    message.textContent = "프로젝트 폴더를 선택하세요.";
    try {
      const selected = await chooseProjectDirectory();
      projectPath.textContent = selected;
      message.textContent = "프로젝트 폴더를 변경했습니다. 새 Agent 작업부터 새 경로를 사용합니다.";
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      projectButton.disabled = false;
    }
  });

  const chatStore = createBrowserHistoryStore();

  exportChatsButton.addEventListener("click", () => {
    void exportAllChatsJson(chatStore)
      .then((path) => {
        message.textContent = `채팅 백업 저장: ${path}`;
      })
      .catch((error) => {
        message.textContent = errorText(error);
      });
  });

  importMergeButton.addEventListener("click", () => {
    void importChatsFromJson(chatStore, "merge")
      .then((result) => {
        message.textContent = `병합 완료: ${result.imported}개 대화`;
      })
      .catch((error) => {
        message.textContent = errorText(error);
      });
  });

  importReplaceButton.addEventListener("click", () => {
    if (
      !window.confirm(
        "기존 대화를 모두 지우고 백업으로 교체할까요?"
      )
    ) {
      return;
    }
    void importChatsFromJson(chatStore, "replace")
      .then((result) => {
        message.textContent = `교체 완료: ${result.imported}개 대화 (앱을 다시 열면 목록이 갱신됩니다)`;
      })
      .catch((error) => {
        message.textContent = errorText(error);
      });
  });

  const renderUserModels = async () => {
    characterList.innerHTML = "";
    try {
      characterPath.textContent = `저장: ${await getUserLive2DDir()}`;
      const models = await listUserLive2DModels();
      if (models.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ai-settings-help";
        empty.textContent = "추가된 사용자 모델이 없습니다.";
        characterList.append(empty);
        return;
      }
      for (const model of models) {
        const row = document.createElement("div");
        row.className = "ai-user-live2d-row";
        const label = document.createElement("span");
        label.className = "ai-user-live2d-name";
        label.textContent = model.name;
        label.title = model.folder;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "ai-user-live2d-remove";
        remove.textContent = "×";
        remove.title = "삭제";
        remove.setAttribute("aria-label", `${model.name} 삭제`);
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!window.confirm(`"${model.name}" 모델을 삭제할까요?`)) {
            return;
          }
          void removeUserLive2DModel(model.folder)
            .then(() => {
              if (
                localStorage.getItem("selected-live2d-model") === model.model
              ) {
                localStorage.removeItem("selected-live2d-model");
                localStorage.removeItem("selected-live2d-name");
              }
              message.textContent = `삭제됨: ${model.name}`;
              return renderUserModels();
            })
            .catch((error) => {
              message.textContent = errorText(error);
            });
        });
        row.append(label, remove);
        characterList.append(row);
      }
    } catch (error) {
      characterPath.textContent = errorText(error);
    }
  };

  const handleImportedModel = (imported: { name: string }) => {
    message.textContent = `모델 추가됨: ${imported.name} (우클릭 메뉴에서 선택)`;
    void renderUserModels();
  };

  importZipButton.addEventListener("click", () => {
    void importUserLive2DZip()
      .then(handleImportedModel)
      .catch((error) => {
        message.textContent = errorText(error);
      });
  });

  importModelButton.addEventListener("click", () => {
    void importUserLive2DModel()
      .then(handleImportedModel)
      .catch((error) => {
        message.textContent = errorText(error);
      });
  });

  dedupeModelsButton.addEventListener("click", () => {
    if (
      !window.confirm(
        "내용이 같은 내 모델을 찾아 하나만 남기고 나머지를 삭제할까요?"
      )
    ) {
      return;
    }
    void dedupeUserLive2DModels()
      .then((result) => {
        message.textContent =
          result.removed.length === 0
            ? "중복된 모델이 없습니다."
            : `중복 ${result.removed.length}개 삭제 · 유지 ${result.kept}개`;
        return renderUserModels();
      })
      .catch((error) => {
        message.textContent = errorText(error);
      });
  });

  openModelDirButton.addEventListener("click", () => {
    void openUserLive2DDir().catch((error) => {
      message.textContent = errorText(error);
    });
  });

  openNizimaButton.addEventListener("click", () => {
    void openNizima().catch((error) => {
      message.textContent = errorText(error);
    });
  });

  openBoothButton.addEventListener("click", () => {
    void openBoothLive2D().catch((error) => {
      message.textContent = errorText(error);
    });
  });

  window.addEventListener(USER_LIVE2D_CHANGED_EVENT, () => {
    if (!overlay.hidden && !characterPane.hidden) {
      void renderUserModels();
    }
  });

  launcher.addEventListener("click", (event) => {
    event.stopPropagation();
    openSettings();
  });

  window.addEventListener("ai-character:open-settings", ((event: Event) => {
    const tab = (event as CustomEvent<{ tab?: keyof typeof panes }>)
      .detail?.tab;
    openSettings();
    if (tab) {
      setActiveTab(tab);
    }
  }) as EventListener);

  closeButton.addEventListener("click", () => {
    closeSettings();
  });

  const chatOpenObserver = new MutationObserver(() => {
    if (!chatPanel.classList.contains("open") && !overlay.hidden) {
      closeSettings();
    }
    if (!overlay.hidden) {
      positionSettingsPanel();
    }
  });
  chatOpenObserver.observe(chatPanel, {
    attributes: true,
    attributeFilter: ["class"],
  });

  window.addEventListener("resize", () => {
    if (!overlay.hidden) {
      positionSettingsPanel();
    }
  });
}
