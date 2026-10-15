import { invoke } from "@tauri-apps/api/core";

export type CoderWorktree = { path: string; branch: string };

export type WorktreeMergeOutcome = {
  merged: boolean;
  changedFiles: string[];
  conflictFiles: string[];
  message: string;
};

export type TestCommandResult = {
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
};

export type TestRunSummary = {
  detected: boolean;
  passed: boolean;
  results: TestCommandResult[];
  skipped: string[];
};

export async function createCoderWorktree(conversationId: string, taskId: string): Promise<CoderWorktree | null> {
  try {
    return await invoke<CoderWorktree>("create_coder_worktree", { conversationId, taskId });
  } catch (error) {
    console.warn("Coder worktree 생성 실패 — 공유 작업공간에서 계속합니다.", error);
    return null;
  }
}

export async function mergeCoderWorktree(conversationId: string, taskId: string): Promise<WorktreeMergeOutcome> {
  return invoke<WorktreeMergeOutcome>("merge_coder_worktree", { conversationId, taskId });
}

export async function discardCoderWorktree(conversationId: string, taskId: string): Promise<void> {
  try {
    await invoke("discard_coder_worktree", { conversationId, taskId });
  } catch (error) {
    console.warn("Coder worktree 정리 실패", error);
  }
}

export async function runProjectTests(
  conversationId: string,
  sessionId: string,
  taskId: string,
  agent: string
): Promise<TestRunSummary> {
  return invoke<TestRunSummary>("run_project_tests", { conversationId, sessionId, taskId, agent });
}

/** Compact JSON-style hand-off of a test run for the next agent. */
export function summarizeTestRun(summary: TestRunSummary): string {
  if (!summary.detected) {
    return JSON.stringify({ tests: "not_detected", note: "CLAUDE.md, package.json, Cargo.toml에서 테스트 명령을 찾지 못했습니다." });
  }
  return JSON.stringify({
    tests: summary.passed ? "passed" : "failed",
    commands: summary.results.map((result) => ({
      command: result.command,
      passed: result.passed,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    })),
  });
}

export function failingTestLogs(summary: TestRunSummary): string {
  return summary.results
    .filter((result) => !result.passed)
    .map((result) => `$ ${result.command}\n${result.output}`)
    .join("\n\n");
}
