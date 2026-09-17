import { initializeCradleOrchestrationUi } from "./orchestration-ui";
import { askCradleCompat } from "./orchestration-engine";
import { initializeSettingsUi } from "./settings-ui";
import { initializeAgentRuntimeUi } from "./agent-runtime-ui";
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
  getMaxChatHeightForCharacter,
} from "./chat-layout";
import {
  CHARACTER_WINDOW_HUD_EXTRA,
  CHARACTER_WINDOW_PADDING,
  CHAT_WINDOW_HEIGHT,
  CHAT_WINDOW_WIDTH,
  WINDOW_POSITION_KEY,
  characterBodyWidth,
  characterCenterXForChat,
  characterDisplaySize,
  characterScaleForPreset,
  chatLeftForCharacterLayout,
  clampWindowPositionToMonitor,
  compactWindowSizeForCharacter,
  maxCharacterScaleForMonitor,
  readStoredWindowPosition,
  windowPositionKeepingCharacter,
} from "./window-layout";
import "./styles.css";

import {
  Application,
  Assets,
  loadTextures,
  Ticker,
} from "pixi.js";

import {
  Live2DModel,
} from "@laplace.live/pixijs-live2d";

import {
  cursorPosition,
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";

import {
  clampWindowForCharacter,
  windowPositionForGrab,
} from "./character-window-drag";

import {
  buildMotionChoices,
} from "./motion-menu";

import {
  openUsageDashboard,
} from "./agent-client";

import {
  activityFromCradleStatus,
  CHARACTER_ACTIVITY_LABELS,
  createCharacterActivityController,
  workSway,
} from "./character-activity";

import {
  pointInRect,
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
} from "./attachment-staging";

import {
  clampChatHeight,
  readChatHeight,
} from "./chat-resize";

import {
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";

import {
  setupChatHistory,
  type ChatHistoryManager,
} from "./chat-history-ui";
import { quietConsoleInProduction } from "./quiet-console";
import { resolveLive2DAssetUrl, resolveLive2DModelSource } from "./live2d-asset-url";
import { patchLive2DAssetFetchMime } from "./live2d-fetch-mime";

quietConsoleInProduction();
patchLive2DAssetFetchMime();

async function startLive2D() {
  // 외장 디스크 TCC 권한 대화에 막히지 않도록 UI 상태 복원은 백그라운드에서 처리
  void initializeSqliteStateMirror();
  initializeAgentRuntimeUi();
  initializeSettingsUi();
  initializeCradleOrchestrationUi();
  const canvas =
    document.querySelector<HTMLCanvasElement>(
      "#live2d-canvas"
    );

  const status =
    document.querySelector<HTMLDivElement>(
      "#status"
    );

  const chatPanel =
    document.querySelector<HTMLDivElement>(
      "#chat-panel"
    );

  const chatForm =
    document.querySelector<HTMLFormElement>(
      "#chat-form"
    );

  const chatInput =
    document.querySelector<HTMLInputElement>(
      "#chat-input"
    );

  const messages =
    document.querySelector<HTMLDivElement>(
      "#messages"
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

  const chatResizeHandle =
    document.querySelector<HTMLDivElement>(
      "#chat-resize-handle"
    );

  const CHAT_HEIGHT_KEY =
    "chat-panel-height";

  if (chatPanel) {
    chatPanel.style.height =
      `${readChatHeight(
        localStorage.getItem(
          CHAT_HEIGHT_KEY
        )
      )}px`;
  }

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
    ) ?? "tiny";

  if (!(selectedSize in sizePresets)) {
    selectedSize = "tiny";
  }

  let characterScale = 1;

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
      await win.setIgnoreCursorEvents(false);
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
    menu.setAttribute("role", "menu");
    menu.style.position = "fixed";
    menu.style.width = "240px";
    menu.style.padding = "7px";
    menu.style.borderRadius = "12px";
    menu.style.background = "rgba(25, 25, 30, 0.97)";
    menu.style.color = "white";
    menu.style.fontSize = "13px";
    menu.style.zIndex = "99999";
    menu.style.boxShadow = "0 8px 28px rgba(0,0,0,0.40)";
    menu.style.overflowY = "auto";
    menu.style.boxSizing = "border-box";
    document.body.appendChild(menu);
    return menu;
  };

  const placeContextMenu = (
    menu: HTMLDivElement,
    clientX: number,
    clientY: number
  ) => {
    menu.style.maxHeight = `${Math.max(120, window.innerHeight - 16)}px`;
    menu.style.visibility = "hidden";
    menu.style.display = "block";

    const width = Math.min(240, window.innerWidth - 10);
    menu.style.width = `${width}px`;

    const height = Math.min(
      menu.scrollHeight,
      window.innerHeight - 16
    );
    const left = Math.max(
      5,
      Math.min(clientX, window.innerWidth - width - 5)
    );
    const top = Math.max(
      5,
      Math.min(clientY, window.innerHeight - height - 5)
    );

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
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
    button.style.background = "rgba(255,255,255,0.08)";
    button.style.color = "white";
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
      button.style.background = "rgba(255,255,255,0.17)";
    });
    button.addEventListener("mouseleave", () => {
      button.style.background = "rgba(255,255,255,0.08)";
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
    row.style.background = "rgba(255,255,255,0.08)";
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
    deleteBtn.style.flex = "0 0 28px";
    deleteBtn.style.width = "28px";
    deleteBtn.style.height = "28px";
    deleteBtn.style.margin = "0 4px 0 0";
    deleteBtn.style.padding = "0";
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
        ? "rgba(255,255,255,0.17)"
        : "rgba(255,255,255,0.08)";
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
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onDelete();
    });

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
      makeMenuButton("사용량", () => {
        closeContextMenu();
        void openUsageDashboard()
          .then((url) => {
            if (!status) {
              return;
            }
            status.textContent = `사용량: ${url}`;
            status.classList.remove("hidden");
            window.setTimeout(() => {
              status.classList.add("hidden");
            }, 1800);
          })
          .catch((error) => {
            if (!status) {
              return;
            }
            const message =
              error instanceof Error ? error.message : String(error);
            status.textContent = `사용량 열기 실패: ${message}`;
            status.classList.remove("hidden");
            status.classList.add("error");
            window.setTimeout(() => {
              status.classList.add("hidden");
              status.classList.remove("error");
            }, 3500);
          });
      })
    );
    menu.appendChild(
      makeMenuButton("채팅 열기", () => {
        chatPanel?.classList.add("open");
        void getCurrentWindow()
          .setIgnoreCursorEvents(false)
          .catch(() => undefined);
        closeContextMenu();
        window.setTimeout(() => {
          chatInput?.focus();
        }, 50);
      })
    );
    menu.appendChild(
      makeMenuButton("설정", () => {
        chatPanel?.classList.add("open");
        void getCurrentWindow()
          .setIgnoreCursorEvents(false)
          .catch(() => undefined);
        closeContextMenu();
        window.setTimeout(() => {
          document
            .querySelector<HTMLButtonElement>("#ai-settings-button")
            ?.click();
        }, 80);
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
    menu.appendChild(
      makeMenuButton("← 뒤로", () => {
        renderContextMenuRoot(menu, anchorX, anchorY);
      })
    );
    menu.appendChild(makeMenuTitle(title));

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
                    if (
                      !window.confirm(
                        `"${character.name}" 모델을 삭제할까요?`
                      )
                    ) {
                      return;
                    }
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
                        if (status) {
                          status.textContent =
                            error instanceof Error
                              ? error.message
                              : String(error);
                          status.classList.remove("hidden");
                          status.classList.add("error");
                        }
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
              if (status) {
                status.textContent =
                  error instanceof Error
                    ? error.message
                    : String(error);
                status.classList.remove("hidden");
                status.classList.add("error");
              }
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
          body.appendChild(
            makeMenuButton("중복 정리", () => {
              if (
                !window.confirm(
                  "내용이 같은 내 모델을 찾아 하나만 남기고 나머지를 삭제할까요?"
                )
              ) {
                return;
              }
              void (async () => {
                try {
                  const { dedupeUserLive2DModels } = await import(
                    "./user-live2d"
                  );
                  const result = await dedupeUserLive2DModels();
                  if (status) {
                    status.textContent =
                      result.removed.length === 0
                        ? "중복된 모델이 없습니다."
                        : `중복 ${result.removed.length}개 삭제`;
                    status.classList.remove("hidden");
                    window.setTimeout(() => {
                      status.classList.add("hidden");
                    }, 1800);
                  }
                  await renderCharacterView(menu, anchorX, anchorY, token);
                } catch (error) {
                  if (status) {
                    status.textContent =
                      error instanceof Error
                        ? error.message
                        : String(error);
                    status.classList.remove("hidden");
                    status.classList.add("error");
                  }
                }
              })();
            }, { muted: true })
          );
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
                if (status) {
                  status.textContent = `크기: ${size.label}`;
                  status.classList.remove("hidden");
                  window.setTimeout(() => {
                    status.classList.add("hidden");
                  }, 900);
                }
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
          "#chat-input, .message-text, #rightclick-test-menu"
        )
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      try {
        await getCurrentWindow().setIgnoreCursorEvents(false);
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

  const app = new Application();

  await app.init({
    canvas,
    resizeTo: window,
    backgroundAlpha: 0,
    antialias: true,
    preference: "webgl",
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
        await invoke("append_debug_log", {
          message: `force model: ${forced.trim()} (was ${selectedModelPath})`,
        });
        await invoke("clear_force_live2d_model");
        return forced.trim();
      }
    } catch {
      // ignore
    }
    return null;
  })();

  const effectiveModelPath = forcedModelPath ?? selectedModelPath;

  console.log(
    "선택된 캐릭터:",
    effectiveModelPath
  );
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("append_debug_log", {
      message: `startup selected=${effectiveModelPath}`,
    });
  } catch {
    // ignore
  }

  let selectedModel: Record<string, unknown> | string;
  try {
    selectedModel = await resolveLive2DModelSource(effectiveModelPath);
  } catch (error) {
    console.error("선택 모델 해석 실패, 기본 모델로 복구:", error);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("append_debug_log", {
        message: `resolve fail: ${effectiveModelPath} :: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } catch {
      // ignore
    }
    localStorage.setItem(
      "selected-live2d-model",
      "/live2d/models/Hiyori/Hiyori.model3.json"
    );
    localStorage.setItem("selected-live2d-name", "히요리");
    if (status) {
      status.textContent = `모델 로딩 실패 → 히요리로 복구: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 180);
      status.classList.remove("hidden");
      status.classList.add("error");
    }
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
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("append_debug_log", {
        message: `Live2DModel.from fail: ${effectiveModelPath} :: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } catch {
      // ignore
    }
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
      if (status) {
        status.textContent = `사용자 모델 로드 실패 → 히요리로 복구: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 180);
        status.classList.remove("hidden");
        status.classList.add("error");
      }
    } else {
      throw error;
    }
  }

  app.stage.addChild(model);

  /*
   * 현재 Live2D 모델에 크기 적용
   */
  const modelBaseWidth =
    model.width;

  const modelBaseHeight =
    model.height;

  applyCharacterSize =
    (preset: SizePreset) => {
      characterScale = characterScaleForPreset(
        modelBaseWidth,
        modelBaseHeight,
        sizePresets[preset]
      );

      model.scale.set(characterScale);

      selectedSize = preset;

      localStorage.setItem(
        "selected-character-size",
        preset
      );

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
    console.log(
      "MOTION:",
      group,
      index
    );

    void model
      .motion(
        group,
        index,
        3
      )
      .then((played) => {
        console.log(
          "MOTION RESULT:",
          group,
          index,
          played
        );

        if (status) {
          status.textContent =
            `${group} ${
              index === undefined
                ? "랜덤"
                : index + 1
            } / 실행=${played}`;

          status.classList.remove(
            "hidden"
          );

          window.setTimeout(
            () => {
              status.classList.add(
                "hidden"
              );
            },
            1000
          );
        }
      })
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
    window.innerHeight - 10;

  model.anchor.set(0.5, 1);
  applyCharacterSize(
    selectedSize
  );

  model.position.set(
    characterX,
    characterY
  );

  /*
   * 마우스 이벤트 활성화
   */
  model.eventMode = "static";
  model.cursor = "grab";

  let pointerDown = false;
  let moved = false;
  let nativeDragStarted = false;
  let characterDragActive = false;
  let dragGrabOffsetX = 0;
  let dragGrabOffsetY = 0;
  let dragMoveQueued = false;
  let dragInitInFlight = false;
  /** 캐릭터를 누르고 있는 동안 click-through 금지 */
  let holdCursorEvents = false;

  let pointerStartX = 0;
  let pointerStartY = 0;

  const isChatOpen = () =>
    Boolean(chatPanel?.classList.contains("open"));

  const beginNativeWindowDrag = async () => {
    if (nativeDragStarted) {
      return;
    }
    nativeDragStarted = true;
    characterDragActive = false;
    try {
      await getCurrentWindow().startDragging();
    } catch (error) {
      console.error("창 드래그 실패:", error);
      nativeDragStarted = false;
    }
  };

  const moveWindowWithCharacter = async () => {
    if (!characterDragActive || nativeDragStarted) {
      return;
    }

    try {
      const win = getCurrentWindow();
      const [cursor, scale, monitor] = await Promise.all([
        cursorPosition(),
        win.scaleFactor(),
        currentMonitor(),
      ]);

      let next = windowPositionForGrab(
        cursor.x,
        cursor.y,
        dragGrabOffsetX,
        dragGrabOffsetY
      );

      if (monitor) {
        const bounds = model.getBounds().rectangle;
        next = clampWindowForCharacter(
          next.x,
          next.y,
          {
            x: bounds.x * scale,
            y: bounds.y * scale,
            width: bounds.width * scale,
            height: bounds.height * scale,
          },
          {
            x: monitor.position.x,
            y: monitor.position.y,
            width: monitor.size.width,
            height: monitor.size.height,
          }
        );
      }

      await win.setPosition(
        new PhysicalPosition(Math.round(next.x), Math.round(next.y))
      );
    } catch (error) {
      console.error("캐릭터 드래그 실패, OS 드래그로 전환:", error);
      characterDragActive = false;
      await beginNativeWindowDrag();
    }
  };

  model.on("pointerdown", (event) => {
    pointerDown = true;
    moved = false;
    nativeDragStarted = false;
    characterDragActive = false;
    dragInitInFlight = false;
    holdCursorEvents = true;

    pointerStartX = event.global.x;
    pointerStartY = event.global.y;
    model.cursor = "grabbing";

    // 드래그 중 마우스가 캐릭터 밖으로 나가도 이벤트를 잃지 않게 함
    void getCurrentWindow()
      .setIgnoreCursorEvents(false)
      .catch(() => undefined);
  });

  model.on("globalpointermove", (event) => {
    if (!pointerDown || nativeDragStarted) {
      return;
    }

    const dx = event.global.x - pointerStartX;
    const dy = event.global.y - pointerStartY;
    const distance = Math.hypot(dx, dy);

    if (distance < 6) {
      return;
    }

    moved = true;

    if (isChatOpen()) {
      void beginNativeWindowDrag();
      return;
    }

    if (!characterDragActive && !dragInitInFlight) {
      dragInitInFlight = true;
      void (async () => {
        try {
          const win = getCurrentWindow();
          await win.setIgnoreCursorEvents(false);
          const [cursor, outer] = await Promise.all([
            cursorPosition(),
            win.outerPosition(),
          ]);
          if (!pointerDown || nativeDragStarted) {
            return;
          }
          dragGrabOffsetX = cursor.x - outer.x;
          dragGrabOffsetY = cursor.y - outer.y;
          characterDragActive = true;
          await moveWindowWithCharacter();
        } catch (error) {
          console.error("캐릭터 드래그 시작 실패, OS 드래그로 전환:", error);
          await beginNativeWindowDrag();
        } finally {
          dragInitInFlight = false;
        }
      })();
      return;
    }

    if (!characterDragActive || dragMoveQueued) {
      return;
    }

    dragMoveQueued = true;
    requestAnimationFrame(() => {
      dragMoveQueued = false;
      void moveWindowWithCharacter();
    });
  });

  const stopDragging = () => {
    const wasMoving = moved || characterDragActive || nativeDragStarted;
    pointerDown = false;
    nativeDragStarted = false;
    characterDragActive = false;
    dragInitInFlight = false;
    holdCursorEvents = false;
    model.cursor = "grab";
    if (wasMoving) {
      void saveWindowPosition();
    }
  };

  model.on("pointerup", stopDragging);
  model.on("pointerupoutside", stopDragging);
  window.addEventListener("pointerup", stopDragging);
  window.addEventListener("blur", stopDragging);

  const tauriWindow = getCurrentWindow();
  let windowModeSyncing = false;
  let lastWindowMode: "character" | "chat" | null = null;
  let syncChatModelPosition: () => void = () => {};

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
    const bounds = model.getBounds().rectangle;
    return {
      x: outer.x + bounds.x * scale,
      y: outer.y + bounds.y * scale,
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
    const maxWidth = monitor
      ? (monitor.size.width / scaleFactor) * 0.55
      : 700;
    const maxHeight = monitor
      ? (monitor.size.height / scaleFactor) * 0.9
      : 900;

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

    await tauriWindow.setSize(
      new LogicalSize(size.width, size.height)
    );
    await waitNextFrame();
    await waitNextFrame();
    model.x = window.innerWidth * 0.5;
    model.y = window.innerHeight - 10;
  };

  const syncWindowMode = async (force = false) => {
    if (windowModeSyncing) {
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
        await fitCharacterModeWindow();
      } else {
        await tauriWindow.setSize(
          new LogicalSize(CHAT_WINDOW_WIDTH, CHAT_WINDOW_HEIGHT)
        );
        await waitNextFrame();
        await waitNextFrame();
        syncChatModelPosition();
      }

      const newBounds = model.getBounds().rectangle;
      let next = windowPositionKeepingCharacter(
        screenPos.x,
        screenPos.y,
        newBounds.x,
        newBounds.y,
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
      const [monitor, outerSize] = await Promise.all([
        currentMonitor(),
        tauriWindow.outerSize(),
      ]);
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
   * 클릭하면:
   * - 채팅창 열기
   * - TapBody 모션
   */
  model.on("pointertap", async () => {
    if (moved) return;

    chatPanel?.classList.toggle("open");

    try {
      await model.motion("TapBody", undefined, 3);
    } catch (error) {
      console.warn(
        "TapBody motion:",
        error
      );
    }
  });

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

  /*
   * 마우스 휠로 캐릭터 크기 조절
   */
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();

      if (event.deltaY < 0) {
        characterScale += 0.01;
      } else {
        characterScale -= 0.01;
      }

      characterScale =
        Math.max(
          0.05,
          Math.min(
            0.55,
            characterScale
          )
        );

      model.scale.set(
        characterScale
      );

      onCharacterScaleChanged?.();

      if (status) {
        status.textContent =
          `크기 ${Math.round(
            characterScale * 100
          )}%`;

        status.classList.remove(
          "hidden"
        );

        setTimeout(() => {
          status.classList.add(
            "hidden"
          );
        }, 700);
      }
    },
    {
      passive: false,
    }
  );

  /*
   * 채팅
   */
  function addMessage(
    text: string,
    type: "user" | "assistant"
  ) {
    if (!messages) return;

    const bubble =
      document.createElement("div");

    bubble.className =
      `message ${type}`;

    const content =
      document.createElement("div");

    content.className =
      "message-text";

    content.textContent = text;

    const copyButton =
      document.createElement("button");

    copyButton.type = "button";

    copyButton.className =
      "message-copy";

    copyButton.textContent =
      "복사";

    copyButton.title =
      "메시지 복사";

    copyButton.addEventListener(
      "click",
      async (event) => {
        event.stopPropagation();

        try {
          await writeText(text);

          copyButton.textContent =
            "복사됨";

          window.setTimeout(
            () => {
              copyButton.textContent =
                "복사";
            },
            900
          );
        } catch (error) {
          console.error(
            "클립보드 복사 실패:",
            error
          );
        }
      }
    );

    bubble.append(
      content,
      copyButton
    );

    messages.appendChild(bubble);

    messages.scrollTop =
      messages.scrollHeight;
  }

  let lastAssistantReply = "";

  function postAssistantReply(text: string): void {
    const clean = text.trim();
    if (!clean || clean === lastAssistantReply) {
      return;
    }
    lastAssistantReply = clean;
    addMessage(clean, "assistant");
    chatHistory?.append("assistant", clean);
    messages?.scrollTo({
      top: messages.scrollHeight,
      behavior: "smooth",
    });
  }

  if (messages) {
    chatHistory =
      setupChatHistory({
        messages,
        addMessage,
      });
  }

  window.addEventListener("ai-character:cradle-session", (event: Event) => {
    const session = (event as CustomEvent<{
      status?: string;
      finalAnswer?: string | null;
    }>).detail;
    const activity = activityFromCradleStatus(session?.status);
    if (activity) {
      characterActivity?.setActivity(activity);
    }
    if (session?.status === "completed" && session.finalAnswer) {
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

  let cursorEventsIgnored = false;
  let cursorCheckRunning = false;

  let cachedCharacterBounds =
    model.getBounds().rectangle;

  let lastBoundsUpdate = 0;

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
    cursorEventsIgnored = false;
    lastBoundsUpdate = 0;
  };

  await clickThroughWindow.onMoved(
    ({ payload }) => {
      clickThroughWindowPosition =
        payload;
    }
  );

  await clickThroughWindow
    .onScaleChanged(
      ({ payload }) => {
        clickThroughScaleFactor =
          payload.scaleFactor;
      }
    );

  const isOverlayInteractive = (
    x: number,
    y: number
  ): boolean => {
    const settingsPanel =
      document.querySelector<HTMLElement>(
        "#ai-settings-panel"
      );
    if (settingsPanel && !settingsPanel.hidden) {
      const rect = settingsPanel.getBoundingClientRect();
      if (
        pointInRect(x, y, {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        })
      ) {
        return true;
      }
    }

    if (isChatOpen() && chatPanel) {
      const rect = chatPanel.getBoundingClientRect();
      if (
        pointInRect(x, y, {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        })
      ) {
        return true;
      }
    }

    const target =
      document.elementFromPoint(
        x,
        y
      );

    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(
      target.closest(
        [
          "#chat-panel",
          "#ai-settings-panel",
          "#rightclick-test-menu",
          "button",
          "input",
          "textarea",
          "select",
          "form",
          "[role='menu']",
          "[role='menuitem']",
        ].join(",")
      )
    );
  };

  const isCharacterInteractive = (
    x: number,
    y: number
  ): boolean => {
    const canvasRect =
      canvas.getBoundingClientRect();

    if (
      canvasRect.width <= 0 ||
      canvasRect.height <= 0
    ) {
      return false;
    }

    if (
      !pointInRect(
        x,
        y,
        {
          x: canvasRect.left,
          y: canvasRect.top,
          width: canvasRect.width,
          height: canvasRect.height,
        }
      )
    ) {
      return false;
    }

    const now =
      performance.now();

    /*
     * Live2D bounds 계산은
     * 매 프레임 하지 않고
     * 250ms마다만 갱신
     */
    if (
      now - lastBoundsUpdate >
      250
    ) {
      cachedCharacterBounds =
        model.getBounds().rectangle;

      lastBoundsUpdate = now;
    }

    const pixiX =
      (x - canvasRect.left) *
      (
        app.screen.width /
        canvasRect.width
      );

    const pixiY =
      (y - canvasRect.top) *
      (
        app.screen.height /
        canvasRect.height
      );

    return pointInRect(
      pixiX,
      pixiY,
      {
        x: cachedCharacterBounds.x,
        y: cachedCharacterBounds.y,
        width:
          cachedCharacterBounds.width,
        height:
          cachedCharacterBounds.height,
      },
      14
    );
  };

  const updateClickThrough =
    async () => {
      if (cursorCheckRunning) {
        return;
      }

      cursorCheckRunning = true;

      try {
        const cursor =
          await cursorPosition();

        /*
         * Tauri 위치는 physical pixel,
         * DOM 좌표는 logical pixel이므로
         * scaleFactor로 변환한다.
         */
        const localX =
          (
            cursor.x -
            clickThroughWindowPosition.x
          ) /
          clickThroughScaleFactor;

        const localY =
          (
            cursor.y -
            clickThroughWindowPosition.y
          ) /
          clickThroughScaleFactor;

        const isWindowsHost =
          navigator.userAgent.includes("Windows") ||
          (
            navigator as Navigator & {
              userAgentData?: { platform?: string };
            }
          ).userAgentData?.platform === "Windows";

        const settingsOpen = (() => {
          const panel =
            document.querySelector<HTMLElement>(
              "#ai-settings-panel"
            );
          return Boolean(panel && !panel.hidden);
        })();

        /*
         * Windows WebView2에서는 click-through + 투명 창 조합이
         * 설정/채팅 클릭을 자주 삼킨다. Windows에서는 끄고,
         * macOS는 기존처럼 캐릭터/오버레이 hit만 통과시킨다.
         */
        const interactive =
          isWindowsHost ||
          holdCursorEvents ||
          contextMenuOpen ||
          menuCursorLock ||
          characterDragActive ||
          isChatOpen() ||
          settingsOpen ||
          isCharacterInteractive(
            localX,
            localY
          ) ||
          isOverlayInteractive(
            localX,
            localY
          );

        const shouldIgnore =
          !interactive;

        /*
         * 상태가 실제로 바뀔 때만
         * Tauri IPC 호출
         */
        if (
          shouldIgnore !==
          cursorEventsIgnored
        ) {
          await clickThroughWindow
            .setIgnoreCursorEvents(
              shouldIgnore
            );

          cursorEventsIgnored =
            shouldIgnore;
        }
      } catch (error) {
        console.warn(
          "click-through update 실패:",
          error
        );
      } finally {
        cursorCheckRunning = false;
      }
    };

  window.setInterval(
    () => {
      void updateClickThrough();
    },
    60
  );

  window.addEventListener("ai-character:settings-opened", () => {
    cursorEventsIgnored = false;
    void getCurrentWindow()
      .setIgnoreCursorEvents(false)
      .catch(() => undefined);
  });

  window.addEventListener("ai-character:settings-closed", () => {
    void updateClickThrough();
  });

  void updateClickThrough();


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
      const rootStyle =
        getComputedStyle(document.documentElement);
      const chatGapCss =
        Number.parseFloat(
          rootStyle.getPropertyValue("--ai-character-chat-gap")
        );
      const chatGap =
        Number.isFinite(chatGapCss) && chatGapCss >= 0
          ? chatGapCss
          : 6;

      const display = characterDisplaySize(
        modelBaseWidth,
        modelBaseHeight,
        characterScale
      );
      // 캐릭터가 커질수록 채팅도 같이 오른쪽으로 밀리도록 레이아웃 폭 사용
      const layoutWidth = characterBodyWidth(display.width);

      if (isChatOpen()) {
        model.x = characterCenterXForChat(display.width, 10);
        model.y = window.innerHeight - 10;

        const compactChatLeft = chatLeftForCharacterLayout(
          model.x,
          layoutWidth,
          chatGap,
          window.innerWidth,
          340
        );

        document.documentElement.style.setProperty(
          "--ai-character-chat-left",
          `${compactChatLeft}px`
        );
        document.documentElement.style.setProperty(
          "--ai-character-character-pane-width",
          `${Math.max(64, Math.ceil(model.x + layoutWidth * 0.5))}px`
        );
        if (chatPanel) {
          // CSS !important 규칙보다 우선되도록 지정
          chatPanel.style.setProperty(
            "left",
            `${compactChatLeft}px`,
            "important"
          );
        }
      } else {
        model.x = window.innerWidth * 0.5;
        model.y = window.innerHeight - 10;
        if (chatPanel) {
          chatPanel.style.removeProperty("left");
        }
      }
  };

  syncChatModelPosition = syncChatModelPositionImpl;

  onCharacterScaleChanged = () => {
    if (isChatOpen()) {
      const maxScale = maxCharacterScaleForMonitor(
        modelBaseWidth,
        modelBaseHeight,
        Math.max(80, window.innerWidth * 0.45),
        Math.max(80, window.innerHeight - 24)
      );
      if (characterScale > maxScale) {
        characterScale = maxScale;
        model.scale.set(characterScale);
      }
      syncChatModelPosition();
      return;
    }
    lastWindowMode = null;
    void (async () => {
      const screenPos = await captureCharacterScreenPos();
      await fitCharacterModeWindow();
      const newBounds = model.getBounds().rectangle;
      let next = windowPositionKeepingCharacter(
        screenPos.x,
        screenPos.y,
        newBounds.x,
        newBounds.y,
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
        if (!windowModeSyncing) {
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


  if (
    chatPanel &&
    chatResizeHandle
  ) {
    chatResizeHandle.addEventListener(
      "pointerdown",
      (event) => {
        event.preventDefault();

        const startY =
          event.clientY;

        const startHeight =
          chatPanel.getBoundingClientRect()
            .height;

        chatResizeHandle.setPointerCapture(
          event.pointerId
        );

        const onMove =
          (moveEvent: PointerEvent) => {
            const delta =
              startY -
              moveEvent.clientY;

            const canvasRect =
              canvas.getBoundingClientRect();

            const modelBounds =
              model.getBounds().rectangle;

            const modelHeightCss =
              modelBounds.height *
              (
                canvasRect.height /
                app.screen.height
              );

            const gapCss =
              (
                performanceHudVisible
                  ? 38
                  : 14
              ) *
              (
                canvasRect.height /
                app.screen.height
              );

            const maxHeight =
              getMaxChatHeightForCharacter(
                window.innerHeight,
                12,
                modelHeightCss,
                gapCss
              );

            const nextHeight =
              clampChatHeight(
                startHeight + delta,
                160,
                maxHeight
              );

            chatPanel.style.height =
              `${nextHeight}px`;

            localStorage.setItem(
              CHAT_HEIGHT_KEY,
              String(nextHeight)
            );

            syncChatModelPosition();
          };

        const onUp =
          (upEvent: PointerEvent) => {
            chatResizeHandle
              .releasePointerCapture(
                upEvent.pointerId
              );

            window.removeEventListener(
              "pointermove",
              onMove
            );

            window.removeEventListener(
              "pointerup",
              onUp
            );
          };

        window.addEventListener(
          "pointermove",
          onMove
        );

        window.addEventListener(
          "pointerup",
          onUp
        );
      }
    );
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


  chatForm?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const text =
        chatInput?.value.trim();

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

      const requestPrompt =
        buildAttachmentPrompt(
          text ?? "",
          pendingAttachments
        );

      if (chatInput) {
        chatInput.value = "";
        chatInput.disabled = true;
      }

      characterActivity?.setActivity("working");

      try {
        const answer =
          await askCradleCompat(
            requestPrompt,
            chatHistory?.getActiveId() ?? null,
            previousConversationContext
          );

        postAssistantReply(
          answer || "작업을 마쳤지만 채팅에 넣을 답이 비어 있습니다."
        );

        characterActivity?.setActivity("done");

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
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        addMessage(
          `Claude 연결 오류: ${message}`,
          "assistant"
        );
        characterActivity?.setActivity("error");
      } finally {
        if (chatInput) {
          chatInput.disabled = false;
          chatInput.focus();
        }
      }
    }
  );

  if (status) {
    status.textContent =
      "캐릭터를 클릭하면 채팅창이 열립니다";

    setTimeout(() => {
      status.classList.add(
        "hidden"
      );
    }, 2500);
  }

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

        const bounds =
          model.getBounds().rectangle;

        const chatTop =
          chatPanel?.classList.contains(
            "open"
          )
            ? chatPanel
                .getBoundingClientRect()
                .top
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
            performanceHud.offsetWidth,
            performanceHud.offsetHeight,
            chatTop
          );

        performanceHud.style.left =
          `${Math.round(
            position.left
          )}px`;

        performanceHud.style.top =
          `${Math.round(
            position.top
          )}px`;
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
            500
          );
      };


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
      };


    applyPerformanceHudVisibility(
      performanceHudVisible
    );
  }


  console.log(
    "Live2D UI ready"
  );
}

startLive2D().catch(
  (error) => {
    console.error(
      "Live2D 시작 실패:",
      error
    );

    const status =
      document.querySelector<HTMLDivElement>(
        "#status"
      );

    if (status) {
      const detail =
        error instanceof Error
          ? error.message
          : String(error ?? "");
      status.textContent = detail
        ? `Live2D 로딩 실패: ${detail.slice(0, 160)}`
        : "Live2D 로딩 실패";

      status.classList.add(
        "error"
      );
      status.classList.remove("hidden");
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
