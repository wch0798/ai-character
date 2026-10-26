import { invoke } from "@tauri-apps/api/core";
import { AGENT_LABELS, agentLabel, getAgentRuns, type AgentKind, type AgentRunRecord } from "./agent-client";

/** Who answered a chat message and what it cost, shown under the answer. */
export type AnswerSource = { by: string; costUsd: number };

type UsageRow = {
  provider: string;
  model: string;
  costUsd: number;
  status: string;
  createdAt: number;
};

/**
 * Sums the calls made since the question was sent. Successful calls name the answer; failed
 * paid attempts still count toward the cost.
 */
export function summarizeAnswerSource(rows: UsageRow[], runs: AgentRunRecord[], since: number): AnswerSource | null {
  const usage = rows.filter((row) => row.createdAt >= since);
  const agentRuns = runs.filter((run) => run.startedAt >= since && run.status === "completed");
  const names: string[] = [];
  const add = (name: string) => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const run of agentRuns) add([agentLabel(run.agent), run.model].filter(Boolean).join(" "));
  for (const row of usage) {
    // An agent run also logs its own usage row; name it once.
    const agent = AGENT_LABELS[row.provider.toLowerCase() as AgentKind];
    if (agent && names.some((name) => name.startsWith(agent))) continue;
    if (row.status === "ok") add(row.model ? `${row.provider} ${row.model}` : row.provider);
  }
  if (!names.length) return null;
  const costUsd = usage.reduce((sum, row) => sum + (Number.isFinite(row.costUsd) ? row.costUsd : 0), 0);
  return { by: names.slice(0, 3).join(" · "), costUsd };
}

export function formatAnswerSource(source: AnswerSource): string {
  const cost = source.costUsd > 0 ? `$${source.costUsd < 0.01 ? source.costUsd.toFixed(4) : source.costUsd.toFixed(2)}` : "무료";
  return `${source.by} · ${cost}`;
}

/** Best effort: a failed lookup just shows nothing. */
export async function lookupAnswerSource(since: number): Promise<AnswerSource | null> {
  const [rows, runs] = await Promise.all([
    invoke<UsageRow[]>("list_api_usage", { limit: 40 }).catch(() => []),
    getAgentRuns(20).catch(() => []),
  ]);
  return summarizeAnswerSource(rows, runs, since);
}
