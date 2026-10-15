import { openSetupWeb } from "./setup-web-client";
import { getUsageReport, usageBrief, type BriefLine, type UsageReport } from "./usage-brief";

const TONE_COLOR: Record<BriefLine["tone"], string> = {
  ok: "#4cc38a",
  warn: "#f0a35e",
  over: "#ef6b6b",
  muted: "#8a94a6",
};

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLine(line: BriefLine): string {
  const color = TONE_COLOR[line.tone];
  const meter =
    line.pct === undefined
      ? ""
      : `<div class="usage-meter-track"><div class="usage-meter-fill" style="width:${Math.max(2, line.pct).toFixed(1)}%;background:${color}"></div></div>`;
  return `
    <div class="usage-brief-line">
      <div class="usage-brief-row"><span>${esc(line.label)}</span><b style="color:${line.tone === "muted" ? "inherit" : color}">${esc(line.value)}</b></div>
      ${meter}
    </div>`;
}

function renderBrief(report: UsageReport): string {
  const lines = usageBrief(report);
  const message = report.alerts?.message;
  return `
    <section class="usage-card usage-brief">
      ${message ? `<p class="usage-brief-message">${esc(message)}</p>` : ""}
      ${lines.length ? lines.map(renderLine).join("") : `<div class="usage-muted">오늘은 아직 사용 기록이 없어요.</div>`}
    </section>
    <button type="button" class="usage-brief-more" data-usage-action="web">일별 그래프 · AI별 표 · 최근 기록 자세히 보기 (웹) →</button>
    <div class="usage-foot">
      ${esc(new Date(report.generatedAt || Date.now()).toLocaleTimeString("ko-KR"))} 기준
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

  let autoTimer = 0;
  let loaded = false;

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
    if (!loaded) {
      body.innerHTML = `<div class="usage-muted">오늘 사용량을 불러오는 중…</div>`;
    }
    try {
      body.innerHTML = renderBrief(await getUsageReport(1, true));
      loaded = true;
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

  const openDetailed = async (): Promise<void> => {
    await openSetupWeb("usage");
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
    window.dispatchEvent(new CustomEvent("ai-character:usage-opened"));
    await load();
    window.clearInterval(autoTimer);
    autoTimer = window.setInterval(() => {
      if (panel && !panel.hidden) {
        void load();
      }
    }, 30000);
  };

  body?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const action = target.closest<HTMLElement>("[data-usage-action]")?.dataset.usageAction;
    if (action === "web") {
      void openDetailed();
    } else if (action === "refresh") {
      void load();
    }
  });

  const bind = (button: HTMLButtonElement | null, handler: () => void): void => {
    button?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler();
    });
  };
  bind(closeButton, close);
  bind(refreshButton, () => void load());
  bind(webButton, () => void openDetailed());
  bind(loginButton, openSettingsLogin);
  bind(launcher, () => void open());

  return { open, openDetailed };
}
