import { getUsageSnapshot, openUsageDashboard } from "./agent-client";
import { getCurrentWindow } from "@tauri-apps/api/window";

type UsageAccount = {
  connected?: boolean;
  email?: string | null;
  keyHint?: string | null;
  name?: string | null;
  plan?: string | null;
  organization?: string | null;
  loginWith?: string | null;
  source?: string | null;
  linesExtra?: string[];
};

type UsageMeter = {
  label?: string;
  pct?: number;
  windowMin?: number;
  resetsAt?: number;
};

type UsageProvider = {
  id?: string;
  label?: string;
  available?: boolean;
  account?: UsageAccount;
  headline?: { label?: string; value?: number; detail?: string };
  meters?: { title?: string; items?: UsageMeter[]; note?: string };
  note?: string;
  modelTable?: {
    title?: string;
    columns?: { key: string; label: string; num?: boolean }[];
    rows?: Record<string, unknown>[];
  };
};

type UsageSnapshot = {
  generatedAt?: number;
  appDir?: string;
  providers?: UsageProvider[];
  keys?: { env?: string; label?: string; configured?: boolean; hint?: string | null }[];
  app?: {
    character?: string;
    selectedModel?: string;
    conversations?: {
      id?: string;
      title?: string;
      userMessages?: number;
      assistantMessages?: number;
      updatedAt?: number;
    }[];
    runs?: {
      agent?: string;
      model?: string;
      status?: string;
      started_at?: number;
      duration_ms?: number;
      error_summary?: string;
    }[];
  };
};

type UsageTab = "overview" | "accounts" | "usage" | "history";

const PLAN: Record<string, string> = {
  claude_max: "Max",
  claude_pro: "Pro",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
  plus: "Plus",
};

const GUIDE: Record<string, { name: string; what: string; color: string }> = {
  claude: { name: "Claude", what: "글 쓰기·코드 수정을 맡기는 AI예요.", color: "#d4a373" },
  codex: { name: "Codex", what: "ChatGPT 계정으로 코드를 다루는 AI예요.", color: "#67a6ff" },
  cursor: { name: "Cursor", what: "이 편집기에서 코드를 고치는 AI예요.", color: "#c084fc" },
  antigravity: { name: "Antigravity", what: "Google 쪽 코딩 AI예요.", color: "#4cc38a" },
};

