// Pixi builds shader code with new Function() unless this is loaded first; with it the app can
// run under a CSP without 'unsafe-eval' (tauri.conf.json).
import "pixi.js/unsafe-eval";
import { confirmOnSecondClick } from "./settings-controls";
import { initializeCradleOrchestrationUi } from "./orchestration-ui";
import { askCradleCompat } from "./orchestration-engine";
import { initializeSettingsUi } from "./settings-ui";
import { initializeAgentRuntimeUi } from "./agent-runtime-ui";
import { initializeChatProgressUi } from "./chat-progress";
import { openWorkLogWindow } from "./work-log-window";
import { renderMarkdown } from "./chat-markdown";
import { SHORTCUT_HELP, additionsPrompt, mergedPrompt, renderWelcome, setupComposer, setupScrollFollow, type Composer, type ScrollFollower } from "./chat-composer";
import { classifyRequestIntent } from "./request-intent";
import { formatAnswerSource, lookupAnswerSource } from "./answer-source";
import { friendlyChatError } from "./chat-errors";
import { SPEAKING_EVENT, setupVoiceButtons, speakAnswer, stopSpeaking } from "./voice";
import { HISTORY_SAVE_FAILED_EVENT } from "./chat-history";
import { initializeAutomationPanel } from "./automation-panel-ui";
import { notificationPreview, notifyDesktop, shouldNotifyCompletion } from "./alerts-client";
import { startLiveReply, type LiveReply } from "./chat-stream";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getScreenCursor,
  setClickThroughCapture,
  setClickThroughRegions,
  toScreenRegion,
} from "./native-click-through";
import { initializeUsageDashboardUi } from "./usage-dashboard-ui";
import { initializeUpdateNotices } from "./update-ui";
import { initializeSqliteStateMirror } from "./chat-state-client";
import {
  getPerformanceHudPosition,
  readPerformanceHudVisible,
} from "./performance-hud";
import {
  formatPerformanceText,
  readProcessStats,
} from "./performance-client";
import { patchPerformanceHudActivity } from "./performance-hud-text";
import {
  CHARACTER_WINDOW_HUD_EXTRA,
  CHARACTER_WINDOW_PADDING,
  WINDOW_POSITION_KEY,
  characterBodyWidth,
  characterCenterXForChat,
  characterDisplaySize,
  characterPaneWidthForChat,
  characterScaleForPreset,
  chatLeftForCharacterLayout,
  clampWindowPositionToMonitor,
  compactWindowSizeForCharacter,
  logicalWorkArea,
  maxCharacterScaleBesideChat,
  maxCharacterScaleForMonitor,
  scaleFromVisualPercent,
  stepCharacterScale,
  visualSizePercent,
  occupancyFromModelBounds,
  pickVisualModelBox,
  readStoredWindowPosition,
  windowPositionKeepingCharacter,
} from "./window-layout";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./styles.css";
import "./chat-extras.css";
// Last, so the light colors win over the dark design when <html data-theme="light">.
import "./theme-light.css";

import {
  Application,
  Assets,
  extensions,
  loadTextures,
  Ticker,
} from "pixi.js";

import {
  Live2DModel,
  Live2DPlugin,
} from "@laplace.live/pixijs-live2d";

