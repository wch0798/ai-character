# CRADLE Hybrid Orchestration Design

**Date:** 2026-09-16  
**Scope:** Web-first Claude-led orchestration across human-in-the-loop Claude/ChatGPT/Gemini web agents with CLI workers used only when local modification or fallback requires them.

## 1. Goal

Turn AI-Character from a single-agent launcher into a CRADLE orchestration environment where Claude acts as lead manager, decomposes a user request into sub-tasks, routes work to the most suitable agent, collects results, requests one bounded revision cycle when necessary, and synthesizes the final answer.

The primary cost constraint is that Claude, ChatGPT, and Gemini should use their normal consumer web experiences before CLI usage. CLI agents remain automatic workers for local project modification and bounded fallback when a Web Agent is unavailable.

## 2. User-visible architecture

```text
User
  ↓
AI-Character
  ↓
CRADLE Manager
  ↓
Claude Web Lead Manager
  ├─ Claude Web   → planning / synthesis
  ├─ ChatGPT Web  → critique / alternative view
  ├─ Gemini Web   → research / broad analysis
  ├─ Codex CLI    → code implementation
  ├─ Cursor CLI   → UI / project edits
  ├─ Claude CLI   → manager / synthesis / fallback worker
  └─ other CLI adapters already supported
  ↓
Result collection
  ↓
Claude review
  ↓
optional single revision round
  ↓
final answer shown to user
```

Reference infographic: `docs/assets/cradle-orchestration.png`.

## 3. Non-goals and constraints

- No OpenAI API or Gemini API is required for v22.
- Do not scrape ChatGPT or Gemini DOM/output automatically.
- Web agents are human-in-the-loop handoffs: CRADLE prepares the prompt, opens the site, copies the prompt, and accepts the user-pasted response.
- Existing workspace/diff/checkpoint/conflict/sensitive-file protections remain unchanged.
- Existing single-agent mode remains available as a fallback.
- Maximum one automatic review/revision round in v22 to avoid loops.
- Maximum 8 subtasks per orchestration plan.
- A failed optional worker must not destroy completed worker results.

## 4. New concepts

### 4.1 Orchestration agent target

```ts
type OrchestrationTarget =
  | "claude_web"
  | "claude"
  | "codex"
  | "cursor"
  | "antigravity"
  | "chatgpt_web"
  | "gemini_web";
```

CLI targets are executed through the existing `run_agent` path. Web targets become pending handoff tasks.

### 4.2 Orchestration plan

Claude returns strict JSON using this shape:

```json
{
  "summary": "what the overall task is",
  "tasks": [
    {
      "id": "task-1",
      "title": "short title",
      "target": "gemini_web",
      "mode": "analyze",
      "prompt": "self-contained worker prompt",
      "dependsOn": []
    }
  ]
}
```

Validation rules:

- 1–8 tasks;
- unique simple IDs;
- only supported targets;
- dependency IDs must exist;
- dependency graph must be acyclic;
- `mode` must be `analyze` or `modify`;
- prompts and titles have bounded lengths;
- an invalid manager response fails clearly rather than executing arbitrary text.

### 4.3 Orchestration session

A frontend session tracks:

- session ID;
- conversation ID;
- original user prompt;
- Claude-generated plan;
- each subtask state (`queued`, `waiting_web`, `running`, `completed`, `failed`);
- worker output;
- final synthesis output;
- one optional review/revision round.

v22 keeps this session in frontend memory. Durable orchestration persistence can be added later without blocking the first functional flow.

## 5. Data flow

### 5.1 Start

1. User submits a request in orchestration mode.
2. AI-Character calls the Claude manager using the existing safe workspace and preferences.
3. The manager receives a system-style orchestration instruction requesting strict JSON only.
4. CRADLE validates the JSON plan before any worker is run.

### 5.2 Automatic CLI tasks

When dependencies are satisfied, CLI tasks use `runAgentTask()` with the existing project snapshot, timeout, model, streaming, cancellation, run-history, and sensitive-file mechanisms.

Independent analysis-only CLI tasks may execute in parallel, capped at two concurrent automatic workers in v22. Project-modifying CLI tasks are serialized because they share the same conversation snapshot.

### 5.3 Web tasks

For `claude_web`, `chatgpt_web`, and `gemini_web`:

