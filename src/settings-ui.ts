import { getAutomaticProviderStatuses } from "./automatic-provider";
import { createApiKeysSection } from "./api-keys-ui";
import { createClaudeIntegrationSection, updateClaudePlugins } from "./claude-integration-ui";
import { createPolicySection } from "./policy-ui";
import { createUpdateSection } from "./update-ui";
import { openSetupWeb } from "./setup-web-client";
import { createScheduledJobsSection } from "./scheduled-jobs-ui";
import { createAlertsSection } from "./alerts-ui";
import { createAppPreferencesSections } from "./app-preferences-ui";
import { createCharacterProfilesSection, createDataToolsSection } from "./data-tools-ui";
import {
  chooseAgentExecutable,
  chooseProjectDirectory,
  detectAgentRuntime, // detectAgent paths are shown via detectAgentRuntime
  getAppPreferences,
  getAgentRuns,
  getCradleEnvironmentStatus,
  getFreeAutoReadiness,
  openKeysEnvFile,
  getProjectCheckpoints,
  getProjectDirectory,
  installAllRequiredRuntimes,
  installAgentCli,
  launchAgentLogin,
  launchGithubLogin,
  getClaudePlugins,
  addClaudePluginMarketplace,
  installClaudePlugin,
  setClaudePluginEnabled,
  uninstallClaudePlugin,
  openClaudePluginCatalog,
  type ClaudePlugin,
  launchGitInstaller,
  prepareCradleEnvironment,
  restoreProjectCheckpoint,
  resetRecommendedSettings,
  setAppPreferences,
  getUsageSnapshot,
  getAgentLogins,
  AGENT_LABELS,
  getLastAgentLogins,
  type AgentLogin,
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
import { confirmOnSecondClick, withBusy } from "./settings-controls";
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

  const launcher = makeButton("", "ai-settings-button");
  launcher.id = "ai-settings-button";
  launcher.title = "설정";
  launcher.dataset.icon = "⚙";
  const launcherLabel = document.createElement("span");
  launcherLabel.className = "toolbar-label";
  launcherLabel.textContent = "설정";
  launcher.append(launcherLabel);
  launcher.setAttribute("aria-label", "설정 열기");

  const overlay = document.createElement("section");
  overlay.id = "ai-settings-panel";
  overlay.hidden = true;
  overlay.setAttribute("aria-label", "AI-Character 설정");

  const header = document.createElement("div");
  header.className = "ai-settings-header";

  const title = document.createElement("strong");
  title.textContent = "설정";

  const closeButton = makeButton("×", "ai-settings-close");
  closeButton.setAttribute("aria-label", "닫기");
  closeButton.title = "닫기";
  header.append(title, closeButton);

  const message = document.createElement("div");
  message.className = "ai-settings-message";
  message.setAttribute("aria-live", "polite");

  const projectSection = document.createElement("section");
  projectSection.className = "ai-settings-section";
  const projectTitle = document.createElement("h3");
  projectTitle.textContent = "기본 작업 폴더";
  const projectPath = document.createElement("div");
  projectPath.className = "ai-settings-path";
  projectPath.textContent = "프로젝트 폴더 확인 중…";
  const projectButton = makeButton("변경", "ai-settings-action");
  projectButton.title = "프로젝트 폴더 변경";
  const projectRow = document.createElement("div");
  projectRow.className = "ai-settings-row";
  projectRow.append(projectPath, projectButton);
  const projectHelp = document.createElement("div");
  projectHelp.className = "ai-settings-help";
  projectHelp.textContent = "새 대화가 처음 쓰는 폴더입니다. 대화마다 대화창 위 📁 '바꾸기'로 다른 폴더를 쓸 수 있습니다.";
  projectSection.append(projectTitle, projectRow, projectHelp);

  const environmentSection = document.createElement("section");
  environmentSection.className = "ai-settings-section";
  const environmentTitle = document.createElement("h3");
  environmentTitle.textContent = "AI 작업 환경 준비";
  const environmentStatus = document.createElement("div");
  environmentStatus.className = "ai-settings-help";
  environmentStatus.textContent = "Git과 작업 환경을 확인하는 중…";
  const environmentActions = document.createElement("div");
  environmentActions.className = "ai-settings-easy-actions";
  const refreshEnvironmentButton = makeButton("환경 다시 확인", "ai-settings-action");
  const prepareEnvironmentButton = makeButton("환경 준비", "ai-settings-action");
  const installGitButton = makeButton("Git 설치", "ai-settings-action");
  installGitButton.hidden = true;
  environmentActions.append(refreshEnvironmentButton, prepareEnvironmentButton, installGitButton);
  environmentSection.append(environmentTitle, environmentStatus, environmentActions);

  const easySection = document.createElement("section");
  easySection.className = "ai-settings-section";
  const easyStatus = document.createElement("div");
  easyStatus.className = "ai-settings-easy-status";
  easyStatus.textContent = "자동 준비 상태 확인 중…";
  const easyPath = document.createElement("div");
  easyPath.className = "ai-settings-help";
  easyPath.textContent = "키 파일: 확인 중…";
  easyPath.hidden = true;
  const easyChecklist = document.createElement("ul");
  easyChecklist.className = "ai-settings-easy-list";
  const easyNext = document.createElement("div");
  easyNext.className = "ai-settings-help";
  const easyActions = document.createElement("div");
  easyActions.className = "ai-settings-ghost-row";
  const enableFreeAutoButton = makeButton(
    "무료 자동 모드 켜기",
    "ai-settings-action ai-settings-primary"
  );
  const installRuntimesButton = makeButton("필수 프로그램 설치", "ai-settings-ghost");
  const openKeysButton = makeButton("키 파일", "ai-settings-ghost");
  const refreshReadyButton = makeButton("다시 확인", "ai-settings-ghost");
  easyActions.append(openKeysButton, installRuntimesButton, refreshReadyButton);
  const setupWebButton = makeButton("웹에서 설정 보기", "ai-settings-action ai-settings-primary");
  setupWebButton.title = "브라우저에서 설정 전체를 엽니다. 키, 폴더, 로그인, 알림을 한 화면에서 봅니다.";
  setupWebButton.addEventListener("click", () => {
    void withBusy([setupWebButton], async () => {
      try {
        await openSetupWeb();
        setMessage("브라우저에서 설정 페이지를 열었습니다.");
      } catch (error) {
        setMessage(`설정 페이지 열기 실패: ${errorText(error)}`);
      }
    });
  });
  const easyMore = document.createElement("details");
  easyMore.className = "ai-settings-fold";
  const easyMoreSummary = document.createElement("summary");
  easyMoreSummary.textContent = "잘 안 되면";
  easyMore.append(easyMoreSummary, easyChecklist, easyActions);
  const resetSettingsButton = makeButton("설정 초기화", "ai-settings-ghost");
  resetSettingsButton.title = "동작 스위치와 웹 설정의 단계 체크를 모두 풉니다. 키와 작업 폴더는 지우지 않습니다.";
  easyActions.append(resetSettingsButton);
  const easyTitle = document.createElement("h3");
  easyTitle.textContent = "한 번에 쓰기 (추천)";
  const easyLead = document.createElement("div");
  easyLead.className = "ai-settings-help";
  easyLead.textContent = "처음이면 '웹에서 설정 보기'를 눌러 안내를 따라 하세요. 키 넣기·폴더 고르기·로그인을 한 화면에서 합니다.";
  easySection.append(
    easyTitle,
    easyLead,
    setupWebButton,
    easyStatus,
    easyNext,
    enableFreeAutoButton,
    easyMore
  );

  const orderSection = document.createElement("section");
  orderSection.className = "ai-settings-section";
  const orderTitle = document.createElement("h3");
  orderTitle.textContent = "질문하면 누가 답하나요?";
  const orderList = document.createElement("ol");
  orderList.className = "ai-settings-order";
  const orderItems: Array<[string, string]> = [
    ["대화", "'기본 프로그램'으로 고른 AI(처음엔 Claude)가 답합니다."],
    ["정보 찾기", "무료 Gemini가 찾습니다."],
    ["파일 고치기", "Claude가 계획하고 고칩니다. Cursor도 고칠 수 있습니다."],
  ];
  orderItems.forEach(([label, body], index) => {
    const item = document.createElement("li");
    const num = document.createElement("span");
    num.className = "ai-settings-order-num";
    num.textContent = String(index + 1);
    const text = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = label;
    text.append(strong, document.createTextNode(` ${body}`));
    item.append(num, text);
    orderList.append(item);
  });
  const orderNote = document.createElement("div");
  orderNote.className = "ai-settings-help";
  orderNote.textContent = "유료 API는 꺼져 있습니다. 사용량을 다 쓰면 채팅에 알려 줍니다.";
  orderSection.append(orderTitle, orderList, orderNote);

  const pluginSection = document.createElement("section");
  pluginSection.className = "ai-settings-section ai-plugin-section";
  const pluginTitle = document.createElement("h3");
  pluginTitle.textContent = "Claude 플러그인";
  const pluginLead = document.createElement("div");
  pluginLead.className = "ai-settings-help";
  pluginLead.textContent =
    "파일을 고칠 때 Claude에 같이 켜집니다. 대화와 정보 조사에는 붙지 않습니다. 웹에서 본 이름을 적어 설치하세요.";
  const pluginStatus = document.createElement("div");
  pluginStatus.className = "ai-settings-status";
  pluginStatus.textContent = "플러그인 확인 중…";
  const pluginBrowseActions = document.createElement("div");
  pluginBrowseActions.className = "ai-settings-ghost-row";
  const pluginBrowseButton = makeButton("플러그인 찾아보기", "ai-settings-ghost");
  const pluginRepoButton = makeButton("GitHub", "ai-settings-ghost");
  const pluginMarketButton = makeButton("공식 마켓", "ai-settings-ghost");
  const pluginRefreshButton = makeButton("새로고침", "ai-settings-ghost");
  pluginBrowseActions.append(
    pluginBrowseButton,
    pluginRepoButton,
    pluginMarketButton,
    pluginRefreshButton
  );
  const pluginInstallRow = document.createElement("div");
  pluginInstallRow.className = "ai-plugin-install-row";
  const pluginInput = document.createElement("input");
  pluginInput.className = "ai-settings-text";
  pluginInput.type = "text";
  pluginInput.placeholder = "웹에서 본 이름  (예: frontend-design)";
  pluginInput.setAttribute("aria-label", "설치할 Claude 플러그인 이름");
  const pluginInstallButton = makeButton("이 이름으로 설치", "ai-settings-action ai-settings-primary");
  pluginInstallRow.append(pluginInput, pluginInstallButton);
  const pluginInstalled = document.createElement("div");
  pluginInstalled.className = "ai-plugin-list";
  const pluginRecommend = document.createElement("details");
  pluginRecommend.className = "ai-settings-fold";
  const pluginAvailableTitle = document.createElement("summary");
  pluginAvailableTitle.textContent = "추천";
  const pluginAvailable = document.createElement("div");
  pluginAvailable.className = "ai-plugin-list";
  pluginRecommend.append(pluginAvailableTitle, pluginAvailable);
  pluginSection.append(
    pluginTitle,
    pluginLead,
    pluginStatus,
    pluginInstallRow,
    pluginInstalled,
    pluginRecommend,
    pluginBrowseActions
  );

  const accountsSection = document.createElement("section");
  accountsSection.className = "ai-settings-section ai-settings-accounts";
  const accountsTitle = document.createElement("h3");
  accountsTitle.textContent = "계정 · 로그인";
  const accountsLead = document.createElement("div");
  accountsLead.className = "ai-settings-help";
  accountsLead.textContent =
    "사용량에 연결됨으로 나오려면 여기 로그인 또는 키가 필요합니다.";
  accountsLead.hidden = true;
  const githubTitle = document.createElement("span");
  githubTitle.textContent = "GitHub";
  const githubHelp = document.createElement("div");
  githubHelp.className = "ai-settings-help";
  githubHelp.textContent = "기본 브라우저에서 GitHub에 로그인합니다(구글 계정으로 가입했다면 그 계정으로). 결과를 GitHub에 자동 저장하려면 키 파일의 GitHub 토큰(GITHUB_TOKEN)도 필요합니다.";
  githubHelp.hidden = true;
  const githubLoginButton = makeButton("로그인", "ai-settings-action");
  githubLoginButton.title = "기본 브라우저로 GitHub 로그인";
  const githubRow = document.createElement("div");
  githubRow.className = "ai-settings-row";
  githubRow.append(githubTitle, githubLoginButton);
  const loginStatusList = document.createElement("div");
  loginStatusList.className = "ai-web-accounts-list ai-login-status-list";
  const webWindowsTitle = document.createElement("summary");
  webWindowsTitle.textContent = "웹 창";
  const webWindowsHelp = document.createElement("div");
  webWindowsHelp.className = "ai-settings-help";
  webWindowsHelp.textContent = "브라우저에서 보고 복사하는 창입니다. CLI 로그인과는 별개입니다.";
  webWindowsHelp.hidden = true;
  const accountsList = document.createElement("div");
  accountsList.className = "ai-web-accounts-list";
  const accountsActions = document.createElement("div");
  accountsActions.className = "ai-settings-ghost-row";
  const openAllAccountsButton = makeButton("모든 웹 창 열기", "ai-settings-ghost");
  const refreshAccountsButton = makeButton("새로고침", "ai-settings-ghost");
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
  closeWhenDoneText.textContent = "협업 작업이 끝나면 남은 계정 창 닫기";
  const closeWhenDoneHelp = document.createElement("small");
  closeWhenDoneHelp.className = "ai-settings-help";
  closeWhenDoneHelp.textContent = "설정에서 미리 연 로그인 창까지 닫지 않고, 이번 협업 작업에서 연 창만 정리합니다.";
  const closeWhenDoneCopy = document.createElement("span");
  closeWhenDoneCopy.className = "ai-settings-checkbox-copy";
  closeWhenDoneCopy.append(closeWhenDoneText, closeWhenDoneHelp);
  closeWhenDoneLabel.append(closeWhenDoneCheckbox, closeWhenDoneCopy);
  const webFold = document.createElement("details");
  webFold.className = "ai-settings-fold";
  webFold.append(
    webWindowsTitle,
    accountsList,
    closeAfterHandoffLabel,
    closeWhenDoneLabel,
    accountsActions
  );
  accountsSection.append(accountsTitle, githubRow, loginStatusList, webFold);

  const runtimeSection = document.createElement("section");
  runtimeSection.className = "ai-settings-section";
  const runtimeTitle = document.createElement("h3");
  runtimeTitle.textContent = "기본 실행";

  const cradleLabel = document.createElement("label");
  cradleLabel.className = "ai-settings-checkbox";
  const cradleCheckbox = document.createElement("input");
  cradleCheckbox.type = "checkbox";
  const cradleText = document.createElement("span");
  cradleText.textContent = "무료 자동 모드 (여러 AI 협업)";
  const cradleHelp = document.createElement("small");
  cradleHelp.className = "ai-settings-help";
  cradleHelp.textContent =
    "질문에 맞는 AI를 알아서 고릅니다. 질문은 바로 답하고, 파일 작업은 설치된 Claude·Codex·Cursor 등에 나눕니다. 켜 두는 것을 추천합니다.";
  const cradleCopy = document.createElement("span");
  cradleCopy.className = "ai-settings-checkbox-copy";
  cradleCopy.append(cradleText, cradleHelp);
  cradleLabel.append(cradleCheckbox, cradleCopy);

  const webSearchLabel = document.createElement("label");
  webSearchLabel.className = "ai-settings-checkbox";
  const webSearchCheckbox = document.createElement("input");
  webSearchCheckbox.type = "checkbox";
  const webSearchText = document.createElement("span");
  webSearchText.textContent = "필요하면 웹 검색";
  const webSearchHelp = document.createElement("small");
  webSearchHelp.className = "ai-settings-help";
  webSearchHelp.textContent = "최신 정보가 필요한 질문일 때만 인터넷을 찾아봅니다. Jina 키가 필요합니다.";
  const webSearchCopy = document.createElement("span");
  webSearchCopy.className = "ai-settings-checkbox-copy";
  webSearchCopy.append(webSearchText, webSearchHelp);
  webSearchLabel.append(webSearchCheckbox, webSearchCopy);

  const geminiApiLabel = document.createElement("label");
  geminiApiLabel.className = "ai-settings-checkbox";
  const geminiApiCheckbox = document.createElement("input");
  geminiApiCheckbox.type = "checkbox";
  const geminiApiText = document.createElement("span");
  geminiApiText.textContent = "무료 Gemini 키 사용";
  const geminiApiHelp = document.createElement("small");
  geminiApiHelp.className = "ai-settings-help";
  geminiApiHelp.textContent = "조사·정리처럼 정확한 정보가 필요한 일을 무료 Gemini가 먼저 처리합니다.";
  const geminiApiCopy = document.createElement("span");
  geminiApiCopy.className = "ai-settings-checkbox-copy";
  geminiApiCopy.append(geminiApiText, geminiApiHelp);
  geminiApiLabel.append(geminiApiCheckbox, geminiApiCopy);

  const freeFirstLabel = document.createElement("label");
  freeFirstLabel.className = "ai-settings-checkbox";
  const freeFirstCheckbox = document.createElement("input");
  freeFirstCheckbox.type = "checkbox";
  const freeFirstText = document.createElement("span");
  freeFirstText.textContent = "무료 AI 먼저 쓰기";
  const freeFirstHelp = document.createElement("small");
  freeFirstHelp.className = "ai-settings-help";
  freeFirstHelp.textContent =
    "켜면 무료 Gemini가 먼저 답하고, 안 될 때 ChatGPT·Claude가 이어받습니다. 끄면(기본) 구독 중인 ChatGPT·Claude가 먼저 답하고 무료 AI는 마지막 예비로만 씁니다.";
  const freeFirstCopy = document.createElement("span");
  freeFirstCopy.className = "ai-settings-checkbox-copy";
  freeFirstCopy.append(freeFirstText, freeFirstHelp);
  freeFirstLabel.append(freeFirstCheckbox, freeFirstCopy);

  const openAiApiLabel = document.createElement("label");
  openAiApiLabel.className = "ai-settings-checkbox";
  const openAiApiCheckbox = document.createElement("input");
  openAiApiCheckbox.type = "checkbox";
  const openAiApiText = document.createElement("span");
  openAiApiText.textContent = "유료 OpenAI API 허용 (요금 발생)";
  const openAiApiHelp = document.createElement("small");
  openAiApiHelp.className = "ai-settings-help";
  openAiApiHelp.textContent = "기본은 꺼짐. 켜도 호출마다 승인을 받습니다. 하루 한도가 0달러면 아예 쓰지 않고, '한도에 닿으면 유료 호출 막기'를 켜 두면 한도에서 멈춥니다.";
  const openAiApiCopy = document.createElement("span");
  openAiApiCopy.className = "ai-settings-checkbox-copy";
  openAiApiCopy.append(openAiApiText, openAiApiHelp);
  openAiApiLabel.append(openAiApiCheckbox, openAiApiCopy);

  const providerStatusBox = document.createElement("div");
  providerStatusBox.className = "ai-settings-help";
  providerStatusBox.textContent = "AI 연결 상태 확인 중…";

  const defaultAgentLabel = document.createElement("label");
  defaultAgentLabel.className = "ai-settings-field";
  const defaultAgentText = document.createElement("span");
  defaultAgentText.textContent = "기본 프로그램 (자동 모드 끔일 때)";
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
  timeoutText.textContent = "최대 대기 시간 (초)";
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
  sensitiveText.textContent = "비밀 파일 경고";
  const sensitiveHelp = document.createElement("div");
  sensitiveHelp.className = "ai-settings-help";
  sensitiveHelp.textContent =
    "대화별 복사본에는 키 파일이 들어가지 않으며, 이 경고 때문에 작업이 멈추지는 않습니다.";
  const sensitiveCopy = document.createElement("span");
  sensitiveCopy.className = "ai-settings-checkbox-copy";
  sensitiveCopy.append(sensitiveText, sensitiveHelp);
  sensitiveLabel.append(sensitiveCheckbox, sensitiveCopy);

  const saveRuntimeButton = makeButton("저장", "ai-settings-action");
  const simpleSection = document.createElement("section");
  simpleSection.className = "ai-settings-section";
  const simpleTitle = document.createElement("h3");
  simpleTitle.textContent = "답변 방식";
  const simpleLead = document.createElement("div");
  simpleLead.className = "ai-settings-help";
  simpleLead.textContent = "스위치를 바꾸면 바로 저장됩니다. 잘 모르겠으면 그대로 두세요.";
  simpleSection.append(
    simpleTitle,
    simpleLead,
    cradleLabel,
    webSearchLabel,
    geminiApiLabel,
    freeFirstLabel,
    openAiApiLabel,
    saveRuntimeButton
  );

  runtimeSection.append(
    runtimeTitle,
    providerStatusBox,
    defaultAgentLabel,
    timeoutLabel,
    sensitiveLabel
  );

  const agentsSection = document.createElement("section");
  agentsSection.className = "ai-settings-section";
  const agentsTitle = document.createElement("h3");
  agentsTitle.textContent = "AI 프로그램";
  const agentsLead = document.createElement("div");
  agentsLead.className = "ai-settings-help";
  agentsLead.textContent =
    "CLI와 데스크톱 앱을 같이 씁니다. 둘 다 없으면 설치를 누르세요.";
  agentsLead.hidden = true;
  const agentsGrid = document.createElement("div");
  agentsGrid.className = "ai-agent-settings-list";
  agentsSection.append(agentsTitle, agentsLead, agentsGrid);

  const runHistorySection = document.createElement("section");
  runHistorySection.className = "ai-settings-section";
  const runHistoryHeader = document.createElement("div");
  runHistoryHeader.className = "ai-agent-run-history-header";
  const runHistoryTitle = document.createElement("h3");
  runHistoryTitle.textContent = "최근 AI 프로그램 실행";
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
  checkpointTitle.textContent = "되돌리기 기록";
  const refreshCheckpointButton = makeButton("새로고침", "ai-settings-action");
  checkpointHeader.append(checkpointTitle, refreshCheckpointButton);
  const checkpointHelp = document.createElement("p");
  checkpointHelp.className = "ai-checkpoint-help";
  checkpointHelp.textContent = "AI가 바꾼 파일을 적용하기 직전 상태입니다. 여기서 되돌려도 되돌리기 직전 상태가 따로 저장되니 안심하고 쓰세요.";
  const checkpointList = document.createElement("div");
  checkpointList.className = "ai-checkpoint-history";
  const checkpointEmpty = document.createElement("div");
  checkpointEmpty.className = "ai-checkpoint-history-empty";
  checkpointEmpty.textContent = "아직 되돌릴 기록이 없습니다.";
  checkpointList.append(checkpointEmpty);
  const safetyList = document.createElement("div");
  safetyList.className = "ai-settings-safety-list";
  for (const text of [
    "원본 변경은 적용 버튼을 눌러야 반영됩니다.",
    "충돌이 있으면 원본 적용을 차단합니다.",
    "AI 프로그램은 대화별 작업 복사본에서 실행됩니다.",
  ]) {
    const item = document.createElement("div");
    item.className = "ai-settings-safety-item";
    item.textContent = `✓ ${text}`;
    safetyList.append(item);
  }
  checkpointSection.append(checkpointHeader, checkpointHelp, safetyList, checkpointList);

  const backupSection = document.createElement("section");
  backupSection.className = "ai-settings-section";
  const backupTitle = document.createElement("h3");
  backupTitle.textContent = "대화 백업";
  const backupLead = document.createElement("div");
  backupLead.className = "ai-settings-help";
  backupLead.textContent = "채팅을 JSON으로 내보내거나 가져옵니다.";
  backupLead.hidden = true;
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
    "Booth/nizima에서 받은 ZIP을 올리거나, 압축 푼 폴더를 추가하세요. 이 PC에만 저장됩니다.";
  characterLead.hidden = true;
  const characterPath = document.createElement("div");
  characterPath.className = "ai-settings-path";
  characterPath.textContent = "저장 위치 확인 중…";
  const boothPicksFold = document.createElement("details");
  boothPicksFold.className = "ai-settings-fold";
  const boothPicksTitle = document.createElement("summary");
  boothPicksTitle.textContent = "추천 무료 원작";
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
  boothPicksFold.append(boothPicksTitle, boothPicks);
  const characterList = document.createElement("div");
  characterList.className = "ai-user-live2d-list";
  const characterActions = document.createElement("div");
  characterActions.className = "ai-settings-ghost-row";
  const importZipButton = makeButton("ZIP 올리기", "ai-settings-action");
  const importModelButton = makeButton("폴더 추가", "ai-settings-action");
  const characterMainActions = document.createElement("div");
  characterMainActions.className = "ai-settings-row-actions";
  characterMainActions.append(importZipButton, importModelButton);
  const dedupeModelsButton = makeButton("중복 정리", "ai-settings-ghost");
  const openModelDirButton = makeButton("폴더 열기", "ai-settings-ghost");
  const openNizimaButton = makeButton("nizima", "ai-settings-ghost");
  const openBoothButton = makeButton("Booth", "ai-settings-ghost");
  characterActions.append(
    openNizimaButton,
    openBoothButton,
    openModelDirButton,
    dedupeModelsButton
  );
  characterSection.append(
    characterTitle,
    characterMainActions,
    characterPath,
    characterList,
    boothPicksFold,
    characterActions
  );

  const tabs = document.createElement("div");
  tabs.className = "ai-settings-tabs";
  tabs.setAttribute("role", "tablist");

  const foldCard = (section: HTMLElement): HTMLDetailsElement => {
    const fold = document.createElement("details");
    fold.className = "ai-settings-fold-card";
    const summary = document.createElement("summary");
    const heading = section.querySelector("h3");
    summary.textContent = heading?.textContent ?? "더보기";
    heading?.remove();
    fold.append(summary, section);
    return fold;
  };

  const setMessage = (text: string): void => {
    message.textContent = text;
  };

  const apiKeys = createApiKeysSection(makeButton, setMessage, () => {
    void refreshFreeAutoReadiness();
    void refreshLoginStatus();
  });
  const basicPane = document.createElement("div");
  basicPane.className = "ai-settings-pane";
  basicPane.dataset.pane = "basic";
  const moreKeys = document.createElement("details");
  moreKeys.className = "ai-settings-fold-card";
  const moreKeysSummary = document.createElement("summary");
  moreKeysSummary.textContent = "다른 AI 키 (안 넣어도 됩니다)";
  moreKeys.append(moreKeysSummary, apiKeys.section);
  const appPreferences = createAppPreferencesSections(makeButton, setMessage);
  basicPane.append(
    easySection,
    projectSection,
    simpleSection,
    appPreferences.screen,
    foldCard(appPreferences.persona),
    foldCard(appPreferences.system),
    orderSection,
    moreKeys
  );

  const accountsPane = document.createElement("div");
  accountsPane.className = "ai-settings-pane";
  accountsPane.dataset.pane = "accounts";
  accountsPane.hidden = true;
  accountsPane.append(accountsSection);

  const updatePluginsButton = makeButton("플러그인 업데이트", "ai-settings-ghost");
  updatePluginsButton.addEventListener("click", () => {
    void (async () => {
      updatePluginsButton.disabled = true;
      setMessage("Claude 플러그인을 업데이트하는 중…");
      try {
        setMessage(await updateClaudePlugins());
        await refreshClaudePlugins();
      } catch (error) {
        setMessage(`플러그인 업데이트 실패: ${errorText(error)}`);
      } finally {
        updatePluginsButton.disabled = false;
      }
    })();
  });
  pluginBrowseActions.append(updatePluginsButton);

  const claudeIntegration = createClaudeIntegrationSection(makeButton, setMessage);
  const claudePane = document.createElement("div");
  claudePane.className = "ai-settings-pane";
  claudePane.dataset.pane = "claude";
  claudePane.hidden = true;
  claudePane.append(claudeIntegration.section, pluginSection);

  const updateSection = createUpdateSection(makeButton, setMessage);
  const signingSection = document.createElement("section");
  signingSection.className = "ai-settings-section";
  const signingTitle = document.createElement("h3");
  signingTitle.textContent = "앱 자동 업데이트 서명";
  const signingHelp = document.createElement("div");
  signingHelp.className = "ai-settings-help";
  signingHelp.textContent = "서명 키를 GitHub에 등록하는 순서를 브라우저에서 단계별로 안내합니다.";
  const signingButton = makeButton("웹에서 서명 설정 열기", "ai-settings-action");
  signingButton.addEventListener("click", () => {
    void withBusy([signingButton], async () => {
      try {
        await openSetupWeb("updates");
        setMessage("브라우저에서 자동 업데이트 설정을 열었습니다.");
      } catch (error) {
        setMessage(`설정 페이지 열기 실패: ${errorText(error)}`);
      }
    });
  });
  signingSection.append(signingTitle, signingHelp, signingButton);
  const scheduledJobs = createScheduledJobsSection(makeButton, setMessage);
  const alertsSection = createAlertsSection(setMessage);
  const updatesPane = document.createElement("div");
  updatesPane.className = "ai-settings-pane";
  updatesPane.dataset.pane = "updates";
  updatesPane.hidden = true;
  updatesPane.append(updateSection.section, signingSection, scheduledJobs.section, alertsSection.section);

  const policySection = createPolicySection(makeButton, setMessage);

  const characterPane = document.createElement("div");
  characterPane.className = "ai-settings-pane";
  characterPane.dataset.pane = "character";
  characterPane.hidden = true;
  characterPane.append(characterSection, createCharacterProfilesSection(makeButton, setMessage));

  const advancedPane = document.createElement("div");
  advancedPane.className = "ai-settings-pane";
  advancedPane.dataset.pane = "advanced";
  advancedPane.hidden = true;
  advancedPane.append(
    appPreferences.diagnostics,
    createDataToolsSection(makeButton, setMessage),
    policySection.section,
    agentsSection,
    foldCard(runtimeSection),
    foldCard(environmentSection),
    foldCard(runHistorySection),
    foldCard(checkpointSection),
    foldCard(backupSection)
  );

  const tabDefs: Array<{
    id: "basic" | "accounts" | "claude" | "updates" | "character" | "advanced";
    label: string;
  }> = [
    { id: "basic", label: "기본" },
    { id: "accounts", label: "계정 · 로그인" },
    { id: "claude", label: "Claude" },
    { id: "updates", label: "자동화" },
    { id: "character", label: "캐릭터" },
    { id: "advanced", label: "고급" },
  ];
  const panes = {
    basic: basicPane,
    accounts: accountsPane,
    claude: claudePane,
    updates: updatesPane,
    character: characterPane,
    advanced: advancedPane,
  } as const;

  let currentTab: keyof typeof panes = "basic";
  const tabFreshAt = new Map<keyof typeof panes, number>();
  const TAB_TTL_MS = 30_000;
  let prefsLoaded = false;
  let prefsFreshAt = 0;

  const invalidateSettings = (tab?: keyof typeof panes): void => {
    if (tab) {
      tabFreshAt.delete(tab);
      return;
    }
    tabFreshAt.clear();
    prefsLoaded = false;
  };

  const setActiveTab = (
    id: keyof typeof panes,
    options?: { refresh?: boolean }
  ) => {
    currentTab = id;
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
    if (options?.refresh !== false && !overlay.hidden) {
      scheduleTabRefresh(id);
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
    claudePane,
    updatesPane,
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

  const openSettings = (tab?: keyof typeof panes): void => {
    chatPanel.classList.add("open");
    positionSettingsPanel();
    overlay.hidden = false;
    overlay.scrollTop = 0;
    if (tab) {
      setActiveTab(tab, { refresh: false });
    }
    window.dispatchEvent(
      new CustomEvent("ai-character:settings-opened")
    );
    scheduleTabRefresh(currentTab);
  };

  // Settings may have changed in the web setup page meanwhile; reload so a save here
  // does not write the old values back over them.
  window.addEventListener("focus", () => {
    invalidateSettings();
    if (!overlay.hidden) {
      scheduleTabRefresh(currentTab, true);
    }
  });

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
    argsHelp.textContent = "보통은 비워두세요. 해당 AI 프로그램에 별도 옵션이 필요할 때만 사용합니다.";
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

    const titleRow = document.createElement("div");
    titleRow.className = "ai-agent-settings-title";
    titleRow.append(name, status);
    info.append(titleRow, path);
    rowActions.append(install);
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
    return record.purpose === "restore_safety" ? "되돌리기 직전 상태" : "AI 변경 적용 직전 상태";
  }

  function renderCheckpoints(records: CheckpointRecord[]): void {
    checkpointList.replaceChildren();
    if (records.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ai-checkpoint-history-empty";
      empty.textContent = "아직 되돌릴 기록이 없습니다.";
      checkpointList.append(empty);
      return;
    }

    // Chat titles from saved history, so a checkpoint reads as 대화 "로그인 버튼 수정".
    let chatTitles = new Map<string, string>();
    try {
      chatTitles = createBrowserHistoryStore().conversationTitles();
    } catch {
      // Without history the rows just leave the title out.
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
      const conversationTitle = record.conversationId ? chatTitles.get(record.conversationId) ?? null : null;
      const conversation = conversationTitle ? ` · 대화 "${conversationTitle}"` : "";
      meta.textContent = `${created} · 파일 ${record.changedCount}개${conversation}`;
      // The raw ID only as a tooltip, for support.
      row.title = `기록 번호: ${record.id}`;
      info.append(title, meta);

      const restore = makeButton("복원", "ai-settings-action");
      restore.title = "프로젝트 파일을 이 상태로 되돌립니다. 되돌리기 직전 상태도 따로 저장됩니다. 한 번 더 누르면 실행합니다.";
      confirmOnSecondClick(restore, "한 번 더 누르면 복원", async () => {
        restore.disabled = true;
        message.textContent = "되돌리는 중…";
        try {
          const result = await restoreProjectCheckpoint(record.id);
          message.textContent = `파일 ${result.restoredCount}개를 되돌렸습니다. 되돌리기 직전 상태는 목록 맨 위에 저장했습니다.`;
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
      failure.textContent = `되돌리기 기록을 읽지 못했습니다: ${errorText(error)}`;
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
      freeFirstCheckbox.checked = preferences.freeAiFirst;
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
        status.hidden = false;
        if (status.dataset.state !== "ok") {
          status.textContent = "확인 중";
          status.dataset.state = "loading";
        }
        try {
          const runtime = await detectAgentRuntime(agent);
          const lines = [
            runtime.cli ? `CLI ${runtime.cli}` : "CLI 없음",
            runtime.app ? `앱 ${runtime.app}` : "앱 없음",
          ];
          path.replaceChildren();
          for (const text of lines) {
            const line = document.createElement("span");
            line.className = "ai-agent-runtime-line";
            line.textContent = text;
            path.append(line);
          }
          path.title = lines.join("\n");
          if (runtime.cli && runtime.app) {
            status.textContent = "CLI+앱";
            status.dataset.state = "ok";
            if (install) {
              install.hidden = true;
            }
          } else if (runtime.cli || runtime.app) {
            status.textContent = runtime.cli ? "CLI만" : "앱만";
            status.dataset.state = "ok";
            if (install) {
              install.hidden = false;
              install.textContent = "나머지 설치";
            }
          } else {
            throw new Error("not found");
          }
          status.hidden = false;
        } catch {
          path.textContent = "없음 — 설치하면 CLI와 exe를 같이 받습니다.";
          path.removeAttribute("title");
          status.hidden = true;
          status.textContent = "찾을 수 없음";
          status.dataset.state = "missing";
          if (install) {
            install.hidden = false;
            install.textContent = "찾을 수 없음 (설치)";
          }
        } finally {
          /* keep buttons usable while other agents finish */
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
        : "작업 기록(Git): 첫 코드 작업 때 자동 준비";
      environmentStatus.textContent = `${gitLabel} / ${workspaceLabel} — ${status.message}`;
      installGitButton.hidden = status.gitInstalled || !status.installSupported;
      prepareEnvironmentButton.disabled = !status.gitInstalled;
    } catch (error) {
      environmentStatus.textContent = `AI 작업 환경 상태를 읽지 못했습니다: ${errorText(error)}`;
      installGitButton.hidden = false;
    } finally {
      refreshEnvironmentButton.disabled = false;
      if (!installGitButton.hidden) {
        prepareEnvironmentButton.disabled = true;
      }
    }
  }

  let lastLoginSnapshot: Parameters<typeof renderLoginStatus>[0] = {};

  /** Redraws the login rows; returns the sign-in states, or null if they could not be read. */
  async function refreshLoginStatus(force = false): Promise<AgentLogin[] | null> {
    try {
      // Show the last answer at once; asking Cursor and Antigravity again can take seconds.
      const last = await getLastAgentLogins().catch(() => null);
      if (last) {
        renderLoginStatus(lastLoginSnapshot, last);
      } else if (!loginStatusList.childElementCount) {
        const checking = document.createElement("div");
        checking.className = "ai-settings-help";
        checking.textContent = "로그인 상태를 확인하는 중…";
        loginStatusList.append(checking);
      }
      // Sign-in state is read directly by the app; API key rows still come from the usage snapshot.
      const [logins, snapshotOrNull] = await Promise.all([
        getAgentLogins(force),
        getUsageSnapshot().catch(() => null),
      ]);
      const snapshot = (snapshotOrNull ?? {}) as {
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
      lastLoginSnapshot = snapshot;
      renderLoginStatus(snapshot, logins);
      return logins;
    } catch (error) {
      loginStatusList.replaceChildren();
      const failure = document.createElement("div");
      failure.className = "ai-settings-help";
      failure.textContent = `로그인 상태를 읽지 못했습니다: ${errorText(error)}`;
      loginStatusList.append(failure);
      return null;
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
  }, logins: AgentLogin[]): void {
    const rows: HTMLElement[] = [];

    for (const id of Object.keys(AGENT_LABELS) as AgentKind[]) {
      const login = logins.find((item) => item.id === id);
      const label = AGENT_LABELS[id];
      const plan = (snapshot.providers ?? []).find((item) => item.id === id)?.account?.plan;
      const detail = [login?.detail ?? "로그인 상태를 확인하지 못했습니다.", plan && `요금제 ${plan}`]
        .filter(Boolean)
        .join(" · ");
      rows.push(
        makeLoginRow({
          label,
          connected: login?.loggedIn === true,
          stateText: login?.loggedIn === true ? "로그인됨" : login?.loggedIn === false ? "로그인 필요" : "확인 불가",
          account: login?.loggedIn === true ? login.account ?? "계정 이름은 확인할 수 없습니다" : undefined,
          detail,
          actionLabel: login?.loggedIn ? "다시 로그인" : "로그인",
          onAction: () => startAgentLogin(id, label),
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
    stateText?: string;
    /** Which account is signed in, shown on its own line so a wrong account is easy to spot. */
    account?: string;
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
        ` ${options.label} · ${options.stateText ?? (options.connected ? "연결됨" : "미연결")}`
      )
    );
    const state = document.createElement("small");
    state.className = "ai-settings-help";
    state.textContent = options.detail;
    meta.append(title);
    if (options.account) {
      const account = document.createElement("span");
      account.className = "ai-login-account";
      account.textContent = `계정: ${options.account}`;
      meta.append(account);
    }
    meta.append(state);
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
      // The app re-checks on its own for a few minutes after a login starts, so no force here;
      // stop as soon as this program reports signed in.
      for (let i = 0; i < 12; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
        const logins = await refreshLoginStatus();
        if (logins?.find((item) => item.id === agent)?.loggedIn) break;
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
        const label =
          provider.provider === "gemini_api"
            ? "Gemini API"
            : provider.provider === "openrouter_api"
              ? "OpenRouter 무료"
              : provider.provider === "free_pool_api"
                ? "추가 무료 AI"
                : "OpenAI API (유료·승인 필요)";
        const state = provider.available ? `구성됨 · ${provider.model}` : (provider.reason ?? "사용 불가");
        return `${label}: ${state}`;
      }).join(" / ");
    } catch (error) {
      providerStatusBox.textContent = `AI 연결 상태를 읽지 못했습니다: ${errorText(error)}`;
    }
  }

  function renderFreeAutoReadiness(readiness: FreeAutoReadiness): void {
    easyStatus.textContent = readiness.message;
    easyStatus.dataset.state = readiness.handsFreeReady ? "ready" : "needs-setup";
    easyPath.textContent = readiness.keysEnvPath
      ? `키 파일: ${readiness.keysEnvPath}`
      : "키 파일: 아직 없음 (키 파일 열기로 생성)";
    const rows: Array<[string, boolean]> = [
      ["CRADLE", readiness.cradleEnabled],
      ["Gemini", readiness.geminiApiConfigured && readiness.geminiApiEnabled],
      ["OpenRouter", readiness.openrouterApiConfigured],
      ["검색", readiness.jinaApiConfigured],
      ["Claude", readiness.claudeCliReady],
    ];
    easyChecklist.replaceChildren(
      ...rows.map(([label, ok]) => {
        const item = document.createElement("li");
        item.dataset.state = ok ? "ok" : "missing";
        item.textContent = label;
        return item;
      })
    );
    easyChecklist.hidden = rows.every(([, ok]) => ok);
    easyNext.textContent = readiness.nextSteps[0] ?? "";
    easyNext.hidden = readiness.nextSteps.length === 0;
    enableFreeAutoButton.textContent =
      readiness.cradleEnabled && readiness.autoWebSearch && readiness.geminiApiEnabled
        ? "추천 설정 다시 적용"
        : "추천 설정 켜기";
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

  function renderPluginRow(
    plugin: ClaudePlugin,
    mode: "installed" | "available"
  ): HTMLElement {
    const row = document.createElement("article");
    row.className = "ai-plugin-row";
    const meta = document.createElement("div");
    meta.className = "ai-plugin-meta";
    const name = document.createElement("strong");
    name.textContent = plugin.name;
    const detail = document.createElement("span");
    const bits = [
      plugin.enabled ? "사용 중" : plugin.installed ? "꺼짐" : "미설치",
      plugin.marketplace && plugin.marketplace !== "local" ? plugin.marketplace : "",
      plugin.version,
      plugin.description,
    ].filter(Boolean);
    detail.textContent = bits.join(" · ");
    meta.append(name, detail);
    const actions = document.createElement("div");
    actions.className = "ai-plugin-row-actions";
    if (mode === "installed") {
      const toggle = makeButton(plugin.enabled ? "끄기" : "켜기", "ai-settings-action");
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        message.textContent = `${plugin.name} ${plugin.enabled ? "끄는" : "켜는"} 중…`;
        try {
          message.textContent = await setClaudePluginEnabled(plugin.id, !plugin.enabled);
          await refreshClaudePlugins();
        } catch (error) {
          message.textContent = errorText(error);
        } finally {
          toggle.disabled = false;
        }
      });
      const remove = makeButton("삭제", "ai-settings-action");
      remove.addEventListener("click", async () => {
        if (plugin.source === "local") {
          message.textContent = "로컬 폴더 플러그인은 폴더에서 직접 지우세요.";
          return;
        }
        remove.disabled = true;
        message.textContent = `${plugin.name} 삭제 중…`;
        try {
          message.textContent = await uninstallClaudePlugin(plugin.id);
          await refreshClaudePlugins();
        } catch (error) {
          message.textContent = errorText(error);
        } finally {
          remove.disabled = false;
        }
      });
      actions.append(toggle, remove);
    } else {
      const install = makeButton("설치", "ai-settings-action");
      install.addEventListener("click", async () => {
        install.disabled = true;
        message.textContent = `${plugin.name} 설치 중…`;
        try {
          message.textContent = await installClaudePlugin(plugin.id);
          await refreshClaudePlugins();
        } catch (error) {
          message.textContent = errorText(error);
        } finally {
          install.disabled = false;
        }
      });
      actions.append(install);
    }
    row.append(meta, actions);
    return row;
  }

  async function refreshClaudePlugins(live = false): Promise<void> {
    pluginStatus.textContent = live ? "목록을 다시 읽는 중…" : "플러그인 확인 중…";
    try {
      const snapshot = await getClaudePlugins(live);
      pluginStatus.textContent = snapshot.message;
      pluginStatus.dataset.state = snapshot.marketplaceReady ? "ok" : "needs-setup";
      pluginInstalled.replaceChildren();
      if (snapshot.installed.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ai-settings-help";
        empty.textContent = "아직 설치한 플러그인이 없습니다.";
        pluginInstalled.append(empty);
      } else {
        for (const plugin of snapshot.installed) {
          pluginInstalled.append(renderPluginRow(plugin, "installed"));
        }
      }
      pluginAvailable.replaceChildren();
      const available = snapshot.available.slice(0, 24);
      if (available.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ai-settings-help";
        empty.textContent = "이름만 입력해서 설치할 수도 있습니다.";
        pluginAvailable.append(empty);
      } else {
        for (const plugin of available) {
          pluginAvailable.append(renderPluginRow(plugin, "available"));
        }
      }
    } catch (error) {
      pluginStatus.textContent = errorText(error);
      pluginStatus.dataset.state = "needs-setup";
    }
  }

  async function ensurePreferences(force = false): Promise<void> {
    if (!force && prefsLoaded && Date.now() - prefsFreshAt < TAB_TTL_MS) {
      return;
    }
    await refreshPreferences();
    prefsLoaded = true;
    prefsFreshAt = Date.now();
  }

  async function refreshVisibleTab(
    tab: keyof typeof panes,
    force = false
  ): Promise<void> {
    if (!force && Date.now() - (tabFreshAt.get(tab) ?? 0) < TAB_TTL_MS) {
      return;
    }
    tabFreshAt.set(tab, Date.now());
    try {
      switch (tab) {
        case "basic":
          await Promise.all([
            refreshProject(),
            ensurePreferences(),
            refreshFreeAutoReadiness(),
            apiKeys.refresh(),
            appPreferences.refresh(),
          ]);
          break;
        case "accounts":
          await Promise.all([
            ensurePreferences(),
            refreshWebAccounts(),
            refreshLoginStatus(),
          ]);
          break;
        case "claude":
          await Promise.all([claudeIntegration.refresh(), refreshClaudePlugins()]);
          break;
        case "updates":
          await Promise.all([updateSection.refresh(), scheduledJobs.refresh(), alertsSection.refresh()]);
          break;
        case "character":
          await renderUserModels();
          break;
        case "advanced":
          await Promise.all([
            ensurePreferences(),
            refreshEnvironment(),
            refreshAutomaticProviders(),
            refreshAgents(),
            refreshRunHistory(),
            refreshCheckpoints(),
            policySection.refresh(),
          ]);
          break;
      }
    } catch (error) {
      tabFreshAt.delete(tab);
      message.textContent = `일부 설정을 불러오지 못했습니다. 탭을 다시 열면 재시도합니다: ${errorText(error)}`;
    }
  }

  function scheduleTabRefresh(tab: keyof typeof panes, force = false): void {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void refreshVisibleTab(tab, force);
      });
    });
  }

  const installTypedPlugin = async (): Promise<void> => {
    const spec = pluginInput.value.trim();
    if (!spec) {
      message.textContent = "웹에서 본 플러그인 이름을 입력하세요.";
      return;
    }
    pluginInstallButton.disabled = true;
    message.textContent = `${spec} 설치 중…`;
    try {
      message.textContent = await installClaudePlugin(spec);
      pluginInput.value = "";
      await refreshClaudePlugins();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      pluginInstallButton.disabled = false;
    }
  };

  pluginBrowseButton.addEventListener("click", async () => {
    pluginBrowseButton.disabled = true;
    message.textContent = "플러그인 목록 페이지를 엽니다…";
    try {
      message.textContent = await openClaudePluginCatalog("catalog");
      pluginInput.focus();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      pluginBrowseButton.disabled = false;
    }
  });

  pluginRepoButton.addEventListener("click", async () => {
    pluginRepoButton.disabled = true;
    try {
      message.textContent = await openClaudePluginCatalog("repo");
      pluginInput.focus();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      pluginRepoButton.disabled = false;
    }
  });

  pluginInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void installTypedPlugin();
    }
  });

  pluginInstallButton.addEventListener("click", () => {
    void installTypedPlugin();
  });

  pluginRefreshButton.addEventListener("click", async () => {
    pluginRefreshButton.disabled = true;
    message.textContent = "플러그인 목록을 다시 읽습니다…";
    try {
      await refreshClaudePlugins(true);
      message.textContent = pluginStatus.textContent;
    } finally {
      pluginRefreshButton.disabled = false;
    }
  });

  pluginMarketButton.addEventListener("click", async () => {
    pluginMarketButton.disabled = true;
    message.textContent = "공식 마켓을 연결합니다…";
    try {
      const result = await addClaudePluginMarketplace(
        "anthropics/claude-plugins-official"
      );
      await refreshClaudePlugins();
      message.textContent = result;
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      pluginMarketButton.disabled = false;
    }
  });

  for (const control of [
    cradleCheckbox,
    webSearchCheckbox,
    geminiApiCheckbox,
    freeFirstCheckbox,
    openAiApiCheckbox,
    closeAfterHandoffCheckbox,
    closeWhenDoneCheckbox,
    sensitiveCheckbox,
    defaultAgentSelect,
    timeoutInput,
  ]) {
    control.addEventListener("change", () => {
      if (timeoutInput.value !== "" && !saveRuntimeButton.disabled) {
        saveRuntimeButton.click();
      }
    });
  }

  saveRuntimeButton.addEventListener("click", async () => {
    const timeoutSeconds = Number(timeoutInput.value);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) {
      message.textContent = "최대 대기 시간은 10초에서 3600초 사이의 정수로 넣어 주세요.";
      return;
    }

    saveRuntimeButton.disabled = true;
    message.textContent = "저장 중…";
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
        freeAiFirst: freeFirstCheckbox.checked,
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
      freeFirstCheckbox.checked = saved.freeAiFirst;
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
      invalidateSettings();
      window.dispatchEvent(
        new CustomEvent("ai-character:preferences-updated", { detail: saved })
      );
      message.textContent = "설정을 저장했습니다.";
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

  githubLoginButton.addEventListener("click", async () => {
    githubLoginButton.disabled = true;
    message.textContent = "GitHub 로그인을 기본 브라우저에서 엽니다…";
    try {
      message.textContent = await launchGithubLogin();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      githubLoginButton.disabled = false;
    }
  });

  refreshAccountsButton.addEventListener("click", () => {
    void refreshWebAccounts();
    void refreshLoginStatus(true);
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
      freeFirstCheckbox.checked = saved.freeAiFirst;
      openAiApiCheckbox.checked = saved.allowPaidOpenAiApi;
      invalidateSettings("basic");
      invalidateSettings("advanced");
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

  confirmOnSecondClick(resetSettingsButton, "한 번 더 누르면 초기화", () => {
    void (async () => {
      resetSettingsButton.disabled = true;
      message.textContent = "설정을 처음 상태로 돌리는 중…";
      try {
        message.textContent = await resetRecommendedSettings();
        invalidateSettings();
        await refreshPreferences();
        await refreshFreeAutoReadiness();
      } catch (error) {
        message.textContent = errorText(error);
      } finally {
        resetSettingsButton.disabled = false;
      }
    })();
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
          ? `설치 완료 (${okCount}개). AI 프로그램은 각 앱에서 한 번 로그인하세요.`
          : `일부 완료 (${okCount}/${steps.length}). ${failed
              .map((step) => step.message)
              .join(" / ")}`;
      invalidateSettings("basic");
      invalidateSettings("advanced");
      await refreshFreeAutoReadiness();
      await refreshAgents();
    } catch (error) {
      message.textContent = errorText(error);
    } finally {
      installRuntimesButton.disabled = false;
    }
  });

  // 시작 때 설치/경로 검사를 돌리지 않는다. 설정 → 기본의 필수 프로그램 설치만 사용.
  // 없는 프로그램을 자동 설치합니다 — 첫 실행 자동 설치는 창을 멈추게 해서 제거함.

  prepareEnvironmentButton.addEventListener("click", async () => {
    prepareEnvironmentButton.disabled = true;
    message.textContent = "AI 작업 환경을 확인하고 준비합니다…";
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
      message.textContent = "프로젝트 폴더를 변경했습니다. 새 AI 작업부터 새 경로를 사용합니다.";
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

  importReplaceButton.title = "기존 대화를 모두 지우고 백업으로 바꿉니다. 한 번 더 누르면 실행합니다.";
  confirmOnSecondClick(importReplaceButton, "한 번 더 누르면 전체 교체", () => {
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
        remove.title = "한 번 더 누르면 삭제합니다";
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        confirmOnSecondClick(remove, "삭제?", () => {
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

  dedupeModelsButton.title = "내용이 같은 내 모델을 하나만 남기고 지웁니다. 한 번 더 누르면 실행합니다.";
  confirmOnSecondClick(dedupeModelsButton, "한 번 더 누르면 중복 삭제", () => {
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
    openSettings(tab);
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