import {
  availableMonitors,
  currentMonitor,
  primaryMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";

import {
  windowPositionForGrab,
} from "./character-window-drag";

import {
  buildMotionChoices,
} from "./motion-menu";

import {
  activityFromCradleStatus,
  CHARACTER_ACTIVITY_LABELS,
  createCharacterActivityController,
  workSway,
} from "./character-activity";

import {
  characterHitLayerBox,
} from "./click-through";

import {
  open,
} from "@tauri-apps/plugin-dialog";

import {
  buildPendingAttachments,
  type PendingAttachment,
} from "./attachment-selection";

import {
  buildAttachmentPrompt,
} from "./attachment-prompt";

import {
  inspectAttachmentAccess,
  attachmentAccessLabel,
  type AttachmentAccess,
} from "./attachment-access";

import {
  stageAttachment,
  removeStagedAttachment,
  savePastedImage,
} from "./attachment-staging";

import {
  CHAT_WINDOW_MARGIN,
  MAX_CHAT_HEIGHT,
  MAX_CHAT_WIDTH,
  MIN_CHAT_HEIGHT,
  MIN_CHAT_WIDTH,
  ABSOLUTE_MIN_CHAT_WIDTH,
  chatAppWindowSize,
  clampChatSize,
  minChatAppWindowSize,
  minChatWidthForWorkArea,
  readChatHeight,
  readChatWidth,
  shouldApplyChatWindowSize,
} from "./chat-resize";

import {
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";

import {
  CONVERSATION_SHOWN_EVENT,
  isRenderingHistory,
  setupChatHistory,
  type ChatHistoryManager,
} from "./chat-history-ui";
import { quietConsoleInProduction } from "./quiet-console";
import { initializeConversationFolderUi } from "./conversation-folder-ui";
import { resolveLive2DAssetUrl, resolveLive2DModelSource } from "./live2d-asset-url";
import { patchLive2DAssetFetchMime } from "./live2d-fetch-mime";
import { waitForTauri } from "./tauri-ready";

quietConsoleInProduction();

const CHARACTER_DRAG_POLL_MS = 32;
const CHARACTER_MAX_FPS = 30;
const CHAT_RESIZE_POLL_MS = 32;

try {
  extensions.add(Live2DPlugin);
} catch {
  // 이미 등록된 경우
}

/** A broken panel must never keep the character itself from loading. */
function initializeOptionalUi(name: string, init: () => void): void {
  try {
    init();
  } catch (error) {
    console.error(`${name} UI 초기화 실패:`, error);
  }
}

async function startLive2D() {
  const ready = await waitForTauri();
  if (!ready) {
    throw new Error("앱 창이 아직 준비되지 않았습니다. 잠시 후 다시 실행해 주세요.");
  }
  void getCurrentWebview()
    .setBackgroundColor({ red: 0, green: 0, blue: 0, alpha: 0 })
    .catch(() => undefined);
  // Restore saved UI state before the chat reads it, or the restore can replace the history under
  // a running chat. Capped so a slow disk (macOS TCC prompt on external volumes) never blocks
  // start-up.
  await Promise.race([
    initializeSqliteStateMirror(),
    new Promise((resolve) => window.setTimeout(resolve, 1_500)),
  ]);
  initializeOptionalUi("Agent 상태", () => { initializeAgentRuntimeUi(); });
  initializeOptionalUi("진행 표시", () => { initializeChatProgressUi(); });
  initializeOptionalUi("설정", () => { initializeSettingsUi(); });
  initializeOptionalUi("작업 폴더", () => { initializeConversationFolderUi(); });
  initializeOptionalUi("CRADLE", () => { initializeCradleOrchestrationUi(); });
  const canvas =
    document.querySelector<HTMLCanvasElement>(
      "#live2d-canvas"
    );

  const status =
    document.querySelector<HTMLDivElement>(
      "#status"
    );

  const flashStatus = (
    text: string,
    kind: "info" | "error" = "info",
    ms = 2200
  ) => {
    if (!status) {
      return;
    }
    status.textContent = text;
    status.classList.toggle("error", kind === "error");
    status.classList.remove("hidden");
    window.setTimeout(() => {
      status.classList.add("hidden");
      status.classList.remove("error");
    }, ms);
  };

  const chatPanel =
    document.querySelector<HTMLDivElement>(
      "#chat-panel"
    );

  const chatForm =
    document.querySelector<HTMLFormElement>(
      "#chat-form"
    );

  const chatInput =
    document.querySelector<HTMLTextAreaElement>(
      "#chat-input"
    );

  const messages =
    document.querySelector<HTMLDivElement>(
      "#messages"
    );

  const INTERACTIVE_UI_SELECTOR = [
    "#chat-panel",
    "#ai-settings-panel",
    "#usage-dashboard-panel",
    "#automation-panel",
    "#chat-history-toolbar",
    "#chat-history-drawer",
    "#rightclick-test-menu",
    ".chat-resize-handle",
    "button",
    "input",
    "textarea",
    "select",
    "a",
    "label",
    "summary",
  ].join(",");

  const eventHitsInteractiveUi = (event: {
    clientX?: number;
    clientY?: number;
    nativeEvent?: { clientX?: number; clientY?: number };
  }): boolean => {
    const x = event.clientX ?? event.nativeEvent?.clientX;
    const y = event.clientY ?? event.nativeEvent?.clientY;
    if (typeof x !== "number" || typeof y !== "number") {
      return false;
    }
    const hit = document.elementFromPoint(x, y);
    if (!(hit instanceof Element)) {
      return false;
    }
    if (hit === canvas || hit.id === "live2d-canvas" || hit.id === "character-hit-layer") {
      return false;
    }
    return Boolean(hit.closest(INTERACTIVE_UI_SELECTOR));
  };

  const setChatOpen = (open: boolean): void => {
    if (!chatPanel) {
      return;
    }
    chatPanel.classList.toggle("open", open);
    if (open) {
      void setClickThroughCapture(true).catch(() => undefined);
      window.setTimeout(() => {
        chatInput?.focus();
        pushNativeClickThrough(true);
      }, 40);
      return;
    }
    const settings = document.querySelector<HTMLElement>("#ai-settings-panel");
    if (settings) {
      settings.hidden = true;
    }
    const usage = document.querySelector<HTMLElement>("#usage-dashboard-panel");
    if (usage) {
      usage.hidden = true;
    }
    if (canvas) {
      canvas.style.pointerEvents = "auto";
    }
    window.dispatchEvent(new CustomEvent("ai-character:settings-closed"));
  };

  const notifyIfAway = (startedAt: number, title: string, body: string): void => {
    if (shouldNotifyCompletion(Date.now() - startedAt, document.hasFocus(), Boolean(chatPanel?.classList.contains("open")))) {
      notifyDesktop(title, notificationPreview(body));
    }
  };

  const usageDashboardUi = initializeUsageDashboardUi({ setChatOpen });
  initializeOptionalUi("업데이트 알림", () => { initializeUpdateNotices(); });
  initializeOptionalUi("자동화 현황", () => { initializeAutomationPanel({ setChatOpen }); });

  void listen<string>("tray-action", (event) => {
    const action = event.payload;
    if (action === "chat") {
      setChatOpen(true);
      return;
    }
    if (action === "settings") {
      setChatOpen(true);
      window.dispatchEvent(new CustomEvent("ai-character:open-settings"));
      return;
    }
    if (action === "usage") {
      void usageDashboardUi.openDetailed().catch(() => undefined);
      return;
    }
    if (action === "automation") {
      window.dispatchEvent(new Event("ai-character:open-automation"));
      return;
    }
    if (action === "new-chat") {
      setChatOpen(true);
      document.querySelector<HTMLButtonElement>("#new-chat-button")?.click();
      return;
    }
    if (action === "stop") {
      window.dispatchEvent(new Event("ai-character:stop-active-work"));
      return;
    }
    if (action === "reset-position") {
      void resetCharacterPosition();
    }
  }).catch(() => undefined);

  /** Tray → 캐릭터 위치 초기화: back to the primary monitor's lower right, e.g. after the
   * character ended up off-screen or on a monitor that was unplugged. */
  async function resetCharacterPosition(): Promise<void> {
    try {
      localStorage.removeItem(WINDOW_POSITION_KEY);
      const appWindow = getCurrentWindow();
      const [monitor, size] = await Promise.all([primaryMonitor(), appWindow.outerSize()]);
      if (!monitor) return;
      const margin = Math.round(40 * monitor.scaleFactor);
      await appWindow.setPosition(
        new PhysicalPosition(
          monitor.position.x + Math.max(0, monitor.size.width - size.width - margin),
          monitor.position.y + Math.max(0, monitor.size.height - size.height - margin)
        )
      );
      await appWindow.show();
      flashStatus("캐릭터를 화면 오른쪽 아래로 옮겼습니다");
    } catch (error) {
      flashStatus(`캐릭터 위치를 옮기지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error", 3600);
    }
  }

  document
    .querySelector("#chat-close-button")
    ?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setChatOpen(false);
    });

  document
    .querySelector("#chat-history-toolbar")
    ?.addEventListener(
      "pointerdown",
      (event) => {
        event.stopPropagation();
      },
      true
    );

  const attachmentButton =
    document.querySelector<HTMLButtonElement>(
      "#attachment-button"
    );

  const attachmentList =
    document.querySelector<HTMLDivElement>(
      "#attachment-list"
    );

  let pendingAttachments:
    PendingAttachment[] = [];

  let chatHistory:
    ChatHistoryManager | null = null;

  const attachmentAccess =
    new Map<
      string,
      AttachmentAccess
    >();

  const CHAT_WIDTH_KEY =
    "chat-panel-width";
  const CHAT_HEIGHT_KEY =
    "chat-panel-height";

  let chatPanelWidth =
    readChatWidth(
      localStorage.getItem(CHAT_WIDTH_KEY)
    );
  let chatPanelHeight =
    readChatHeight(
      localStorage.getItem(CHAT_HEIGHT_KEY)
    );

  let layoutWorkArea = { width: 1280, height: 720 };

  const readChatLeft = (): number => {
    const chatLeft = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--ai-character-chat-left"
      )
    );
    return Number.isFinite(chatLeft) && chatLeft > 40 ? chatLeft : 168;
  };

  const applyChatPanelSize = (
    width = chatPanelWidth,
    height = chatPanelHeight,
    maxToWindow = true
  ) => {
    if (!chatPanel) {
      return { width: chatPanelWidth, height: chatPanelHeight };
    }
    const chatLeft = readChatLeft();
    const stripRaw = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--ai-character-hud-strip"
      )
    );
    const strip =
      Number.isFinite(stripRaw) && stripRaw >= 0 ? stripRaw : 40;
    const minChat = minChatWidthForWorkArea(layoutWorkArea.width);
    const remainingWidth = window.innerWidth - chatLeft - CHAT_WINDOW_MARGIN;
    const maxWidth = maxToWindow
      ? Math.min(
          MAX_CHAT_WIDTH,
          Math.max(ABSOLUTE_MIN_CHAT_WIDTH, remainingWidth)
        )
      : MAX_CHAT_WIDTH;
    const maxHeight = maxToWindow
      ? Math.min(
          MAX_CHAT_HEIGHT,
          Math.max(
            MIN_CHAT_HEIGHT,
            window.innerHeight - strip - CHAT_WINDOW_MARGIN
          )
        )
      : MAX_CHAT_HEIGHT;
    const next = clampChatSize(
      width,
      height,
      maxWidth,
      maxHeight,
      Math.min(minChat, maxWidth)
    );
    chatPanelWidth = next.width;
    chatPanelHeight = next.height;
    document.documentElement.style.setProperty(
      "--ai-character-chat-width",
      `${next.width}px`
    );
    document.documentElement.style.setProperty(
      "--ai-character-chat-height",
      `${next.height}px`
    );
    chatPanel.style.setProperty("width", `${next.width}px`, "important");
    chatPanel.style.setProperty("height", `${next.height}px`, "important");
    return next;
  };

  applyChatPanelSize();

  let chatPanelResizing = false;

  const PERFORMANCE_HUD_KEY =
    "performance-hud-visible";

  let performanceHudVisible =
    readPerformanceHudVisible(
      localStorage.getItem(
        PERFORMANCE_HUD_KEY
      )
    );

  let applyPerformanceHudVisibility:
    ((visible: boolean) => void)
    | null = null;

  const hudStripPx = () =>
    performanceHudVisible ? CHARACTER_WINDOW_HUD_EXTRA : 8;

  const characterBaselineY = () =>
    Math.max(24, window.innerHeight - hudStripPx());

  const applyHudStripLayout = () => {
    const strip = hudStripPx();
    document.documentElement.style.setProperty(
      "--ai-character-hud-strip",
      `${strip}px`
    );
    if (chatPanel?.classList.contains("open")) {
      chatPanel.style.setProperty("bottom", `${strip}px`, "important");
    }
  };


  if (!canvas) {
    throw new Error("Live2D canvas 없음");
  }

  let playCurrentMotion:
    ((
      group: string,
      index?: number
    ) => void)
    | null = null;

  /*
   * 캐릭터 크기 상태
   */
  type SizePreset =
    | "tiny"
    | "small"
    | "medium"
    | "large";

  const sizePresets: Record<
    SizePreset,
    number
  > = {
    tiny: 0.20,
    small: 0.28,
    medium: 0.38,
    large: 0.50,
  };

  let selectedSize =
    (
      localStorage.getItem(
        "selected-character-size"
      ) as SizePreset | null
    ) ?? "small";

  if (!(selectedSize in sizePresets)) {
    selectedSize = "tiny";
  }

  let characterScale = 1;

  const refreshLayoutWorkArea = async () => {
    try {
      const [monitor, scale] = await Promise.all([
        currentMonitor(),
        getCurrentWindow().scaleFactor(),
      ]);
      layoutWorkArea = logicalWorkArea(monitor, scale, layoutWorkArea);
    } catch {
      layoutWorkArea = {
        width: Math.max(320, window.innerWidth || layoutWorkArea.width),
        height: Math.max(240, window.innerHeight || layoutWorkArea.height),
      };
    }
    return layoutWorkArea;
  };

  let onCharacterScaleChanged:
    (() => void) | null = null;

  let applyCharacterSize:
    (preset: SizePreset) => void =
    (preset) => {
      selectedSize = preset;

      localStorage.setItem(
        "selected-character-size",
        preset
      );
    };


  /*
   * 단일 패널 우클릭 메뉴 (드릴다운)
   * - 옆에 서브메뉴를 띄우지 않음 → 작은 창에서 겹침 방지
   * - 호버로 여러 하위메뉴를 동시에 열지 않음 (클릭만)
   * - 메뉴가 열린 동안 click-through 잠금
   */
  let contextMenuOpen = false;
  let menuCursorLock = false;
  let menuViewToken = 0;
  let menuOpenOnPointerDown = false;
  let openCharacterMenu: {
    menu: HTMLDivElement;
    anchorX: number;
    anchorY: number;
  } | null = null;


  type CharacterCatalogItem = {
    id: string;
    name: string;
    gender?: "female" | "male" | "mascot" | string;
    source?: string;
    model: string;
    motions: Record<string, number>;
    folder?: string;
  };

  const refreshClickThroughGeometry = async () => {
    try {
      const win = getCurrentWindow();
      const [pos, factor] = await Promise.all([
        win.innerPosition(),
        win.scaleFactor(),
      ]);
      const hook = (
        window as unknown as {
          __aiCharacterRefreshClickThrough?: (
            pos: PhysicalPosition,
            factor: number
          ) => void;
        }
      ).__aiCharacterRefreshClickThrough;
      hook?.(pos, factor);
      await setClickThroughCapture(true);
    } catch {
      // ignore
    }
  };

  const getOrCreateContextMenu = (): HTMLDivElement => {
    let menu = document.querySelector<HTMLDivElement>(
      "#rightclick-test-menu"
    );
    if (menu) {
      return menu;
    }

    menu = document.createElement("div");
    menu.id = "rightclick-test-menu";
    menu.className = "character-context-menu";
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    return menu;
  };

  const placeContextMenu = (
    menu: HTMLDivElement,
    clientX: number,
    clientY: number
  ) => {
    menu.classList.add("character-context-menu");
    menu.style.visibility = "hidden";
    menu.style.display = "block";

    const width = Math.min(272, Math.max(188, window.innerWidth - 16));
    menu.style.width = `${width}px`;

    const reservedBottom = isChatOpen()
      ? 16
      : Math.min(Math.round(window.innerHeight * 0.46), 240);
    const maxHeight = Math.max(150, window.innerHeight - reservedBottom - 12);
    menu.style.maxHeight = `${maxHeight}px`;

    const height = Math.min(menu.scrollHeight, maxHeight);
    const chatLeft = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--ai-character-chat-left"
      )
    );
    let left = clientX + 14;
    if (isChatOpen() && Number.isFinite(chatLeft) && chatLeft > 40) {
      left = Math.min(
        Math.max(chatLeft + 8, 8),
        window.innerWidth - width - 8
      );
    } else if (left + width > window.innerWidth - 8) {
      left = Math.max(8, clientX - width - 14);
    }
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));

    menu.style.left = `${left}px`;
    menu.style.top = "8px";
    menu.style.visibility = "visible";
    void clientY;
    void height;
  };

  const closeContextMenu = () => {
    menuViewToken += 1;
    openCharacterMenu = null;
    const menu = document.querySelector<HTMLDivElement>(
      "#rightclick-test-menu"
    );
    if (menu) {
      menu.style.display = "none";
      menu.innerHTML = "";
    }
    contextMenuOpen = false;
    menuCursorLock = false;
    void refreshClickThroughGeometry();
  };

  const hideCharacterWindow = () => {
    closeContextMenu();
    setChatOpen(false);
    flashStatus("숨겼습니다. Ctrl+Shift+Space로 다시 나옵니다.", "info", 700);
    window.setTimeout(() => {
      void getCurrentWindow().hide().catch((error) => {
        console.warn("캐릭터 숨기기 실패:", error);
      });
    }, 450);
  };

  const makeMenuHeader = (title: string) => {
    const header = document.createElement("div");
    header.className = "character-context-menu-header";
    const label = document.createElement("span");
    label.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "character-context-menu-close";
    close.setAttribute("aria-label", "메뉴 닫기");
    close.title = "닫기";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu();
    });
    header.append(label, close);
    return header;
  };

  const makeMenuButton = (
    text: string,
    onClick: () => void,
    options?: { arrow?: boolean; muted?: boolean }
  ) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "space-between";
    button.style.width = "100%";
    button.style.margin = "3px 0";
    button.style.padding = "8px 9px";
    button.style.border = "0";
    button.style.borderRadius = "8px";
    button.style.background = "rgb(48, 52, 64)";
    button.style.color = "rgb(245, 247, 252)";
    button.style.textAlign = "left";
    button.style.cursor = "pointer";
    button.style.font = "inherit";

    const label = document.createElement("span");
    label.textContent = text;
    if (options?.muted) {
      label.style.opacity = "0.7";
    }
    button.appendChild(label);

    if (options?.arrow) {
      const rightArrow = document.createElement("span");
      rightArrow.textContent = "›";
      rightArrow.style.opacity = "0.65";
      rightArrow.style.fontSize = "16px";
      rightArrow.style.lineHeight = "1";
      button.appendChild(rightArrow);
    }

    button.addEventListener("mouseenter", () => {
      button.style.background = "rgb(64, 70, 86)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.background = "rgb(48, 52, 64)";
    });
    button.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      onClick();
    });

    return button;
  };

  /** 내 모델: 이름 + 작은 × 삭제 (한 줄) */
  const makeUserModelMenuRow = (
    label: string,
    onSelect: () => void,
    onDelete: () => void
  ) => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "2px";
    row.style.width = "100%";
    row.style.margin = "3px 0";
    row.style.borderRadius = "8px";
    row.style.background = "rgb(48, 52, 64)";
    row.style.boxSizing = "border-box";

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.setAttribute("role", "menuitem");
    selectBtn.textContent = label;
    selectBtn.style.flex = "1";
    selectBtn.style.minWidth = "0";
    selectBtn.style.margin = "0";
    selectBtn.style.padding = "8px 9px";
    selectBtn.style.border = "0";
    selectBtn.style.borderRadius = "8px";
    selectBtn.style.background = "transparent";
    selectBtn.style.color = "white";
    selectBtn.style.textAlign = "left";
    selectBtn.style.cursor = "pointer";
    selectBtn.style.font = "inherit";
    selectBtn.style.overflow = "hidden";
    selectBtn.style.textOverflow = "ellipsis";
    selectBtn.style.whiteSpace = "nowrap";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.setAttribute("aria-label", "삭제");
    deleteBtn.title = "삭제";
    deleteBtn.textContent = "×";
    deleteBtn.style.flex = "0 0 auto";
    deleteBtn.style.minWidth = "28px";
    deleteBtn.style.whiteSpace = "nowrap";
    deleteBtn.style.height = "28px";
    deleteBtn.style.margin = "0 4px 0 0";
    deleteBtn.style.padding = "0 6px";
    deleteBtn.style.border = "0";
    deleteBtn.style.borderRadius = "6px";
    deleteBtn.style.background = "transparent";
    deleteBtn.style.color = "rgba(255,255,255,0.45)";
    deleteBtn.style.cursor = "pointer";
    deleteBtn.style.font = "inherit";
    deleteBtn.style.fontSize = "16px";
    deleteBtn.style.lineHeight = "1";

    const setRowHover = (active: boolean) => {
      row.style.background = active
        ? "rgb(64, 70, 86)"
        : "rgb(48, 52, 64)";
    };
    row.addEventListener("mouseenter", () => setRowHover(true));
    row.addEventListener("mouseleave", () => {
      setRowHover(false);
      deleteBtn.style.color = "rgba(255,255,255,0.45)";
      deleteBtn.style.background = "transparent";
    });
    deleteBtn.addEventListener("mouseenter", () => {
      deleteBtn.style.color = "rgba(255,140,140,0.95)";
      deleteBtn.style.background = "rgba(180,60,60,0.35)";
    });
    deleteBtn.addEventListener("mouseleave", () => {
      deleteBtn.style.color = "rgba(255,255,255,0.45)";
      deleteBtn.style.background = "transparent";
    });

    selectBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect();
    });
    deleteBtn.title = "한 번 더 누르면 삭제합니다";
    deleteBtn.addEventListener("click", (event) => event.stopPropagation());
    confirmOnSecondClick(deleteBtn, "삭제?", onDelete);

    row.append(selectBtn, deleteBtn);
    return row;
  };

  const makeMenuNote = (text: string) => {
    const note = document.createElement("div");
    note.textContent = text;
    note.style.padding = "8px 7px";
    note.style.fontSize = "12px";
    note.style.opacity = "0.65";
    return note;
  };

  const makeMenuTitle = (text: string) => {
    const title = document.createElement("div");
    title.textContent = text;
    title.style.padding = "5px 7px 7px";
    title.style.fontSize = "11px";
    title.style.opacity = "0.6";
    return title;
  };

  const loadCharacterCatalog = async (): Promise<
    CharacterCatalogItem[]
  > => {
    const response = await fetch(
      await resolveLive2DAssetUrl("/live2d/models/models.json")
    );
    const bundled = (await response.json()) as CharacterCatalogItem[];
    const dedupeKey = (item: CharacterCatalogItem) =>
      `${item.id}|${item.name}|${item.model}`.toLowerCase();
    try {
      const { listUserLive2DModels } = await import("./user-live2d");
      const userModels = await listUserLive2DModels();
      const merged: CharacterCatalogItem[] = [
        ...userModels.map((item) => ({
          id: item.id,
          name: item.name,
          gender: item.gender,
          source: "user" as const,
          model: item.model,
          motions: item.motions,
          folder: item.folder,
        })),
        ...bundled,
      ];
      const seen = new Set<string>();
      return merged.filter((item) => {
        const key = dedupeKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch {
      return bundled;
    }
  };

  const renderContextMenuRoot = (
    menu: HTMLDivElement,
    anchorX: number,
    anchorY: number
  ) => {
    const token = ++menuViewToken;
    menu.innerHTML = "";
    menu.appendChild(makeMenuHeader("메뉴"));
    menu.appendChild(
      makeMenuButton("캐릭터 숨기기", () => {
        hideCharacterWindow();
      })
    );

    menu.appendChild(
      makeMenuButton(
        "캐릭터 변경",
        () => {
          void renderCharacterView(menu, anchorX, anchorY, token);
        },
        { arrow: true }
      )
    );
    menu.appendChild(
      makeMenuButton(
        "행동",
        () => {
          void renderMotionView(menu, anchorX, anchorY, token);
        },
        { arrow: true }
      )
    );
    menu.appendChild(
      makeMenuButton(
        "크기",
        () => {
          renderSizeView(menu, anchorX, anchorY, token);
        },
        { arrow: true }
      )
    );
    menu.appendChild(
      makeMenuButton(
        performanceHudVisible ? "성능 표시 ✓" : "성능 표시",
        () => {
          performanceHudVisible = !performanceHudVisible;
          localStorage.setItem(
            PERFORMANCE_HUD_KEY,
            performanceHudVisible ? "true" : "false"
          );
          applyPerformanceHudVisibility?.(performanceHudVisible);
          syncChatModelPosition();
          closeContextMenu();
        }
      )
    );
    menu.appendChild(
      makeMenuButton("자동화 현황", () => {
        closeContextMenu();
        window.dispatchEvent(new Event("ai-character:open-automation"));
      })
    );
    menu.appendChild(
      makeMenuButton("사용량", () => {
        closeContextMenu();
        void usageDashboardUi.openDetailed().catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          flashStatus(`사용량 열기 실패: ${message}`, "error", 4000);
        });
      })
    );
    placeContextMenu(menu, anchorX, anchorY);
  };

  const renderBackAndBody = (
    menu: HTMLDivElement,
    title: string,
    anchorX: number,
    anchorY: number,
    parentToken: number,
    fill: (body: HTMLDivElement) => void
  ) => {
    if (parentToken !== menuViewToken) {
      return;
    }

    menu.innerHTML = "";
    menu.appendChild(makeMenuHeader(title));
    menu.appendChild(
      makeMenuButton("← 뒤로", () => {
        renderContextMenuRoot(menu, anchorX, anchorY);
      })
    );

    const body = document.createElement("div");
    fill(body);
    menu.appendChild(body);
    placeContextMenu(menu, anchorX, anchorY);
  };

  const renderCharacterView = async (
    menu: HTMLDivElement,
    anchorX: number,
    anchorY: number,
    _parentToken: number
  ) => {
    void _parentToken;
    const token = ++menuViewToken;
    openCharacterMenu = { menu, anchorX, anchorY };
    menu.innerHTML = "";
    menu.appendChild(makeMenuHeader("캐릭터 변경"));
    menu.appendChild(makeMenuNote("캐릭터 목록 불러오는 중…"));
    placeContextMenu(menu, anchorX, anchorY);

    try {
      const characters = await loadCharacterCatalog();
      if (token !== menuViewToken) {
        return;
      }

      const selectedModel = localStorage.getItem(
        "selected-live2d-model"
      );

      const genderRank = (character: CharacterCatalogItem) => {
        if (character.source === "user") return -1;
        if (character.gender === "female") return 0;
        if (character.gender === "mascot") return 2;
        return 1;
      };

      const ordered = [...characters].sort((left, right) => {
        const byGender = genderRank(left) - genderRank(right);
        if (byGender !== 0) return byGender;
        return left.name.localeCompare(right.name, "ko");
      });

      renderBackAndBody(
        menu,
        "캐릭터 변경",
        anchorX,
        anchorY,
        token,
        (body) => {
          let lastGroup: string | null = null;
          for (const character of ordered) {
            const group =
              character.source === "user"
                ? "내 모델 (nizima/Booth)"
                : character.gender === "female"
                  ? "여캐"
                  : character.gender === "mascot"
                    ? "기타"
                    : "남캐";
            if (group !== lastGroup) {
              body.appendChild(makeMenuTitle(group));
              lastGroup = group;
            }
            const selected = character.model === selectedModel;
            const selectLabel = selected
              ? `✓ ${character.name}`
              : character.name;

            const selectCharacter = () => {
              localStorage.setItem(
                "selected-live2d-model",
                character.model
              );
              localStorage.setItem(
                "selected-live2d-name",
                character.name
              );
              closeContextMenu();
              window.location.reload();
            };

            if (character.source === "user") {
              const folder =
                character.folder ||
                character.model
                  .replace(/^\/?live2d\/user\//, "")
                  .split("/")[0] ||
                "";
              if (folder) {
                body.appendChild(
                  makeUserModelMenuRow(selectLabel, selectCharacter, () => {
                    void (async () => {
                      try {
                        const { removeUserLive2DModel } = await import(
                          "./user-live2d"
                        );
                        await removeUserLive2DModel(folder);
                        if (
                          localStorage.getItem("selected-live2d-model") ===
                          character.model
                        ) {
                          localStorage.removeItem("selected-live2d-model");
                          localStorage.removeItem("selected-live2d-name");
                        }
                        await renderCharacterView(
                          menu,
                          anchorX,
                          anchorY,
                          token
                        );
                      } catch (error) {
                        flashStatus(
                          error instanceof Error
                            ? error.message
                            : String(error),
                          "error",
                          2800
                        );
                      }
                    })();
                  })
                );
              } else {
                body.appendChild(
                  makeMenuButton(selectLabel, selectCharacter)
                );
              }
            } else {
              body.appendChild(
                makeMenuButton(selectLabel, selectCharacter)
              );
            }
          }

          const applyImportedModel = async (
            importer: () => Promise<{ model: string; name: string }>
          ) => {
            try {
              const imported = await importer();
              localStorage.setItem(
                "selected-live2d-model",
                imported.model
              );
              localStorage.setItem(
                "selected-live2d-name",
                imported.name
              );
              window.location.reload();
            } catch (error) {
              flashStatus(
                error instanceof Error
                  ? error.message
                  : String(error),
                "error",
                2800
              );
            }
          };

          body.appendChild(
            makeMenuButton("＋ ZIP/RAR 업로드", () => {
              closeContextMenu();
              void (async () => {
                const { importUserLive2DZip } = await import("./user-live2d");
                await applyImportedModel(importUserLive2DZip);
              })();
            })
          );
          body.appendChild(
            makeMenuButton("＋ 모델 폴더 추가", () => {
              closeContextMenu();
              void (async () => {
                const { importUserLive2DModel } = await import(
                  "./user-live2d"
                );
                await applyImportedModel(importUserLive2DModel);
              })();
            })
          );
          const dedupeButton = makeMenuButton("중복 정리", () => undefined, { muted: true });
          dedupeButton.title = "내용이 같은 내 모델을 하나만 남기고 지웁니다. 한 번 더 누르면 실행합니다.";
          body.appendChild(dedupeButton);
          confirmOnSecondClick(dedupeButton, "한 번 더 누르면 중복 삭제", () => {
              void (async () => {
                try {
                  const { dedupeUserLive2DModels } = await import(
                    "./user-live2d"
                  );
                  const result = await dedupeUserLive2DModels();
                  flashStatus(
                    result.removed.length === 0
                      ? "중복된 모델이 없습니다."
                      : `중복 ${result.removed.length}개 삭제`,
                    "info",
                    1800
                  );
                  await renderCharacterView(menu, anchorX, anchorY, token);
                } catch (error) {
                  flashStatus(
                    error instanceof Error
                      ? error.message
                      : String(error),
                    "error",
                    2800
                  );
                }
              })();
          });
        }
      );
    } catch (error) {
      if (token !== menuViewToken) {
        return;
      }
      renderBackAndBody(
        menu,
        "캐릭터 변경",
        anchorX,
        anchorY,
        token,
        (body) => {
          body.appendChild(
            makeMenuNote(
              error instanceof Error
                ? error.message
                : "목록을 불러오지 못했습니다."
            )
          );
        }
      );
    }
  };

  const renderMotionView = async (
    menu: HTMLDivElement,
    anchorX: number,
    anchorY: number,
    parentToken: number
  ) => {
    void parentToken;
    const token = ++menuViewToken;
    menu.innerHTML = "";
    menu.appendChild(makeMenuNote("행동 목록 불러오는 중…"));
    placeContextMenu(menu, anchorX, anchorY);

    try {
      const characters = await loadCharacterCatalog();
      if (token !== menuViewToken) {
        return;
      }

      const selectedModel =
        localStorage.getItem("selected-live2d-model") ??
        "/live2d/models/Hiyori/Hiyori.model3.json";
      const normalizeModelPath = (path: string) =>
        path.trim().replace(/\\/g, "/").replace(/^\/+/, "/");

      const character =
        characters.find(
          (item) =>
            normalizeModelPath(item.model) ===
            normalizeModelPath(selectedModel)
        ) ??
        characters.find((item) => {
          if (!selectedModel.includes("/live2d/user/")) return false;
          const folder = selectedModel
            .replace(/^\/?live2d\/user\//, "")
            .split("/")[0];
          return item.folder === folder || item.model.includes(`/user/${folder}/`);
        }) ??
        characters.find((item) => item.id === "Hiyori") ??
        characters[0];

      const motions =
        character?.motions && Object.keys(character.motions).length > 0
          ? character.motions
          : { Idle: 1 };
      const motionChoices = buildMotionChoices(motions);

      renderBackAndBody(
        menu,
        character ? `${character.name} 행동` : "행동",
        anchorX,
        anchorY,
        token,
        (body) => {
          if (motionChoices.length === 0) {
            body.appendChild(makeMenuNote("등록된 행동이 없습니다."));
            return;
          }
          for (const motion of motionChoices) {
            body.appendChild(
              makeMenuButton(motion.label, () => {
                playCurrentMotion?.(motion.group, motion.index);
                closeContextMenu();
              })
            );
          }
        }
      );
    } catch (error) {
      if (token !== menuViewToken) {
        return;
      }
      renderBackAndBody(
        menu,
        "행동",
        anchorX,
        anchorY,
        token,
        (body) => {
          body.appendChild(
            makeMenuNote(
              error instanceof Error
                ? error.message
                : "목록을 불러오지 못했습니다."
            )
          );
        }
      );
    }
  };

  const renderSizeView = (
    menu: HTMLDivElement,
    anchorX: number,
    anchorY: number,
    parentToken: number
  ) => {
    const token = ++menuViewToken;
    void parentToken;

    const sizes = [
      { id: "tiny" as const, label: "아주 작게" },
      { id: "small" as const, label: "작게" },
      { id: "medium" as const, label: "보통" },
      { id: "large" as const, label: "크게" },
    ];

    renderBackAndBody(
      menu,
      "캐릭터 크기",
      anchorX,
      anchorY,
      token,
      (body) => {
        for (const size of sizes) {
          const selected = selectedSize === size.id;
          body.appendChild(
            makeMenuButton(
              selected ? `✓ ${size.label}` : size.label,
              () => {
                applyCharacterSize(size.id);
                closeContextMenu();
                flashStatus(`크기: ${size.label}`, "info", 900);
              }
            )
          );
        }
      }
    );
  };

  window.addEventListener("ai-character-close-context-menu", () => {
    closeContextMenu();
  });

  window.addEventListener("ai-character:user-live2d-changed", () => {
    if (!openCharacterMenu || !contextMenuOpen) {
      return;
    }
    const { menu, anchorX, anchorY } = openCharacterMenu;
    void renderCharacterView(menu, anchorX, anchorY, menuViewToken);
  });

  window.addEventListener(
    "contextmenu",
    async (event) => {
      const contextTarget = event.target;

      if (
        contextTarget instanceof Element &&
        contextTarget.closest(
          "#chat-panel, #ai-settings-panel, #usage-dashboard-panel, #chat-input, .message-text, #rightclick-test-menu, button, input, textarea, select, a"
        )
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      try {
        await setClickThroughCapture(true);
      } catch {
        // ignore
      }

      contextMenuOpen = true;
      menuCursorLock = true;
      void refreshClickThroughGeometry();

      const menu = getOrCreateContextMenu();
      renderContextMenuRoot(menu, event.clientX, event.clientY);
    },
    true
  );

  patchLive2DAssetFetchMime();
  try {
    extensions.add(Live2DPlugin);
  } catch {
    // 이미 등록된 경우
  }
  const app = new Application();

  await app.init({
    canvas,
    resizeTo: window,
    background: 0x000000,
    backgroundAlpha: 0,
    antialias: true,
    preference: "webgl",
    clearBeforeRender: true,
    premultipliedAlpha: true,
    autoDensity: true,
    resolution: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
  });
  app.renderer.background.alpha = 0;
  app.canvas.style.background = "transparent";
  // Uncapped, the character redrew at the monitor's refresh rate (60–144 Hz) and kept about
  // 10% of the CPU busy while idle. Breathing and motions look the same at 30 fps.
  // The Live2D model animates on the shared ticker (registerTicker below), so cap that too:
  // its physics and mesh updates cost more than drawing.
  const characterTickers = [app.ticker, Ticker.shared];
  for (const ticker of characterTickers) {
    ticker.maxFPS = CHARACTER_MAX_FPS;
  }
  // Nothing on screen to draw while the window is hidden or minimized.
  document.addEventListener("visibilitychange", () => {
    for (const ticker of characterTickers) {
      if (document.hidden) {
        ticker.stop();
      } else {
        ticker.start();
      }
    }
  });

  // WKWebView에서 createImageBitmap/워커 디코드가 실패해 텍스처가 검게 나오는 문제 방지
  if (loadTextures?.config) {
    loadTextures.config.preferCreateImageBitmap = false;
    loadTextures.config.preferWorkers = false;
  }

  await Assets.init({
    preferences: {
      preferCreateImageBitmap: false,
    },
  });

  Live2DModel.registerTicker(Ticker);

  let selectedModelPath =
    localStorage.getItem(
      "selected-live2d-model"
    ) ??
    "/live2d/models/Hiyori/Hiyori.model3.json";

  let forcedModelPath = await (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const forced = await invoke<string | null>("read_force_live2d_model");
      if (forced && forced.trim()) {
        localStorage.setItem("selected-live2d-model", forced.trim());
        await invoke("clear_force_live2d_model");
        return forced.trim();
      }
    } catch {
      // ignore
    }
    return null;
  })();

  const effectiveModelPath = forcedModelPath ?? selectedModelPath;

  let selectedModel: Record<string, unknown> | string;
  try {
    selectedModel = await resolveLive2DModelSource(effectiveModelPath);
  } catch (error) {
    console.error("선택 모델 해석 실패, 기본 모델로 복구:", error);
    localStorage.setItem(
      "selected-live2d-model",
      "/live2d/models/Hiyori/Hiyori.model3.json"
    );
    localStorage.setItem("selected-live2d-name", "히요리");
    flashStatus("모델을 불러오지 못해 히요리로 복구했습니다", "error", 2800);
    selectedModel = await resolveLive2DModelSource(
      "/live2d/models/Hiyori/Hiyori.model3.json"
    );
  }

  let model;
  try {
    model = await Live2DModel.from(selectedModel, {
      textureOptions: {
        preferCreateImageBitmap: false,
      },
    });
  } catch (error) {
    console.error("Live2DModel.from 실패:", error, effectiveModelPath);
    if (effectiveModelPath.includes("/live2d/user/")) {
      localStorage.setItem(
        "selected-live2d-model",
        "/live2d/models/Hiyori/Hiyori.model3.json"
      );
      localStorage.setItem("selected-live2d-name", "히요리");
      const fallback = await resolveLive2DModelSource(
        "/live2d/models/Hiyori/Hiyori.model3.json"
      );
      model = await Live2DModel.from(fallback, {
        textureOptions: {
          preferCreateImageBitmap: false,
        },
      });
      flashStatus("사용자 모델을 불러오지 못해 히요리로 복구했습니다", "error", 2800);
    } else {
      throw error;
    }
  }

  app.stage.addChild(model);
  model.eventMode = "none";

  const characterHitLayer =
    document.querySelector<HTMLElement>("#character-hit-layer") ??
    (() => {
      const layer = document.createElement("div");
      layer.id = "character-hit-layer";
      layer.setAttribute("aria-hidden", "true");
      canvas.insertAdjacentElement("afterend", layer);
      return layer;
    })();

  /*
   * 현재 Live2D 모델에 크기 적용
   */
  const modelBaseWidth =
    model.width;

  const modelBaseHeight =
    model.height;

  const presetScaleOnWorkArea = (preset: SizePreset) =>
    characterScaleForPreset(
      modelBaseWidth,
      modelBaseHeight,
      sizePresets[preset],
      layoutWorkArea.width,
      layoutWorkArea.height
    );

  const persistCharacterScale = () => {
    localStorage.setItem("character-scale", String(characterScale));
    localStorage.setItem(
      "character-visual-percent",
      String(visualSizePercent(characterScale, presetScaleOnWorkArea("large")))
    );
  };

  applyCharacterSize =
    (preset: SizePreset) => {
      characterScale = presetScaleOnWorkArea(preset);

      model.scale.set(characterScale);

      selectedSize = preset;

      localStorage.setItem(
        "selected-character-size",
        preset
      );
      persistCharacterScale();

      onCharacterScaleChanged?.();
    };

  /*
   * 우클릭 메뉴에서 선택한
   * 실제 Live2D 행동 실행
   */
  playCurrentMotion = (
    group: string,
    index?: number
  ) => {
    void model
      .motion(
        group,
        index,
        3
      )
      .catch((error) => {
        console.error(
          "모션 실행 실패:",
          error
        );
      });
  };

  /*
   * 캐릭터 기본 크기
   * 숫자를 작게 할수록 캐릭터가 작아짐.
   */
/*
   * 캐릭터 위치
   */
  let characterX =
    window.innerWidth * 0.5;

  let characterY =
    characterBaselineY();

  model.anchor.set(0.5, 1);
  await refreshLayoutWorkArea();
  const minStartupScale = presetScaleOnWorkArea("tiny");
  const largeStartupScale = presetScaleOnWorkArea("large");
  const maxStartupScale = maxCharacterScaleForMonitor(
    modelBaseWidth,
    modelBaseHeight,
    Math.max(120, layoutWorkArea.width * 0.82),
    Math.max(120, layoutWorkArea.height * 0.9)
  );
  const storedPercent = Number(localStorage.getItem("character-visual-percent"));
  if (Number.isFinite(storedPercent) && storedPercent >= 35 && storedPercent <= 160) {
    characterScale = scaleFromVisualPercent(
      storedPercent,
      largeStartupScale,
      minStartupScale,
      maxStartupScale
    );
    model.scale.set(characterScale);
  } else {
    applyCharacterSize(selectedSize === "tiny" ? "small" : selectedSize);
  }

  model.position.set(
    characterX,
    characterY
  );

  /*
   * 마우스 이벤트는 Live2D 메쉬가 아니라
   * HTML 히트 레이어에서 받는다.
   * (투명 WebView2는 캔버스 픽셀 alpha만 클릭됨)
   */
  characterHitLayer.style.cursor = "grab";

  let pointerDown = false;
  let moved = false;
  let characterDragActive = false;
  let dragGrabOffsetX = 0;
  let dragGrabOffsetY = 0;
  /** 캐릭터를 누르고 있는 동안 click-through 금지 */
  let holdCursorEvents = false;

  let characterDragToken = 0;

  const isChatOpen = () =>
    Boolean(chatPanel?.classList.contains("open"));

  const moveWindowWithCharacter = async () => {
    if (!characterDragActive) {
      return;
    }

    try {
      const win = getCurrentWindow();
      const cursor = await getScreenCursor();
      const next = windowPositionForGrab(
        cursor.x,
        cursor.y,
        dragGrabOffsetX,
        dragGrabOffsetY
      );

      await win.setPosition(
        new PhysicalPosition(Math.round(next.x), Math.round(next.y))
      );
    } catch (error) {
      console.error("캐릭터 드래그 실패:", error);
    }
  };

  characterHitLayer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    if (eventHitsInteractiveUi(event)) {
      return;
    }
    pointerDown = true;
    moved = false;
    characterDragActive = false;
    holdCursorEvents = true;

    characterHitLayer.style.cursor = "grabbing";
    characterHitLayer.classList.add("is-dragging");
    try {
      characterHitLayer.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    // 드래그 중 마우스가 캐릭터 밖으로 나가도 이벤트를 잃지 않게 함
    void setClickThroughCapture(true).catch(() => undefined);

    const dragToken = ++characterDragToken;
    void (async () => {
      try {
        const startCursor = await getScreenCursor();
        if (dragToken !== characterDragToken || !pointerDown) {
          return;
        }
        const originX = startCursor.x;
        const originY = startCursor.y;
        const threshold = 6 * (window.devicePixelRatio || 1);

        const poll = async () => {
          if (dragToken !== characterDragToken || !pointerDown) {
            return;
          }
          try {
            const cursor = await getScreenCursor();
            if (dragToken !== characterDragToken || !pointerDown) {
              return;
            }
            const distance = Math.hypot(cursor.x - originX, cursor.y - originY);
            if (distance >= threshold) {
              moved = true;
              if (!characterDragActive) {
                const pos = await getCurrentWindow().outerPosition();
                if (dragToken !== characterDragToken || !pointerDown) {
                  return;
                }
                dragGrabOffsetX = cursor.x - pos.x;
                dragGrabOffsetY = cursor.y - pos.y;
                characterDragActive = true;
              }
              await moveWindowWithCharacter();
            }
          } catch {
            // ignore
          }
          if (dragToken === characterDragToken && pointerDown) {
            window.setTimeout(() => {
              void poll();
            }, CHARACTER_DRAG_POLL_MS);
          }
        };
        void poll();
      } catch {
        // ignore
      }
    })();
  });

  const stopDragging = () => {
    characterDragToken += 1;
    const wasMoving = moved || characterDragActive;
    pointerDown = false;
    characterDragActive = false;
    holdCursorEvents = false;
    characterHitLayer.style.cursor = "grab";
    characterHitLayer.classList.remove("is-dragging");
    pushNativeClickThrough(true);
    if (wasMoving) {
      void saveWindowPosition();
    }
  };

  let singleTapTimer = 0;
  let lastCharacterTapAt = 0;

  characterHitLayer.addEventListener("pointerup", (event) => {
    const shouldTap =
      pointerDown &&
      !moved &&
      event.button === 0 &&
      !menuOpenOnPointerDown;
    stopDragging();
    if (!shouldTap || eventHitsInteractiveUi(event)) {
      return;
    }
    const now = performance.now();
    if (now - lastCharacterTapAt < 320) {
      lastCharacterTapAt = 0;
      if (singleTapTimer) {
        window.clearTimeout(singleTapTimer);
        singleTapTimer = 0;
      }
      hideCharacterWindow();
      return;
    }
    lastCharacterTapAt = now;
    if (singleTapTimer) {
      window.clearTimeout(singleTapTimer);
    }
    singleTapTimer = window.setTimeout(() => {
      singleTapTimer = 0;
      lastCharacterTapAt = 0;
      setChatOpen(!isChatOpen());
      void model.motion("TapBody", undefined, 3).catch((error) => {
        console.warn("TapBody motion:", error);
      });
    }, 280);
  });
  characterHitLayer.addEventListener("pointercancel", stopDragging);
  window.addEventListener("pointerup", stopDragging);
  window.addEventListener("blur", stopDragging);

  const tauriWindow = getCurrentWindow();
  let windowModeSyncing = false;
  let lastWindowMode: "character" | "chat" | null = null;
  let syncChatModelPosition: () => void = () => {};

  const persistChatPanelSize = () => {
    localStorage.setItem(CHAT_WIDTH_KEY, String(chatPanelWidth));
    localStorage.setItem(CHAT_HEIGHT_KEY, String(chatPanelHeight));
  };

  let chatWindowSizeInFlight = false;
  let pendingChatWindowSize: { width: number; height: number } | null = null;
  let lastChatWindowLogical = { width: 0, height: 0 };

  const applyNativeChatWindowSize = async (
    width: number,
    height: number
  ) => {
    const next = {
      width: Math.round(width),
      height: Math.round(height),
    };
    const currentW = window.innerWidth;
    const currentH = window.innerHeight;
    if (
      !shouldApplyChatWindowSize(
        next,
        { width: currentW, height: currentH },
        lastChatWindowLogical
      )
    ) {
      lastChatWindowLogical = next;
      return;
    }
    if (characterDragActive || pointerDown) {
      pendingChatWindowSize = next;
      return;
    }
    if (chatWindowSizeInFlight) {
      pendingChatWindowSize = next;
      return;
    }

    chatWindowSizeInFlight = true;
    lastChatWindowLogical = next;
    try {
      const [oldPos, scale] = await Promise.all([
        tauriWindow.outerPosition(),
        tauriWindow.scaleFactor(),
      ]);
      await tauriWindow.setSize(new LogicalSize(next.width, next.height));
      const dy = (currentH - next.height) * scale;
      if (Math.abs(dy) >= 1) {
        await tauriWindow.setPosition(
          new PhysicalPosition(oldPos.x, Math.round(oldPos.y + dy))
        );
      }
      model.y = characterBaselineY();
    } catch (error) {
      lastChatWindowLogical = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      console.warn("채팅 창 크기 적용 실패:", error);
    } finally {
      chatWindowSizeInFlight = false;
      if (pendingChatWindowSize) {
        const queued = pendingChatWindowSize;
        pendingChatWindowSize = null;
        await applyNativeChatWindowSize(queued.width, queued.height);
      }
    }
  };

  const readVisibleModelBox = (): {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null => {
    const display = characterDisplaySize(
      modelBaseWidth,
      modelBaseHeight,
      characterScale
    );
    try {
      const raw = model.getBounds() as {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        rectangle?: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
      };
      const picked = pickVisualModelBox(display.width, raw);
      if (!picked) {
        return null;
      }
      const nested = raw.rectangle;
      const y =
        nested && Math.abs(nested.width - picked.width) < 1
          ? nested.y
          : Number.isFinite(raw.y)
            ? (raw.y as number)
            : 0;
      const height =
        nested && Math.abs(nested.width - picked.width) < 1
          ? nested.height
          : Number.isFinite(raw.height)
            ? (raw.height as number)
            : display.height;
      return {
        x: picked.x,
        y,
        width: picked.width,
        height: Number.isFinite(height) && height > 8 ? height : display.height,
      };
    } catch {
      // Live2D bounds are unavailable until the first draw
    }
    return null;
  };

  const readChatGap = (): number => {
    const chatGapCss = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--ai-character-chat-gap"
      )
    );
    return Number.isFinite(chatGapCss) && chatGapCss >= 0 ? chatGapCss : 8;
  };

  const applyCharacterChatLane = () => {
    const display = characterDisplaySize(
      modelBaseWidth,
      modelBaseHeight,
      characterScale
    );
    const chatGap = readChatGap();
    if (!characterDragActive && !pointerDown) {
      model.x = characterCenterXForChat(display.width, 10);
      model.y = characterBaselineY();
    }
    const occupancy = occupancyFromModelBounds(
      display.width,
      model.x,
      readVisibleModelBox(),
      10,
      1.28,
      window.devicePixelRatio || 1
    );
    const occupancyWidth = occupancy.occupancyWidth + 8;
    const chatLeft = chatLeftForCharacterLayout(
      occupancy.centerX,
      occupancyWidth,
      chatGap,
      Number.POSITIVE_INFINITY,
      MIN_CHAT_WIDTH
    );
    const paneWidth = Math.max(
      characterPaneWidthForChat(occupancyWidth, 10, chatGap),
      chatLeft
    );
    document.documentElement.style.setProperty(
      "--ai-character-chat-left",
      `${chatLeft}px`
    );
    document.documentElement.style.setProperty(
      "--ai-character-character-pane-width",
      `${Math.max(64, paneWidth)}px`
    );
    if (chatPanel) {
      chatPanel.style.setProperty("left", `${chatLeft}px`, "important");
      chatPanel.style.setProperty("top", "auto", "important");
      chatPanel.style.setProperty("bottom", `${hudStripPx()}px`, "important");
    }
    applyHudStripLayout();
    return { chatLeft, paneWidth, display, occupancy };
  };

  const fitChatModeWindow = async () => {
    await refreshLayoutWorkArea();
    const minChat = minChatWidthForWorkArea(layoutWorkArea.width);
    const maxChat = Math.min(
      MAX_CHAT_WIDTH,
      Math.max(minChat, Math.floor(layoutWorkArea.width - 220))
    );
    if (chatPanelWidth > maxChat) {
      chatPanelWidth = maxChat;
      persistChatPanelSize();
    }
    const layout = applyCharacterChatLane();
    const hudLift = hudStripPx();
    const needed = chatAppWindowSize(
      layout.chatLeft,
      chatPanelWidth,
      chatPanelHeight,
      layout.display.height + hudLift,
      hudLift,
      minChat
    );
    try {
      const [monitor, scale] = await Promise.all([
        currentMonitor(),
        tauriWindow.scaleFactor(),
      ]);
      const min = minChatAppWindowSize(
        layout.chatLeft,
        layout.display.height + hudLift,
        hudLift,
        minChat
      );
      await tauriWindow.setMinSize(new LogicalSize(min.width, min.height));
      let width = needed.width;
      let height = needed.height;
      if (monitor) {
        width = Math.min(width, Math.floor(monitor.size.width / scale));
        height = Math.min(height, Math.floor(monitor.size.height / scale));
      }
      await applyNativeChatWindowSize(width, height);
      applyCharacterChatLane();
    } catch (error) {
      console.warn("채팅 창 크기 맞추기 실패:", error);
    }
  };

  const saveWindowPosition = async () => {
    try {
      const pos = await tauriWindow.outerPosition();
      localStorage.setItem(
        WINDOW_POSITION_KEY,
        JSON.stringify({
          x: Math.round(pos.x),
          y: Math.round(pos.y),
        })
      );
    } catch (error) {
      console.warn("창 위치 저장 실패:", error);
    }
  };

  const captureCharacterScreenPos = async () => {
    const [outer, scale] = await Promise.all([
      tauriWindow.outerPosition(),
      tauriWindow.scaleFactor(),
    ]);
    return {
      x: outer.x + model.x * scale,
      y: outer.y + model.y * scale,
      scale,
    };
  };

  const waitNextFrame = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

  const fitCharacterModeWindow = async () => {
    const monitor = await currentMonitor();
    const scaleFactor = await tauriWindow.scaleFactor();
    layoutWorkArea = logicalWorkArea(monitor, scaleFactor, layoutWorkArea);
    const maxWidth = layoutWorkArea.width * 0.82;
    const maxHeight = layoutWorkArea.height * 0.9;

    // 창보다 캐릭터가 크면 스케일을 줄여 항상 보이게 한다
    const maxScale = maxCharacterScaleForMonitor(
      modelBaseWidth,
      modelBaseHeight,
      Math.max(120, maxWidth - CHARACTER_WINDOW_PADDING * 2),
      Math.max(120, maxHeight - CHARACTER_WINDOW_PADDING * 2 - (
        performanceHudVisible ? CHARACTER_WINDOW_HUD_EXTRA : 8
      ))
    );
    if (characterScale > maxScale) {
      characterScale = maxScale;
      model.scale.set(characterScale);
    }

    const fitted = characterDisplaySize(
      modelBaseWidth,
      modelBaseHeight,
      characterScale
    );
    const size = compactWindowSizeForCharacter(
      fitted.width,
      fitted.height,
      {
        padding: CHARACTER_WINDOW_PADDING,
        hudExtra: performanceHudVisible
          ? CHARACTER_WINDOW_HUD_EXTRA
          : 8,
        maxWidth,
        maxHeight,
      }
    );

    pendingChatWindowSize = null;
    lastChatWindowLogical = { width: 0, height: 0 };
    await tauriWindow.setSize(
      new LogicalSize(size.width, size.height)
    );
    await waitNextFrame();
    await waitNextFrame();
    model.x = window.innerWidth * 0.5;
    model.y = characterBaselineY();
  };

  let pendingWindowModeSync: boolean | null = null;

  const syncWindowMode = async (force = false) => {
    if (windowModeSyncing) {
      pendingWindowModeSync = true;
      return;
    }

    const mode = isChatOpen() ? "chat" : "character";
    if (!force && mode === lastWindowMode) {
      return;
    }

    windowModeSyncing = true;
    try {
      const screenPos = await captureCharacterScreenPos();

      if (mode === "character") {
        await tauriWindow.setMinSize(new LogicalSize(220, 160));
        await fitCharacterModeWindow();
      } else {
        await fitChatModeWindow();
        await waitNextFrame();
        await waitNextFrame();
        syncChatModelPosition();
        applyChatPanelSize();
      }

      let next = windowPositionKeepingCharacter(
        screenPos.x,
        screenPos.y,
        model.x,
        model.y,
        screenPos.scale
      );
      const [monitor, outerSize] = await Promise.all([
        currentMonitor(),
        tauriWindow.outerSize(),
      ]);
      if (monitor) {
        next = clampWindowPositionToMonitor(
          next.x,
          next.y,
          outerSize.width,
          outerSize.height,
          {
            x: monitor.position.x,
            y: monitor.position.y,
            width: monitor.size.width,
            height: monitor.size.height,
          }
        );
      }
      await tauriWindow.setPosition(
        new PhysicalPosition(next.x, next.y)
      );
      lastWindowMode = mode;
      await saveWindowPosition();
    } catch (error) {
      console.warn("창 모드 동기화 실패:", error);
    } finally {
      windowModeSyncing = false;
      if (pendingWindowModeSync) {
        pendingWindowModeSync = null;
        await syncWindowMode(true);
      }
    }
  };

  const restoreWindowPosition = async () => {
    const stored = readStoredWindowPosition(
      localStorage.getItem(WINDOW_POSITION_KEY)
    );
    if (!stored) {
      return;
    }
    try {
      const [monitors, current, outerSize] = await Promise.all([
        availableMonitors().catch(() => []),
        currentMonitor(),
        tauriWindow.outerSize(),
      ]);
      // At start the window is on the primary monitor; clamp to the monitor the saved spot is
      // on instead, so a character left on a second screen goes back there. That monitor gone
      // (unplugged): the current one.
      const monitor =
        monitors.find(
          (item) =>
            stored.x >= item.position.x &&
            stored.x < item.position.x + item.size.width &&
            stored.y >= item.position.y &&
            stored.y < item.position.y + item.size.height
        ) ?? current;
      let next = stored;
      if (monitor) {
        next = clampWindowPositionToMonitor(
          stored.x,
          stored.y,
          outerSize.width,
          outerSize.height,
          {
            x: monitor.position.x,
            y: monitor.position.y,
            width: monitor.size.width,
            height: monitor.size.height,
          }
        );
      }
      await tauriWindow.setPosition(
        new PhysicalPosition(next.x, next.y)
      );
    } catch (error) {
      console.warn("창 위치 복원 실패:", error);
    }
  };

  void tauriWindow.onMoved(() => {
    if (pointerDown || windowModeSyncing) {
      return;
    }
    void saveWindowPosition();
  });

  /*
   * 왼쪽 클릭: 채팅 열기/닫기
   * 오른쪽 클릭: 캐릭터 메뉴
   */
  window.addEventListener(
    "pointerdown",
    (event) => {
      menuOpenOnPointerDown = contextMenuOpen;
      if (!contextMenuOpen) {
        return;
      }
      const menu = document.querySelector("#rightclick-test-menu");
      const target = event.target;
      if (
        menu &&
        target instanceof Node &&
        menu.contains(target)
      ) {
        return;
      }
      closeContextMenu();
    },
    true
  );

  /*
   * Idle 모션 시작
   */
  try {
    model.motion("Idle", undefined, 1);
  } catch (error) {
    console.warn(
      "Idle motion:",
      error
    );
  }

  const characterActivity =
    canvas
      ? createCharacterActivityController({
          canvas,
          playMotion: (group, priority) => {
            void model
              .motion(group, undefined, priority)
              .catch(() => {
                if (group !== "Idle") {
                  void model.motion("Idle", undefined, 1).catch(() => {});
                }
              });
          },
          onChange: (activity) => {
            const hud = document.querySelector<HTMLElement>("#performance-hud");
            if (!hud) {
              return;
            }
            hud.dataset.activity = activity;
            hud.textContent = patchPerformanceHudActivity(
              hud.textContent ?? "",
              CHARACTER_ACTIVITY_LABELS[activity]
            );
          },
        })
      : null;

  app.ticker.add(() => {
    if (!characterActivity) {
      return;
    }
    if (characterActivity.getActivity() === "working") {
      model.rotation = workSway(
        characterActivity.workingElapsedMs()
      ).rotation;
      return;
    }
    if (Math.abs(model.rotation) > 0.001) {
      model.rotation *= 0.82;
      return;
    }
    model.rotation = 0;
  });

  // While an answer is read aloud the mouth moves. Set just before the model applies its
  // parameters, so motions playing at the same time don't overwrite it.
  let speakingSince = 0;
  window.addEventListener(SPEAKING_EVENT, (event: Event) => {
    speakingSince = (event as CustomEvent<boolean>).detail ? performance.now() : 0;
  });
  const lipModel = (model as unknown as {
    internalModel?: {
      on?(event: string, listener: () => void): void;
      coreModel?: { setParameterValueById?(id: string, value: number): void };
      motionManager?: { lipSyncIds?: string[] };
    };
  }).internalModel;
  lipModel?.on?.("beforeModelUpdate", () => {
    if (!speakingSince) return;
    const t = (performance.now() - speakingSince) / 1000;
    const open = Math.max(0, Math.min(1, 0.15 + 0.7 * Math.abs(Math.sin(t * 9)) * (0.6 + 0.4 * Math.sin(t * 2.3))));
    const ids = lipModel.motionManager?.lipSyncIds?.length ? lipModel.motionManager.lipSyncIds : ["ParamMouthOpenY"];
    for (const id of ids) lipModel.coreModel?.setParameterValueById?.(id, open);
  });

  /*
   * 마우스 휠로 캐릭터 크기 조절
   */
  characterHitLayer.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();

      const largeScale = presetScaleOnWorkArea("large");
      const minScale = presetScaleOnWorkArea("tiny");
      const maxScale = isChatOpen()
        ? maxCharacterScaleBesideChat(
            modelBaseWidth,
            modelBaseHeight,
            layoutWorkArea.width,
            layoutWorkArea.height,
            chatPanelWidth
          )
        : maxCharacterScaleForMonitor(
            modelBaseWidth,
            modelBaseHeight,
            Math.max(240, layoutWorkArea.width * 0.82),
            Math.max(240, layoutWorkArea.height * 0.9)
          );
      characterScale = stepCharacterScale(
        characterScale,
        event.deltaY < 0 ? "up" : "down",
        largeScale,
        Math.max(maxScale, largeScale),
        minScale
      );

      model.scale.set(characterScale);
      persistCharacterScale();

      onCharacterScaleChanged?.();

      if (status) {
        flashStatus(
          `크기 ${visualSizePercent(characterScale, largeScale)}%`,
          "info",
          700
        );
      }
    },
    {
      passive: false,
    }
  );

  /*
   * 채팅
   */
  const composer: Composer | null =
    chatForm && chatInput
      ? setupComposer(chatForm, chatInput, {
          onStop: () => {
            // Stopping halfway through a file change can leave some files changed and others not.
            if (
              runningRequest?.project &&
              !window.confirm("지금 파일을 고치는 중입니다. 멈추면 일부 파일만 바뀐 채로 남을 수 있습니다.\n그래도 멈출까요?")
            ) {
              return;
            }
            window.dispatchEvent(new Event("ai-character:stop-active-work"));
          },
          onAdd: (text) => restartWithAddition(text),
          onNotice: (text) => flashStatus(text, "error", 3600),
        })
      : null;

  if (chatForm && chatInput) {
    setupVoiceButtons(chatForm, chatInput, (text) => flashStatus(text, "error", 4200));
  }

  // F1: every chat shortcut, shown in the chat (not saved to the conversation).
  document.addEventListener("keydown", (event) => {
    if (event.key !== "F1") return;
    event.preventDefault();
    addMessage(SHORTCUT_HELP, "assistant");
    scrollFollower?.follow(true);
  });

  const scrollFollower: ScrollFollower | null =
    messages && chatForm ? setupScrollFollow(messages, chatForm) : null;

  const copyText = async (text: string): Promise<void> => {
    try {
      await writeText(text);
    } catch (error) {
      console.error("클립보드 복사 실패:", error);
      throw error;
    }
  };

  const markdownHandlers = {
    openLink: (href: string) => {
      void openUrl(href).catch((error) => console.warn("링크 열기 실패:", error));
    },
    copy: copyText,
  };

  const messageTime = (createdAt: number): string =>
    new Date(createdAt).toLocaleString([], {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  let retryLastRequest: (() => void) | null = null;

  function messageAction(label: string, title: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-copy";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(button);
    });
    return button;
  }

  function addMessage(
    text: string,
    type: "user" | "assistant",
    createdAt: number = Date.now(),
    source?: string,
    failed = false
  ) {
    if (!messages) return;
    messages.querySelector(".chat-welcome")?.remove();

    const bubble = document.createElement("div");
    bubble.className = `message ${type}`;
    bubble.title = messageTime(createdAt);

    const content = document.createElement("div");
    content.className = type === "assistant" ? "message-text message-md" : "message-text";
    if (type === "assistant") {
      content.append(renderMarkdown(text, markdownHandlers));
    } else {
      content.textContent = text;
    }

    const actions = document.createElement("div");
    actions.className = "message-actions";
    actions.append(
      messageAction("복사", "메시지 전체 복사", (button) => {
        void copyText(text).then(
          () => {
            button.textContent = "복사됨";
            window.setTimeout(() => {
              button.textContent = "복사";
            }, 900);
          },
          () => {
            button.textContent = "복사 실패";
            window.setTimeout(() => {
              button.textContent = "복사";
            }, 1600);
          }
        );
      })
    );
    if (type === "user") {
      actions.append(
        messageAction("수정", "이 질문을 입력창으로 가져와 고쳐 보냅니다", () => {
          composer?.fill(text);
        })
      );
    }

    const isError = failed || (type === "assistant" && (text.includes("기술 로그") || text.startsWith("연결 오류:")));
    if (isError) {
      bubble.classList.add("is-error");
      const retry = retryLastRequest;
      if (retry) {
        actions.append(
          messageAction("다시 시도", "같은 질문을 다시 보냅니다", () => {
            // While another request runs, submitting means "stop" — never let an old retry do that.
            if (composer?.isBusy()) {
              flashStatus("지금 작업이 끝난 뒤에 다시 시도해 주세요", "error", 2400);
              return;
            }
            retry();
          })
        );
      }
      actions.append(
        messageAction("기술 로그 열기", "기술 로그를 새 창에서 봅니다", () => {
          void openWorkLogWindow();
        })
      );
    }

    if (source && type === "assistant") {
      // Which AI answered and what it cost, so a paid answer is never a surprise.
      const sourceLine = document.createElement("div");
      sourceLine.className = "message-source";
      sourceLine.textContent = source;
      bubble.append(content, sourceLine, actions);
    } else {
      bubble.append(content, actions);
    }
    messages.appendChild(bubble);
    // A saved conversation scrolls once after it is drawn, not once per message.
    if (!isRenderingHistory()) {
      scrollFollower?.follow(type === "user");
    }
  }

  // A CRADLE run's answer arrives twice (session event and awaited result); post it once per
  // request. Reset on every new request, so asking the same thing again still gets its answer.
  let lastAssistantReply = "";
  // The conversation the running request was sent from; its answer belongs there even if the
  // user has switched to another conversation meanwhile.
  let requestConversationId: string | null = null;
  // What is running now, to decide whether a note added mid-way can restart it.
  let runningRequest: { prompt: string; answering: boolean; project: boolean } | null = null;

  function postAssistantReply(text: string, source?: string): void {
    const clean = text.trim();
    if (!clean || clean === lastAssistantReply) {
      return;
    }
    lastAssistantReply = clean;
    const target = requestConversationId ?? chatHistory?.getActiveId();
    const shown = target && chatHistory ? chatHistory.appendTo(target, "assistant", clean, source) : true;
    if (shown === null) {
      flashStatus("답을 받았지만 그 대화가 삭제되어 저장하지 못했습니다", "error", 4200);
      return;
    }
    if (shown) {
      addMessage(clean, "assistant", Date.now(), source);
      speakAnswer(clean);
    }
  }

  /** Whether the running request's conversation is the one on screen. */
  function requestConversationShown(): boolean {
    return !requestConversationId || requestConversationId === chatHistory?.getActiveId();
  }

  if (messages) {
    chatHistory =
      setupChatHistory({
        messages,
        addMessage,
        showWelcome: () => {
          renderWelcome(messages, (suggestion) => composer?.fill(suggestion));
        },
      });
  }

  let historyWarnedAt = 0;
  window.addEventListener(HISTORY_SAVE_FAILED_EVENT, () => {
    if (Date.now() - historyWarnedAt < 60_000) return;
    historyWarnedAt = Date.now();
    flashStatus("대화 기록 저장 공간이 가득 찼습니다. 오래된 대화를 Markdown으로 저장한 뒤 지워 주세요", "error", 6000);
  });

  window.addEventListener("ai-character:cradle-session", (event: Event) => {
    const session = (event as CustomEvent<{
      status?: string;
      finalAnswer?: string | null;
    }>).detail;
    const activity = activityFromCradleStatus(session?.status);
    if (activity) {
      characterActivity?.setActivity(activity);
    }
    // A chat request posts its own answer (with who answered and the cost) when it returns.
    if (session?.status === "completed" && session.finalAnswer && !runningRequest) {
      postAssistantReply(session.finalAnswer);
    }
  });

  window.addEventListener("ai-character:agent-task-start", () => {
    if (characterActivity?.getActivity() !== "working") {
      characterActivity?.setActivity("working");
    }
  });

  /*
   * 투명 영역 클릭 통과
   *
   * 캐릭터 / 채팅 / 메뉴:
   *   이 창이 마우스를 받음
   *
   * 나머지 투명 영역:
   *   뒤쪽 앱으로 클릭 통과
   */
  const clickThroughWindow =
    getCurrentWindow();

  let clickThroughWindowPosition =
    await clickThroughWindow
      .innerPosition();

  let clickThroughScaleFactor =
    await clickThroughWindow
      .scaleFactor();

  let lastClickThroughPayload = "";
  let clickThroughPushTimer = 0;
  let pushNativeClickThrough = (_immediate = false): void => {};

  (
    window as unknown as {
      __aiCharacterRefreshClickThrough?: (
        pos: PhysicalPosition,
        factor: number
      ) => void;
    }
  ).__aiCharacterRefreshClickThrough = (pos, factor) => {
    clickThroughWindowPosition = pos;
    clickThroughScaleFactor = factor;
    pushNativeClickThrough(true);
  };

  await clickThroughWindow.onMoved(
    ({ payload }) => {
      clickThroughWindowPosition =
        payload;
      pushNativeClickThrough(false);
    }
  );

  await clickThroughWindow
    .onScaleChanged(
      ({ payload }) => {
        clickThroughScaleFactor =
          payload.scaleFactor;
        pushNativeClickThrough(false);
      }
    );

  const getCharacterHitBox = () => {
    const display = characterDisplaySize(
      modelBaseWidth,
      modelBaseHeight,
      characterScale
    );
    return characterHitLayerBox(
      model.x,
      model.y,
      characterBodyWidth(display.width),
      display.height,
      {
        padding: 4,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
      }
    );
  };

  const syncCharacterHitArea = (): void => {
    if (chatPanelResizing) {
      return;
    }
    const box = getCharacterHitBox();
    characterHitLayer.style.left = `${box.x}px`;
    characterHitLayer.style.top = `${box.y}px`;
    characterHitLayer.style.width = `${box.width}px`;
    characterHitLayer.style.height = `${box.height}px`;
    characterHitLayer.style.right = "auto";
    characterHitLayer.style.bottom = "auto";
  };
  const collectClickThroughRegions = () => {
    const regions = [
      toScreenRegion(
        clickThroughWindowPosition.x,
        clickThroughWindowPosition.y,
        clickThroughScaleFactor,
        getCharacterHitBox()
      ),
    ];
    const overlaySelectors = [
      "#chat-panel.open",
      "#ai-settings-panel",
      "#usage-dashboard-panel",
      "#automation-panel",
      "#work-log-overlay",
      "#rightclick-test-menu",
      "#chat-history-drawer",
    ];
    for (const selector of overlaySelectors) {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el || el.hidden) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        continue;
      }
      regions.push(
        toScreenRegion(
          clickThroughWindowPosition.x,
          clickThroughWindowPosition.y,
          clickThroughScaleFactor,
          {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          }
        )
      );
    }
    return regions;
  };

  pushNativeClickThrough = (immediate = false): void => {
    const run = () => {
      const capture =
        holdCursorEvents ||
        chatPanelResizing ||
        contextMenuOpen ||
        menuCursorLock ||
        characterDragActive;
      const regions = capture ? [] : collectClickThroughRegions();
      const payload = JSON.stringify({ regions, capture });
      if (payload === lastClickThroughPayload) {
        return;
      }
      lastClickThroughPayload = payload;
      void setClickThroughRegions(regions, capture).catch(() => undefined);
    };
    if (immediate) {
      if (clickThroughPushTimer) {
        window.clearTimeout(clickThroughPushTimer);
        clickThroughPushTimer = 0;
      }
      run();
      return;
    }
    if (clickThroughPushTimer) {
      return;
    }
    clickThroughPushTimer = window.setTimeout(() => {
      clickThroughPushTimer = 0;
      run();
    }, 120);
  };

  syncCharacterHitArea();
  app.ticker.add(() => {
    syncCharacterHitArea();
    pushNativeClickThrough(false);
  });

  window.addEventListener("ai-character:settings-opened", () => {
    pushNativeClickThrough(true);
  });

  window.addEventListener("ai-character:usage-opened", () => {
    pushNativeClickThrough(true);
  });

  window.addEventListener("ai-character:settings-closed", () => {
    canvas.style.pointerEvents = "auto";
    pushNativeClickThrough(true);
  });

  pushNativeClickThrough(true);


  /*
   * 캐릭터와 채팅창을 겹치지 않게 배치
   *
   * 채팅이 열리면:
   * 캐릭터 발끝을 채팅창 위로 이동
   *
   * 채팅이 닫히면:
   * 원래 위치로 복원
   */
  const syncChatModelPositionImpl =
    () => {
      if (isChatOpen()) {
        if (chatPanelResizing || characterDragActive || pointerDown) {
          if (!characterDragActive && !pointerDown) {
            model.y = characterBaselineY();
          }
          syncCharacterHitArea();
          return;
        }
        applyCharacterChatLane();
        applyChatPanelSize();
      } else {
        model.x = window.innerWidth * 0.5;
        model.y = characterBaselineY();
        if (chatPanel) {
          chatPanel.style.removeProperty("left");
          chatPanel.style.removeProperty("bottom");
        }
        applyHudStripLayout();
      }
      syncCharacterHitArea();
      window.dispatchEvent(new Event("ai-character:layout-changed"));
  };

  syncChatModelPosition = syncChatModelPositionImpl;

  onCharacterScaleChanged = () => {
    if (isChatOpen()) {
      void (async () => {
        try {
          const [monitor, factor] = await Promise.all([
            currentMonitor(),
            tauriWindow.scaleFactor(),
          ]);
          const maxWindowWidth = monitor
            ? monitor.size.width / factor
            : 1400;
          const maxWindowHeight = monitor
            ? monitor.size.height / factor
            : 900;
          const maxScale = maxCharacterScaleBesideChat(
            modelBaseWidth,
            modelBaseHeight,
            maxWindowWidth,
            maxWindowHeight,
            chatPanelWidth
          );
          if (characterScale > maxScale) {
            characterScale = maxScale;
            model.scale.set(characterScale);
          }
          syncChatModelPosition();
          await fitChatModeWindow();
          syncChatModelPosition();
        } catch (error) {
          console.warn("채팅 모드 캐릭터 크기 맞춤 실패:", error);
          syncChatModelPosition();
        }
      })();
      return;
    }
    lastWindowMode = null;
    void (async () => {
      const screenPos = await captureCharacterScreenPos();
      await fitCharacterModeWindow();
      let next = windowPositionKeepingCharacter(
        screenPos.x,
        screenPos.y,
        model.x,
        model.y,
        screenPos.scale
      );
      const [monitor, outerSize] = await Promise.all([
        currentMonitor(),
        tauriWindow.outerSize(),
      ]);
      if (monitor) {
        next = clampWindowPositionToMonitor(
          next.x,
          next.y,
          outerSize.width,
          outerSize.height,
          {
            x: monitor.position.x,
            y: monitor.position.y,
            width: monitor.size.width,
            height: monitor.size.height,
          }
        );
      }
      await tauriWindow.setPosition(
        new PhysicalPosition(next.x, next.y)
      );
      lastWindowMode = "character";
      await saveWindowPosition();
    })();
  };

  if (chatPanel) {
    const chatObserver =
      new MutationObserver(() => {
        void (async () => {
          await syncWindowMode();
          await waitNextFrame();
          await waitNextFrame();
          syncChatModelPosition();
        })();
      });

    chatObserver.observe(
      chatPanel,
      {
        attributes: true,
        attributeFilter: [
          "class",
        ],
      }
    );

    window.addEventListener(
      "resize",
      () => {
        if (!windowModeSyncing && !chatPanelResizing) {
          syncChatModelPosition();
        }
      }
    );

    syncChatModelPosition();
    void (async () => {
      await syncWindowMode(true);
      await restoreWindowPosition();
      await saveWindowPosition();
    })();
  } else {
    void (async () => {
      await syncWindowMode(true);
      await restoreWindowPosition();
      await saveWindowPosition();
    })();
  }


  if (chatPanel) {
    const chatResizeHandles = [
      ...document.querySelectorAll<HTMLElement>(".chat-resize-handle"),
    ];

    for (const handle of chatResizeHandles) {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();

        const edge = handle.dataset.resize ?? "se";
        const startWidth = chatPanelWidth;
        const startHeight = chatPanelHeight;
        const resizeCapture = document.querySelector<HTMLElement>(
          "#chat-resize-capture"
        );
        let startScreenX = 0;
        let startScreenY = 0;
        let cursorScale = 1;
        let originReady = false;
        let resizingActive = true;
        let pollQueued = false;

        chatPanelResizing = true;
        holdCursorEvents = true;
        chatPanel.classList.add("is-resizing");
        resizeCapture?.classList.add("active");

        const applyFromScreen = (screenX: number, screenY: number) => {
          if (!originReady) {
            return;
          }
          const dx = (screenX - startScreenX) / cursorScale;
          const dy = (screenY - startScreenY) / cursorScale;
          const growsUp = edge === "n" || edge === "ne";
          const nextWidth =
            edge === "s" || edge === "n" ? startWidth : startWidth + dx;
          const nextHeight = growsUp
            ? startHeight - dy
            : edge === "e"
              ? startHeight
              : startHeight + dy;
          applyChatPanelSize(nextWidth, nextHeight, false);
          const display = characterDisplaySize(
            modelBaseWidth,
            modelBaseHeight,
            characterScale
          );
          const hudLift = hudStripPx();
          const needed = chatAppWindowSize(
            readChatLeft(),
            chatPanelWidth,
            chatPanelHeight,
            display.height + hudLift,
            hudLift,
            minChatWidthForWorkArea(layoutWorkArea.width)
          );
          void applyNativeChatWindowSize(needed.width, needed.height);
        };

        const pollCursor = async () => {
          if (!resizingActive || pollQueued) {
            return;
          }
          pollQueued = true;
          try {
            const cursor = await getScreenCursor();
            if (resizingActive && originReady) {
              applyFromScreen(cursor.x, cursor.y);
            }
          } catch {
            // ignore
          } finally {
            pollQueued = false;
            if (resizingActive) {
              window.setTimeout(() => {
                void pollCursor();
              }, CHAT_RESIZE_POLL_MS);
            }
          }
        };

        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          // ignore
        }

        void (async () => {
          try {
            void setClickThroughCapture(true);
            const [cursor, factor] = await Promise.all([
              getScreenCursor(),
              tauriWindow.scaleFactor(),
            ]);
            if (!resizingActive) {
              return;
            }
            cursorScale = factor;
            startScreenX = cursor.x;
            startScreenY = cursor.y;
            originReady = true;
            void pollCursor();
          } catch {
            originReady = false;
          }
        })();

        const onUp = () => {
          if (!resizingActive) {
            return;
          }
          resizingActive = false;
          try {
            handle.releasePointerCapture(event.pointerId);
          } catch {
            // ignore
          }
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onUp, true);
          persistChatPanelSize();
          holdCursorEvents = false;
          chatPanelResizing = false;
          chatPanel.classList.remove("is-resizing");
          resizeCapture?.classList.remove("active");
          pushNativeClickThrough(true);
          void fitChatModeWindow();
        };

        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onUp, true);
      });
    }
  }


  const renderAttachments =
    () => {
      if (!attachmentList) {
        return;
      }

      attachmentList.innerHTML = "";

      if (
        pendingAttachments.length === 0
      ) {
        attachmentList.classList.remove(
          "has-files"
        );

        return;
      }

      attachmentList.classList.add(
        "has-files"
      );

      for (
        const attachment
        of pendingAttachments
      ) {
        const item =
          document.createElement("div");

        item.className =
          "attachment-chip";

        const name =
          document.createElement("span");

        name.className =
          "attachment-name";

        name.textContent =
          attachment.name;

        name.title =
          attachment.path;

        const accessLabel =
          document.createElement("span");

        accessLabel.className =
          "attachment-access";

        const originalPath =
          attachment.originalPath ??
          attachment.path;

        const access =
          attachmentAccess.get(
            originalPath
          );

        if (
          access?.readable &&
          attachment.path !==
            originalPath
        ) {
          accessLabel.textContent =
            "✅ 임시보관 완료";

          name.title =
            [
              `원본: ${originalPath}`,
              `임시: ${attachment.path}`,
            ].join("\n");
        } else {
          accessLabel.textContent =
            access
              ? attachmentAccessLabel(
                  access
                )
              : "권한 확인 중...";
        }

        const remove =
          document.createElement("button");

        remove.type = "button";
        remove.className =
          "attachment-remove";

        remove.textContent = "×";

        remove.title =
          `${attachment.name} 제거`;

        remove.addEventListener(
          "click",
          async () => {
            const originalPath =
              attachment.originalPath ??
              attachment.path;

            pendingAttachments =
              pendingAttachments.filter(
                (item) =>
                  item.path !==
                  attachment.path
              );

            attachmentAccess.delete(
              originalPath
            );

            if (
              attachment.path !==
              originalPath
            ) {
              try {
                await removeStagedAttachment(
                  attachment.path
                );
              } catch (error) {
                console.warn(
                  "임시 첨부 삭제 실패:",
                  error
                );
              }
            }

            renderAttachments();
          }
        );

        item.append(
          name,
          accessLabel,
          remove
        );

        attachmentList.appendChild(
          item
        );
      }
    };


  const addAttachmentPaths =
    async (paths: string[]) => {
      const candidates =
        buildPendingAttachments(
          paths
        );

      for (
        const candidate
        of candidates
      ) {
        const originalPath =
          candidate.originalPath ??
          candidate.path;

        const alreadyAdded =
          pendingAttachments.some(
            (existing) =>
              (
                existing.originalPath ??
                existing.path
              ) === originalPath
          );

        if (alreadyAdded) {
          continue;
        }

        try {
          const access =
            await inspectAttachmentAccess(
              originalPath
            );

          attachmentAccess.set(
            originalPath,
            access
          );

          /*
           * 원본 위치와 무관하게
           * 즉시 AI Character 임시영역으로 복사.
           * 검사 결과가 읽기 불가로 나와도 staging이
           * 되면 그대로 사용한다.
           */
          try {
            const stagedPath =
              await stageAttachment(
                originalPath
              );

            pendingAttachments.push({
              ...candidate,
              originalPath,
              path: stagedPath,
            });
            attachmentAccess.set(
              originalPath,
              {
                ...access,
                readable: true,
              }
            );
          } catch (stageError) {
            if (access.readable) {
              throw stageError;
            }
            pendingAttachments.push(
              candidate
            );
          }
        } catch (error) {
          console.error(
            "첨부 staging 실패:",
            error
          );

          attachmentAccess.set(
            originalPath,
            {
              exists: true,
              isFile: true,
              readable: false,
              writable: false,
            }
          );

          pendingAttachments.push(
            candidate
          );
        }
      }

      renderAttachments();
    };


  // Ctrl+V of a screenshot: images become attachments; text pastes as usual.
  chatInput?.addEventListener("paste", (event) => {
    const images = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!images.length) return;
    event.preventDefault();
    void (async () => {
      for (const image of images) {
        try {
          await addAttachmentPaths([await savePastedImage(image)]);
        } catch (error) {
          flashStatus(`그림을 붙여넣지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error", 3200);
        }
      }
    })();
  });

  attachmentButton?.addEventListener(
    "click",
    async () => {
      try {
        const selected =
          await open({
            multiple: true,
            directory: false,
            title: "AI Character 파일 첨부",
            filters: [
              {
                name: "지원 파일",
                extensions: [
                  "txt",
                  "md",
                  "log",
                  "ts",
                  "tsx",
                  "js",
                  "jsx",
                  "rs",
                  "py",
                  "java",
                  "cs",
                  "cpp",
                  "cc",
                  "c",
                  "h",
                  "hpp",
                  "html",
                  "css",
                  "json",
                  "xml",
                  "yaml",
                  "yml",
                  "toml",
                  "sql",
                  "sh",
                  "ps1",
                  "csv",
                  "pdf",
                  "docx",
                  "xlsx",
                  "png",
                  "jpg",
                  "jpeg",
                  "webp",
                ],
              },
            ],
          });

        if (!selected) {
          return;
        }

        const paths =
          Array.isArray(selected)
            ? selected
            : [selected];

        await addAttachmentPaths(
          paths
        );
      } catch (error) {
        console.error(
          "파일 선택 실패:",
          error
        );
      }
    }
  );


  await getCurrentWindow()
    .onDragDropEvent(
      (event) => {
        const payload =
          event.payload;

        if (
          payload.type === "over"
        ) {
          chatPanel?.classList.add(
            "file-drag-over"
          );

          return;
        }

        if (
          payload.type === "drop"
        ) {
          chatPanel?.classList.remove(
            "file-drag-over"
          );

          void addAttachmentPaths(
            payload.paths
          );

          return;
        }

        chatPanel?.classList.remove(
          "file-drag-over"
        );
      }
    );


  let activeRequestId = 0;
  let stoppedRequestId = 0;
  let liveReply: LiveReply | null = null;
  // The next submit sends this prompt instead of the input text (input text is still shown).
  let promptOverride: string | null = null;
  let restarting = false;

  /** Sends `display` as the user's message with `prompt` as what the AI actually receives. */
  function sendWithPrompt(display: string, prompt: string): void {
    // The submit handler reads the input synchronously, so a draft being typed can go straight back.
    const draft = chatInput?.value ?? "";
    promptOverride = prompt;
    composer?.fill(display);
    chatForm?.requestSubmit();
    promptOverride = null;
    if (draft.trim()) {
      composer?.fill(draft);
    }
  }

  // Notes and questions typed while conversation X ran belong to X. If the user is looking at
  // another conversation when X finishes, they wait until X is on screen again.
  let waitingFor: string | null = null;

  /** After a request: notes added to it go out first, together, as its follow-up; then
   * separate questions, one at a time. */
  function sendWaitingOrDefer(conversationId: string | null): void {
    if (conversationId && conversationId !== chatHistory?.getActiveId()) {
      waitingFor = conversationId;
      flashStatus("다른 대화를 보고 있어서, 기다리던 질문은 원래 대화로 돌아가면 보냅니다", "info", 4200);
      return;
    }
    waitingFor = null;
    const additions = composer?.takeAdditions() ?? [];
    const next = additions.length ? undefined : composer?.takeQueued();
    if (additions.length) {
      window.setTimeout(() => sendWithPrompt(additions.join("\n"), additionsPrompt(additions)), 0);
    } else if (next) {
      window.setTimeout(() => sendWithPrompt(next, next), 0);
    }
  }

  window.addEventListener(CONVERSATION_SHOWN_EVENT, (event: Event) => {
    const id = (event as CustomEvent<{ id: string }>).detail?.id;
    if (runningRequest && requestConversationId) {
      // The running request's live answer and progress row show only in its own conversation.
      if (id === requestConversationId) {
        liveReply?.repaint();
        if (!runningRequest.answering) {
          window.dispatchEvent(new Event("ai-character:chat-progress-start"));
        }
      } else {
        window.dispatchEvent(new Event("ai-character:chat-progress-hide"));
      }
      return;
    }
    if (waitingFor && id === waitingFor && !composer?.isBusy()) {
      sendWaitingOrDefer(id);
    }
  });

  /**
   * A note typed while a task runs. Before any answer has appeared (and when no files are being
   * changed) the task restarts at once with the note folded in; otherwise it waits and follows up.
   */
  function restartWithAddition(text: string): boolean {
    const running = runningRequest;
    if (!running || running.answering || running.project) {
      return false;
    }
    restarting = true;
    window.dispatchEvent(new Event("ai-character:stop-active-work"));
    restarting = false;
    window.setTimeout(() => sendWithPrompt(text, mergedPrompt(running.prompt, [text])), 0);
    return true;
  }

  window.addEventListener("ai-character:stop-active-work", () => {
    if (!composer?.isBusy()) {
      return;
    }
    stoppedRequestId = activeRequestId;
    runningRequest = null;
    liveReply?.dispose();
    stopSpeaking();
    composer.setBusy(false);
    if (restarting) {
      // Restarting with an added note: not a user stop, so no stop message and keep the queue.
      return;
    }
    // Stopping means "not like this": waiting questions go back to the input, unsent.
    composer.returnQueuedToInput();
    characterActivity?.setActivity("idle");
    window.dispatchEvent(new Event("ai-character:chat-progress-hide"));
    addMessage("답변을 중지했습니다. 질문은 입력창에서 ↑ 키로 다시 불러올 수 있어요.", "assistant");
    chatInput?.focus();
  });

  chatForm?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      if (composer?.isBusy()) {
        return;
      }

      const text =
        chatInput?.value.trim();
      // Set only for the duration of a sendWithPrompt call, so read it before any await.
      const promptText = promptOverride ?? text ?? "";

      if (
        !text &&
        pendingAttachments.length === 0
      ) {
        return;
      }

      const blockedAttachments =
        pendingAttachments.filter(
          (attachment) =>
            attachmentAccess.get(
              attachment.originalPath ??
              attachment.path
            )?.readable === false
        );

      if (
        blockedAttachments.length > 0
      ) {
        pendingAttachments =
          pendingAttachments.filter(
            (attachment) =>
              attachmentAccess.get(
                attachment.originalPath ??
                attachment.path
              )?.readable !== false
          );

        if (
          !text &&
          pendingAttachments.length === 0
        ) {
          addMessage(
            [
              "파일 접근 권한이 없습니다:",
              ...blockedAttachments.map(
                (file) =>
                  `• ${file.name}`
              ),
              "",
              "+ 버튼으로 파일을 다시 선택해 주세요.",
            ].join("\n"),
            "assistant"
          );

          return;
        }
      }

      const previousConversationContext =
        chatHistory?.getContext() ?? "";

      const userDisplayText =
        text ||
        `첨부 파일 ${pendingAttachments.length}개 분석`;

      addMessage(
        userDisplayText,
        "user"
      );

      chatHistory?.append(
        "user",
        userDisplayText
      );
      requestConversationId = chatHistory?.getActiveId() ?? null;
      const thisConversationId = requestConversationId;
      lastAssistantReply = "";

      const requestPrompt =
        buildAttachmentPrompt(
          promptText,
          pendingAttachments
        );

      composer?.takeText();
      composer?.remember(text ?? "");
      composer?.setBusy(true);
      const requestId = ++activeRequestId;
      const isStopped = () => stoppedRequestId === requestId;
      const startedAt = Date.now();
      const thisRequest = {
        prompt: promptText,
        answering: false,
        project: classifyRequestIntent(promptText, previousConversationContext) === "project",
      };
      runningRequest = thisRequest;

      characterActivity?.setActivity("working");
      window.dispatchEvent(new Event("ai-character:chat-progress-start"));

      const live = messages
        ? startLiveReply(`chat-${requestId}-${startedAt}`, {
            messages,
            render: (target, partial) => target.append(renderMarkdown(partial, markdownHandlers)),
            onFirstText: () => {
              thisRequest.answering = true;
              window.dispatchEvent(new Event("ai-character:chat-progress-hide"));
            },
            onUpdate: () => scrollFollower?.follow(false),
            isVisible: requestConversationShown,
          })
        : null;
      liveReply = live;

      try {
        const answer =
          await askCradleCompat(
            requestPrompt,
            chatHistory?.getActiveId() ?? null,
            previousConversationContext,
            `chat-${requestId}-${startedAt}`
          );

        live?.dispose();
        if (isStopped()) {
          return;
        }

        const source = await lookupAnswerSource(startedAt - 1_000).catch(() => null);
        if (isStopped()) {
          return;
        }
        postAssistantReply(
          answer || "작업을 마쳤지만 채팅에 넣을 답이 비어 있습니다.",
          source ? formatAnswerSource(source) : undefined
        );
        window.dispatchEvent(new Event("ai-character:usage-refresh"));
        notifyIfAway(startedAt, "답변이 도착했습니다", answer || "작업을 마쳤습니다.");

        characterActivity?.setActivity("done");
        window.dispatchEvent(new Event("ai-character:chat-progress-hide"));

        const completedAttachments =
          [...pendingAttachments];

        pendingAttachments = [];
        attachmentAccess.clear();
        renderAttachments();

        for (
          const attachment
          of completedAttachments
        ) {
          const originalPath =
            attachment.originalPath ??
            attachment.path;

          if (
            attachment.path ===
            originalPath
          ) {
            continue;
          }

          try {
            await removeStagedAttachment(
              attachment.path
            );
          } catch (error) {
            console.warn(
              "분석 완료 후 임시파일 삭제 실패:",
              error
            );
          }
        }
      } catch (error) {
        if (isStopped()) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        const failedText = text ?? "";
        // Back into the input only if the user is still on the conversation it came from.
        if (requestConversationShown()) {
          composer?.restoreText(failedText);
        }
        retryLastRequest = () => {
          composer?.fill(failedText);
          chatForm?.requestSubmit();
        };
        // Only on screen if the user is still looking at the conversation the request came from.
        if (requestConversationShown()) {
          addMessage(
            friendlyChatError(message),
            "assistant",
            Date.now(),
            undefined,
            true
          );
        }
        window.dispatchEvent(new Event("ai-character:usage-refresh"));
        notifyIfAway(startedAt, "작업이 실패했습니다", message);
        retryLastRequest = null;
        characterActivity?.setActivity("error");
        window.setTimeout(() => {
          characterActivity?.setActivity("idle");
        }, 2400);
      } finally {
        live?.dispose();
        if (liveReply === live) {
          liveReply = null;
        }
        // A stopped request settles later, possibly while a newer one runs: leave that one alone.
        if (requestId === activeRequestId) {
          // A failed or finished request must not leave the progress row ticking under the chat.
          window.dispatchEvent(new Event("ai-character:chat-progress-hide"));
          requestConversationId = null;
          runningRequest = null;
        }
        if (!isStopped()) {
          composer?.setBusy(false);
          chatInput?.focus();
          sendWaitingOrDefer(thisConversationId);
        }
      }
    }
  );

  /*
   * 가벼운 성능 HUD
   *
   * 표시 중일 때만:
   * FPS 1초
   * CPU/RAM 3초
   * 위치 0.5초
   */
  const performanceHud =
    document.querySelector<HTMLDivElement>(
      "#performance-hud"
    );

  if (performanceHud) {
    let cpuPercent = 0;
    let memoryMb = 0;
    let statsBusy = false;

    let fpsTimer:
      number | null = null;

    let statsTimer:
      number | null = null;

    let positionTimer:
      number | null = null;


    const updatePerformanceHudPosition =
      () => {
        if (!performanceHudVisible) {
          return;
        }

        const canvasRect =
          canvas.getBoundingClientRect();

        let bounds = {
          x: 0,
          y: 0,
          width: app.screen.width,
          height: Math.max(1, app.screen.height - 16),
        };
        try {
          const display = characterDisplaySize(
            modelBaseWidth,
            modelBaseHeight,
            characterScale
          );
          const raw = model.getBounds() as {
            x?: number;
            y?: number;
            width?: number;
            height?: number;
            rectangle?: { x: number; y: number; width: number; height: number };
          };
          const picked = pickVisualModelBox(display.width, raw);
          if (picked) {
            bounds = {
              x: picked.x,
              y: Number.isFinite(raw.y) ? (raw.y as number) : 0,
              width: picked.width,
              height:
                Number.isFinite(raw.height) && (raw.height as number) > 8
                  ? (raw.height as number)
                  : display.height,
            };
          }
        } catch {
          // 바운드를 못 읽으면 화면 하단 중앙에 둔다
        }

        const hudWidth = Math.max(120, performanceHud.offsetWidth || 180);
        const hudHeight = Math.max(18, performanceHud.offsetHeight || 22);

        const chatRect =
          chatPanel?.classList.contains("open") && !chatPanel.hidden
            ? {
                left: readChatLeft(),
                top: 0,
                width: Math.max(1, chatPanel.getBoundingClientRect().width),
                height: Math.max(1, chatPanel.getBoundingClientRect().height),
              }
            : null;

        const position =
          getPerformanceHudPosition(
            {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            },
            {
              left: canvasRect.left,
              top: canvasRect.top,
              width: canvasRect.width,
              height: canvasRect.height,
            },
            app.screen.width,
            app.screen.height,
            hudWidth,
            hudHeight,
            chatRect && chatRect.width > 0
              ? {
                  left: chatRect.left,
                  top: chatRect.top,
                  width: chatRect.width,
                  height: chatRect.height,
                }
              : null,
            8,
            hudStripPx()
          );

        performanceHud.style.left =
          `${Math.round(
            position.left
          )}px`;

        performanceHud.style.top =
          `${Math.round(
            position.top
          )}px`;
        performanceHud.style.bottom = "auto";
        performanceHud.style.maxWidth = `${Math.round(position.maxWidth)}px`;
        performanceHud.dataset.placed = "true";
      };


    const renderPerformanceHud =
      () => {
        if (!performanceHudVisible) {
          return;
        }

        performanceHud.dataset.activity =
          characterActivity?.getActivity() ?? "idle";
        performanceHud.textContent =
          formatPerformanceText(
            app.ticker.FPS,
            cpuPercent,
            memoryMb,
            CHARACTER_ACTIVITY_LABELS[
              characterActivity?.getActivity() ?? "idle"
            ]
          );

        updatePerformanceHudPosition();
      };


    const refreshProcessStats =
      async () => {
        if (
          !performanceHudVisible ||
          statsBusy
        ) {
          return;
        }

        statsBusy = true;

        try {
          const stats =
            await readProcessStats();

          cpuPercent =
            stats.cpuPercent;

          memoryMb =
            stats.memoryMb;

          renderPerformanceHud();
        } catch (error) {
          console.warn(
            "성능 정보 조회 실패:",
            error
          );
        } finally {
          statsBusy = false;
        }
      };


    const stopPerformanceTimers =
      () => {
        if (fpsTimer !== null) {
          clearInterval(fpsTimer);
          fpsTimer = null;
        }

        if (statsTimer !== null) {
          clearInterval(statsTimer);
          statsTimer = null;
        }

        if (positionTimer !== null) {
          clearInterval(
            positionTimer
          );
          positionTimer = null;
        }
      };


    const startPerformanceTimers =
      () => {
        stopPerformanceTimers();

        renderPerformanceHud();

        void refreshProcessStats();

        fpsTimer =
          window.setInterval(
            renderPerformanceHud,
            1000
          );

        statsTimer =
          window.setInterval(
            () => {
              void refreshProcessStats();
            },
            3000
          );

        positionTimer =
          window.setInterval(
            updatePerformanceHudPosition,
            100
          );
      };

    window.addEventListener(
      "ai-character:layout-changed",
      updatePerformanceHudPosition
    );


    applyPerformanceHudVisibility =
      (visible: boolean) => {
        performanceHudVisible =
          visible;

        performanceHud.hidden =
          !visible;

        stopPerformanceTimers();

        if (visible) {
          startPerformanceTimers();
        }
        applyHudStripLayout();
        if (lastWindowMode === "chat") {
          void fitChatModeWindow();
        } else if (lastWindowMode === "character") {
          void fitCharacterModeWindow();
        }
      };


    applyPerformanceHudVisibility(
      performanceHudVisible
    );
  }
}

startLive2D().catch(
  (error) => {
    const detail =
      error instanceof Error
        ? error.message
        : String(error ?? "");
    if (/invoke|metadata|준비되지 않았습니다/i.test(detail)) {
      return;
    }
    console.error("Live2D 시작 실패:", error);
    const status =
      document.querySelector<HTMLDivElement>("#status");
    if (status) {
      status.textContent = "캐릭터를 불러오지 못했습니다";
      status.classList.add("error");
      status.classList.remove("hidden");
      window.setTimeout(() => {
        status.classList.add("hidden");
      }, 4000);
    }
  }
);

document.addEventListener("pointerdown", (event) => {
  // 우클릭은 contextmenu 핸들러가 메뉴를 다시 연다.
  if (event.button === 2) {
    return;
  }

  const menu =
    document.querySelector<HTMLElement>(
      "#rightclick-test-menu"
    );

  if (!menu || menu.style.display === "none") {
    return;
  }

  const target = event.target as Node;

  if (menu.contains(target)) {
    return;
  }

  window.dispatchEvent(new CustomEvent("ai-character-close-context-menu"));
});