1. task becomes `waiting_web`;
2. CRADLE shows task title and prepared prompt;
3. user can click `웹 열기`; AI-Character invokes a fixed-target Tauri command that asks the OS to open the known ChatGPT/Gemini URL;
4. user can click `프롬프트 복사`;
5. user uses the normal web UI and copies the answer;
6. user pastes the answer into CRADLE and clicks `결과 전달`;
7. task becomes `completed` and dependent tasks can continue.

URLs:

- Claude: `https://claude.ai/`
- ChatGPT: `https://chatgpt.com/`
- Gemini: `https://gemini.google.com/app`

Opening a website is explicit user action. v22 does not programmatically send messages or extract page content.

## 6. Claude manager prompts

### Planning prompt

The manager is told to:

- prefer no more than necessary workers;
- use `gemini_web` for research/broad alternative analysis;
- use `chatgpt_web` for critique, alternative solutions, and review;
- use `codex` for code-heavy implementation when available;
- use `cursor` for project/UI editing when available;
- use `claude` for coordination, synthesis, or a task that benefits from the same manager model;
- make each task prompt self-contained;
- output JSON only.

### Synthesis prompt

After all tasks finish, Claude receives:

- original request;
- plan summary;
- labeled worker outputs;
- failed-task summaries if any.

It returns the user-facing final result and optionally a JSON `revisionTasks` list. Only one revision round is honored in v22.

## 7. UI

Settings gains a persisted `CRADLE 자동 분배` toggle (enabled by default), and the chat runtime gains a dedicated orchestration section when a CRADLE session starts.

```text
[ CRADLE 자동 분배 ON ]

CRADLE 작업
├ Claude Manager      완료
├ Gemini Web 조사      응답 대기  [웹 열기] [복사]
├ Codex 구현           실행 중
└ ChatGPT 검토         대기

[Gemini 응답 붙여넣기........................]
[결과 전달]
```

The normal single-agent badge remains visible. In CRADLE mode it displays `CRADLE · Claude Web 우선 총괄`.

Web handoff controls appear only for the currently waiting web tasks.

## 8. Error handling

- Manager JSON parse/validation failure: stop orchestration and show a manager-plan error; do not execute partial malformed tasks.
- CLI failure: record failed state and continue other independent tasks; Claude synthesis receives the failure summary.
- Web task can be skipped explicitly. A skipped task is treated as failed with a user-provided reason.
- Cancellation stops active CLI tasks and marks queued tasks cancelled.
- Empty web response is rejected.
- Synthesis failure leaves all worker outputs visible so the user can retry synthesis without re-running workers.

## 9. Security and safety

- All CLI workers use the existing conversation workspace, never the original project directly.
- Existing sensitive-file acknowledgement applies before orchestration starts.
- Web handoff prompts must not automatically include contents of files identified as sensitive. v22 sends only the manager-generated worker prompt and summaries supplied by the manager.
- No browser session cookies, account credentials, DOM content, or auth tokens are accessed by AI-Character.
- Clipboard write happens only after an explicit `프롬프트 복사` click.

## 10. Testing

Required tests:

- strict plan parser accepts valid plans;
- rejects unsupported targets, duplicate IDs, missing dependencies, cycles, >8 tasks;
- scheduler releases only dependency-satisfied tasks;
- web tasks stop in `waiting_web` until a non-empty response is submitted;
- CLI and web results are included in synthesis context;
- revision round is capped at one;
- existing single-agent tests continue passing;
- TypeScript `strict`/`noUnused` passes;
- patch is idempotent and v21 → v22 verifier passes.

## 11. Incremental delivery

v22 delivers the complete first useful hybrid orchestration loop: plan → automatic CLI work + web handoffs → collect → Claude synthesis → optional one revision round.

Later versions may add persistent orchestration history, richer parallel scheduling, provider-specific availability detection, and optional official APIs, but those are not required for v22.


## 12. Web-first amendment

- Claude Web is the default planning and synthesis manager path.
- Analysis tasks assigned to CLI targets are normalized to their Web counterpart unless that Web Agent has been marked limited in the current app session.
- Local `modify` work remains CLI-backed because consumer Web agents cannot directly edit the managed workspace.
- A user can mark a waiting Web Agent as `한도 초과/사용 불가`; CRADLE then uses an installed CLI fallback.
- CLI errors matching quota/rate/usage-limit markers trigger at most one corresponding Web fallback.
- CRADLE does not claim to know exact remaining consumer-Web quotas; availability is learned from successful pasted responses or explicit user limit feedback.
