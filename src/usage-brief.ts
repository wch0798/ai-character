import { invoke } from "@tauri-apps/api/core";

export type UsageReport = {
  days: number;
  today: string;
  generatedAt: number;
  alerts?: {
    calls: number;
    paidCalls: number;
    costUsd: number;
    dailyCostLimitUsd: number;
    level: "ok" | "warn" | "over";
    message?: string | null;
    paidBlocked?: boolean;
  } | null;
  app?: {
    available: boolean;
    summary?: { providers?: { provider: string; calls: number; errors: number }[] };
  };
  claude?: { available: boolean; today?: { total: number; count: number } } | null;
  codex?: {
    available: boolean;
    today?: { total: number; count: number };
    meters?: { label: string; pct: number; resetsAt?: number | null }[];
  } | null;
};

export type BriefLine = { label: string; value: string; tone: "ok" | "warn" | "over" | "muted"; pct?: number };

const PROVIDER_LABELS: Record<string, string> = {
  gemini_api: "Gemini",
  openrouter_api: "OpenRouter",
  openai_api: "OpenAI",
  anthropic_api: "Anthropic",
  claude_cli: "Claude",
  claude: "Claude",
  codex: "Codex",
  jina_search: "Jina 검색",
  groq_api: "Groq",
  nvidia_api: "NVIDIA",
  zai_api: "GLM",
  sambanova_api: "SambaNova",
  cloudflare_api: "Cloudflare",
  siliconflow_api: "SiliconFlow",
  skt_ax_api: "SKT A.X",
  hasa_api: "HASA",
  hunyuan_api: "Hunyuan",
  lmstudio_local: "LM Studio",
  ollama_remote: "다른 컴퓨터",
  ollama_local: "Ollama",
};

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id.replace(/_api$|_cli$/, "");
}

export function compactNumber(value: number): string {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function meterTone(pct: number): BriefLine["tone"] {
  return pct >= 90 ? "over" : pct >= 70 ? "warn" : "ok";
}

/** A handful of one-line facts for the chat window; everything else lives on the web usage page. */
export function usageBrief(report: UsageReport): BriefLine[] {
  const lines: BriefLine[] = [];
  const alerts = report.alerts;
  if (alerts) {
    const limit = alerts.dailyCostLimitUsd;
    const pct = limit > 0 ? Math.min(100, (alerts.costUsd / limit) * 100) : undefined;
    lines.push({
      label: "오늘 유료 비용",
      value: limit > 0 ? `$${alerts.costUsd.toFixed(2)} / $${limit}` : `$${alerts.costUsd.toFixed(2)} (한도 없음)`,
      tone: alerts.paidBlocked ? "over" : alerts.level,
      pct,
    });
    lines.push({ label: "오늘 AI 호출", value: `${alerts.calls}회${alerts.paidCalls ? ` (유료 ${alerts.paidCalls})` : ""}`, tone: "muted" });
  }
  const providers = (report.app?.summary?.providers ?? []).filter((p) => p.calls > 0).sort((a, b) => b.calls - a.calls);
  if (providers.length > 0) {
    lines.push({ label: "가장 많이 쓴 AI", value: providers.slice(0, 3).map((p) => `${providerLabel(p.provider)} ${p.calls}`).join(" · "), tone: "muted" });
  }
  if (report.claude?.available && report.claude.today && report.claude.today.count > 0) {
    lines.push({ label: "Claude 구독 (오늘)", value: `응답 ${report.claude.today.count}회 · ${compactNumber(report.claude.today.total)} 토큰`, tone: "muted" });
  }
  for (const meter of report.codex?.meters ?? []) {
    lines.push({ label: `Codex ${meter.label}`, value: `${Math.round(meter.pct)}% 사용`, tone: meterTone(meter.pct), pct: Math.min(100, meter.pct) });
  }
  return lines;
}

export function getUsageReport(days: number, includeCli = true): Promise<UsageReport> {
  return invoke<UsageReport>("get_usage_report", { days, includeCli });
}