const STATUS_KO: Record<string, string> = {
  completed: "완료",
  running: "실행 중",
  failed: "실패",
  cancelled: "취소",
};

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(value: unknown): string {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function full(value: unknown): string {
  return (Number(value) || 0).toLocaleString("ko-KR");
}

function time(ts?: number): string {
  return ts ? new Date(ts).toLocaleString("ko-KR") : "—";
}

function isConnected(account?: UsageAccount | null): boolean {
  return Boolean(account?.connected || account?.email || account?.keyHint);
}

function meterTone(pct: number): { label: string; color: string } {
  if (pct >= 90) return { label: "거의 다 씀", color: "#ef6b6b" };
  if (pct >= 70) return { label: "주의", color: "#f0a35e" };
  return { label: "여유 있음", color: "#4cc38a" };
}

function providerValue(provider: UsageProvider): number {
  return Number(provider.headline?.value) || 0;
}

function renderMeter(item: UsageMeter): string {
  const pct = Math.max(0, Number(item.pct) || 0);
  const tone = meterTone(pct);
  const windowMin = Number(item.windowMin) || 0;
  const win =
    windowMin >= 1440
      ? `${Math.round(windowMin / 1440)}일마다`
      : `${Math.round(windowMin / 60) || 1}시간마다`;
  const reset = item.resetsAt ? new Date(item.resetsAt * 1000) : null;
  const resetText = !reset
    ? `${win} 한도를 봐요`
    : reset < new Date()
      ? "한도가 이미 다시 채워졌어요"
      : `${reset.toLocaleString("ko-KR")}에 다시 채워져요`;
  return `<div class="usage-meter">
    <div class="usage-meter-row">
      <span>${esc(item.label)}</span>
      <b style="color:${tone.color}">${esc(pct)}% · ${esc(tone.label)}</b>
    </div>
    <div class="usage-meter-track"><div class="usage-meter-fill" style="width:${Math.min(100, pct)}%;background:${tone.color}"></div></div>
    <div class="usage-muted">${esc(resetText)}</div>
  </div>`;
}

function compareBars(providers: UsageProvider[]): string {
  const max = Math.max(1, ...providers.map(providerValue));
  return `<div class="usage-compare">${providers
    .map((provider) => {
      const guide = GUIDE[provider.id || ""] ?? {
        name: provider.label || provider.id,
        color: "#67a6ff",
      };
      const value = providerValue(provider);
      const width = Math.max(4, Math.round((value / max) * 100));
      return `<div class="usage-compare-row">
        <span>${esc(guide.name)}</span>
        <div class="usage-compare-track"><i style="width:${width}%;background:${guide.color}"></i></div>
        <b>${esc(fmt(value))}</b>
      </div>`;
    })
    .join("")}</div>
    <div class="usage-muted">막대가 길수록 그 AI를 더 많이 쓴 거예요. 숫자는 토큰(읽고 쓴 분량) 또는 추적 횟수입니다.</div>`;
}

function renderOverview(data: UsageSnapshot): string {
  const providers = data.providers ?? [];
  const keys = data.keys ?? [];
  const runs = data.app?.runs ?? [];
  const conversations = data.app?.conversations ?? [];
  const connected = providers.filter((provider) => isConnected(provider.account)).length;
  const missingKeys = keys.filter((key) => !key.configured);
  const todos: string[] = [];
  for (const provider of providers) {
    if (!isConnected(provider.account)) {
      todos.push(`${GUIDE[provider.id || ""]?.name || provider.label} 로그인이 필요해요.`);
    }
  }
  if (missingKeys.length) {
    todos.push(`${missingKeys.map((key) => key.label).join(", ")} 키를 넣으면 바로 답할 수 있어요.`);
  }
  if (!todos.length) {
    todos.push("필요한 계정은 연결되어 있어요. 채팅만 하면 됩니다.");
  }

  const messages = conversations.reduce(
    (sum, item) => sum + (item.userMessages || 0) + (item.assistantMessages || 0),
    0
  );
  const failed = runs.filter((run) => run.status === "failed").length;

  return `
    <section class="usage-hero">
      <div class="usage-hero-kicker">한눈에 보기</div>
      <div class="usage-hero-title">AI를 얼마나 썼는지 보는 화면이에요</div>
      <p class="usage-hero-lead">로그인된 AI만 사용량이 정확히 붙습니다. 미연결이면 설정 → 로그인에서 연결하세요.</p>
      <div class="usage-pills">
        <span class="usage-pill ${connected === providers.length ? "is-good" : "is-warn"}">계정 ${connected}/${providers.length} 연결</span>
        <span class="usage-pill">이 앱 대화 ${full(conversations.length)}개</span>
        <span class="usage-pill">에이전트 실행 ${full(runs.length)}회</span>
        ${failed ? `<span class="usage-pill is-bad">실패 ${failed}회</span>` : ""}
      </div>
    </section>
    <section class="usage-card usage-todo">
      <h3>지금 하면 좋은 일</h3>
      <ul>${todos.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
      <div class="usage-inline-actions">
        <button type="button" class="usage-action" data-usage-action="login">로그인 탭 열기</button>
        <button type="button" class="usage-action usage-action-ghost" data-usage-action="web">자세한 웹 창</button>
      </div>
    </section>
    <section class="usage-card">
      <h3>누가 더 많이 쓰였나요?</h3>
      ${compareBars(providers)}
    </section>
    <div class="usage-stat-grid">
      <div class="usage-stat"><span>메시지</span><b>${esc(full(messages))}</b><small>나와 캐릭터가 주고받은 횟수</small></div>
      <div class="usage-stat"><span>실행</span><b>${esc(full(runs.length))}</b><small>파일을 고치라고 시킨 횟수</small></div>
      <div class="usage-stat"><span>API 키</span><b>${esc(`${keys.filter((key) => key.configured).length}/${keys.length}`)}</b><small>바로 답할 때 쓰는 키</small></div>
    </div>
  `;
}

function renderAccounts(data: UsageSnapshot): string {
  const providers = data.providers ?? [];
  const keys = data.keys ?? [];
  const cards = providers
    .map((provider) => {
      const guide = GUIDE[provider.id || ""] ?? {
        name: provider.label || provider.id,
        what: "이 AI의 로그인 상태예요.",
        color: "#67a6ff",
      };
      const connected = isConnected(provider.account);
      const lines = [
        provider.account?.email || (provider.account?.keyHint ? `API 키 ${provider.account.keyHint}` : "아직 로그인하지 않았어요"),
        provider.account?.name && `이름 ${provider.account.name}`,
        provider.account?.plan && `요금제 ${PLAN[provider.account.plan] ?? provider.account.plan}`,
        provider.account?.loginWith && `${provider.account.loginWith}로 로그인`,
      ].filter(Boolean);
      return `<article class="usage-ai-card" style="--usage-accent:${guide.color}">
        <div class="usage-ai-top">
          <strong>${esc(guide.name)}</strong>
          <span class="usage-badge ${connected ? "is-on" : ""}">${connected ? "연결됨" : "로그인 필요"}</span>
        </div>
        <p>${esc(guide.what)}</p>
        ${lines.map((line) => `<div class="usage-muted">${esc(line)}</div>`).join("")}
        ${connected ? "" : `<button type="button" class="usage-action" data-usage-action="login">로그인하러 가기</button>`}
      </article>`;
    })
    .join("");

  const keyCards = keys
    .map((key) => {
      const ok = Boolean(key.configured);
      return `<article class="usage-ai-card">
        <div class="usage-ai-top">
          <strong>${esc(key.label)}</strong>
          <span class="usage-badge ${ok ? "is-on" : ""}">${ok ? "키 있음" : "키 없음"}</span>
        </div>
        <p>로그인이 아니라 설정 파일에 비밀 키를 넣는 방식이에요.</p>
        <div class="usage-muted">${ok ? "키가 준비되어 있어요" : "아직 키가 없어요"}</div>
        <button type="button" class="usage-action" data-usage-action="login">${ok ? "키 파일 확인" : "키 넣으러 가기"}</button>
      </article>`;
    })
    .join("");

  return `<section class="usage-card"><h3>계정 · 키</h3><p class="usage-muted">초록은 준비됨, 회색은 아직입니다. 로그인은 설정 로그인 탭에서 합니다.</p></section>
    <div class="usage-ai-grid">${cards}${keyCards}</div>`;
}

function renderUsage(data: UsageSnapshot): string {
  const providers = data.providers ?? [];
  return providers
    .map((provider) => {
      const guide = GUIDE[provider.id || ""] ?? {
        name: provider.label || provider.id,
        what: "",
        color: "#67a6ff",
      };
      const meters = (provider.meters?.items ?? []).map(renderMeter).join("");
      const topModels = (provider.modelTable?.rows ?? [])
        .slice()
        .sort((a, b) => Number(b.messages || b.sessions || b.events || 0) - Number(a.messages || a.sessions || a.events || 0))
        .slice(0, 4);
      const modelHtml = topModels.length
        ? `<div class="usage-model-list">${topModels
            .map((row) => {
              const name = String(row.model || row.ext || "모델");
              const count = row.messages ?? row.sessions ?? row.events ?? row.input ?? 0;
              return `<div class="usage-model-row"><span>${esc(name)}</span><b>${esc(fmt(count))}</b></div>`;
            })
            .join("")}</div>`
        : `<div class="usage-muted">아직 이 AI를 쓴 기록이 거의 없어요.</div>`;
      return `<section class="usage-card usage-ai-card" style="--usage-accent:${guide.color}">
        <div class="usage-ai-top">
          <strong>${esc(guide.name)}</strong>
          <span class="usage-tile-value">${esc(fmt(providerValue(provider)))}</span>
        </div>
        <p>${esc(guide.what)} ${esc(provider.headline?.detail || "")}</p>
        ${meters}
        <h4>자주 쓴 모델</h4>
        ${modelHtml}
        ${provider.note ? `<div class="usage-muted">${esc(provider.note)}</div>` : ""}
      </section>`;
    })
    .join("");
}

function renderHistory(data: UsageSnapshot): string {
  const runs = data.app?.runs ?? [];
  const conversations = data.app?.conversations ?? [];
  if (!runs.length && !conversations.length) {
    return `<section class="usage-card"><h3>기록</h3><p>아직 이 앱에서 실행한 작업이 없어요. 채팅으로 일을 시키면 여기에 쌓입니다.</p></section>`;
  }
  const runHtml = runs
    .slice(0, 12)
    .map((run) => {
      const status = STATUS_KO[run.status || ""] || run.status || "상태 없음";
      return `<div class="usage-history-row">
        <div>
          <b>${esc(run.agent || "agent")}</b>
          <span class="usage-muted">${esc(run.model || "기본 모델")} · ${esc(time(run.started_at))}</span>
        </div>
        <span class="usage-badge ${run.status === "completed" ? "is-on" : run.status === "failed" ? "is-bad" : ""}">${esc(status)}</span>
        ${run.error_summary ? `<div class="usage-error">${esc(run.error_summary.slice(0, 80))}</div>` : ""}
      </div>`;
    })
    .join("");
  const chatHtml = conversations
    .slice(0, 8)
    .map(
      (item) => `<div class="usage-history-row">
        <div><b>${esc(item.title || "대화")}</b><span class="usage-muted">나 ${item.userMessages || 0} · 캐릭터 ${item.assistantMessages || 0}</span></div>
        <span class="usage-muted">${esc(time(item.updatedAt))}</span>
      </div>`
    )
    .join("");
  return `
    <section class="usage-card"><h3>에이전트가 한 일</h3>${runHtml || `<div class="usage-muted">아직 없어요</div>`}</section>
    <section class="usage-card"><h3>최근 대화</h3>${chatHtml || `<div class="usage-muted">아직 없어요</div>`}</section>
  `;
}

function renderShell(data: UsageSnapshot, tab: UsageTab): string {
  const tabs: Array<[UsageTab, string]> = [
    ["overview", "한눈에"],
    ["accounts", "계정"],
    ["usage", "AI별 사용"],
    ["history", "기록"],
  ];
  const body =
    tab === "accounts"
      ? renderAccounts(data)
      : tab === "usage"
        ? renderUsage(data)
        : tab === "history"
          ? renderHistory(data)
          : renderOverview(data);
  return `
    <div class="usage-tabs" role="tablist">
      ${tabs
        .map(
          ([id, label]) =>
            `<button type="button" class="usage-tab ${tab === id ? "active" : ""}" data-usage-tab="${id}">${label}</button>`
        )
        .join("")}
    </div>
    ${body}
    <div class="usage-foot">
      마지막 확인 ${esc(time(data.generatedAt))}
      <button type="button" class="usage-text-btn" data-usage-action="refresh">다시 불러오기</button>
    </div>
  `;
}

export function initializeUsageDashboardUi(options: {
  setChatOpen: (open: boolean) => void;
}): { open: () => Promise<void>; openDetailed: () => Promise<void> } {
  const panel = document.querySelector<HTMLElement>("#usage-dashboard-panel");
  const body = document.querySelector<HTMLElement>("#usage-dashboard-body");
  const closeButton = document.querySelector<HTMLButtonElement>("#usage-dashboard-close");
  const refreshButton = document.querySelector<HTMLButtonElement>("#usage-dashboard-refresh");
  const webButton = document.querySelector<HTMLButtonElement>("#usage-dashboard-web");
  const loginButton = document.querySelector<HTMLButtonElement>("#usage-dashboard-login");
  const launcher = document.querySelector<HTMLButtonElement>("#usage-dashboard-button");

  let snapshot: UsageSnapshot | null = null;
  let tab: UsageTab = "overview";
  let autoTimer = 0;

  const paint = (): void => {
    if (!body || !snapshot) {
      return;
    }
    body.innerHTML = renderShell(snapshot, tab);
  };

  const close = (): void => {
    if (!panel) {
      return;
    }
    panel.hidden = true;
    window.clearInterval(autoTimer);
    autoTimer = 0;
    window.dispatchEvent(new CustomEvent("ai-character:usage-closed"));
  };

  const load = async (): Promise<void> => {
    if (!body) {
      return;
    }
    body.innerHTML = `<div class="usage-hero"><div class="usage-hero-title">사용량을 불러오는 중…</div><p class="usage-hero-lead">계정과 최근 사용 기록을 모으고 있어요.</p></div>`;
    try {
      snapshot = (await getUsageSnapshot()) as UsageSnapshot;
      paint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      body.innerHTML = `<div class="usage-error">사용량을 열 수 없습니다.<br>${esc(message)}</div>`;
    }
  };

  const openSettingsLogin = (): void => {
    close();
    window.dispatchEvent(
      new CustomEvent("ai-character:open-settings", { detail: { tab: "accounts" } })
    );
  };

  const open = async (): Promise<void> => {
    options.setChatOpen(true);
    const settings = document.querySelector<HTMLElement>("#ai-settings-panel");
    if (settings) {
      settings.hidden = true;
    }
    if (panel) {
      panel.hidden = false;
    }
    void getCurrentWindow()
      .setIgnoreCursorEvents(false)
      .catch(() => undefined);
    window.dispatchEvent(new CustomEvent("ai-character:usage-opened"));
    tab = "overview";
    await load();
    window.clearInterval(autoTimer);
    autoTimer = window.setInterval(() => {
      if (!panel || panel.hidden) {
        return;
      }
      void load();
    }, 30000);
  };

  const openDetailed = async (): Promise<void> => {
    await openUsageDashboard();
  };

  body?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const tabButton = target.closest<HTMLElement>("[data-usage-tab]");
    if (tabButton?.dataset.usageTab) {
      tab = tabButton.dataset.usageTab as UsageTab;
      paint();
      return;
    }
    const action = target.closest<HTMLElement>("[data-usage-action]")?.dataset.usageAction;
    if (action === "login") {
      openSettingsLogin();
      return;
    }
    if (action === "web") {
      void openDetailed();
      return;
    }
    if (action === "refresh") {
      void load();
    }
  });

  closeButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  refreshButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void load();
  });
  webButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openDetailed();
  });
  loginButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSettingsLogin();
  });
  launcher?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void open();
  });

  return { open, openDetailed };
}
