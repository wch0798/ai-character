export type OrchestrationCliTarget =
  | "claude"
  | "codex"
  | "cursor"
  | "antigravity";

export type WebAgentTarget = "claude_web" | "chatgpt_web" | "gemini_web";
export type AutomaticApiTarget = "gemini_api" | "openai_api";
export type WebAvailability = "unknown" | "available" | "limited";

export type OrchestrationTarget = OrchestrationCliTarget | WebAgentTarget | AutomaticApiTarget;

export type OrchestrationTaskMode = "analyze" | "modify";

export type OrchestrationTaskSpec = {
  id: string;
  title: string;
  target: OrchestrationTarget;
  prompt: string;
  dependsOn: string[];
  mode: "analyze" | "modify";
};

export type OrchestrationPlan = {
  summary: string;
  tasks: OrchestrationTaskSpec[];
};

export type CradleTaskStatus =
  | "queued"
  | "running"
  | "waiting_web"
  | "completed"
  | "failed"
  | "cancelled";

export type CradleTaskState = OrchestrationTaskSpec & {
  status: CradleTaskStatus;
  output: string | null;
  error: string | null;
  fallbackCount: number;
  fallbackFrom: OrchestrationTarget | null;
  fallbackReason: string | null;
  handoffPrompt: string | null;
};

export type ManagerWebStage = "planning" | "synthesis";
export type ManagerWebHandoff = {
  stage: ManagerWebStage;
  target: "claude_web";
  status: "waiting_web" | "fallback_cli";
  prompt: string;
  error: string | null;
};

export type CradleSessionStatus =
  | "planning"
  | "running"
  | "waiting_web"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled";

export type CradleSession = {
  id: string;
  conversationId: string | null;
  originalPrompt: string;
  planSummary: string;
  tasks: CradleTaskState[];
  status: CradleSessionStatus;
  statusMessage: string;
  revisionRound: 0 | 1;
  finalAnswer: string | null;
  error: string | null;
  managerHandoff: ManagerWebHandoff | null;
  webAvailability: Record<WebAgentTarget, WebAvailability>;
  automaticCliTargets: OrchestrationCliTarget[];
  webResearch: WebResearchState;
};


export type WebResearchStatus = "skipped" | "searching" | "ready" | "failed";

export type WebResearchState = {
  status: WebResearchStatus;
  query: string;
  provider: string | null;
  sourceUrls: string[];
  researchPromptBlock: string;
  error: string | null;
};

export type SynthesisEnvelope = {
  finalAnswer: string;
  revisionTasks: OrchestrationTaskSpec[];
};
