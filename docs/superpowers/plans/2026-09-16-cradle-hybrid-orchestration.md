# CRADLE Hybrid Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Web-first Claude-led CRADLE orchestration loop that uses Claude/ChatGPT/Gemini consumer web UIs first and spends CLI capacity mainly on local modification or bounded fallback.

**Architecture:** Keep the existing `run_agent` path as the only CLI process executor. Add a focused TypeScript orchestration engine that asks Claude for a strict JSON plan, validates/schedules tasks, converts ChatGPT/Gemini tasks into human-in-the-loop web handoffs, and asks Claude for final synthesis. UI integration lives in a separate orchestration panel so single-agent runtime behavior remains intact.

**Tech Stack:** TypeScript, Tauri invoke/event bridge, existing Rust agent commands, browser opener plugin, clipboard Web API, Python patch/verifier tests.

**Spec:** `docs/superpowers/specs/2026-09-16-cradle-hybrid-orchestration-design.md`

## Global Constraints

- Claude/ChatGPT/Gemini consumer web experiences are used without API calls.
- Web is preferred for planning, analysis, critique, and synthesis; CLI is preferred only for local modify work or Web fallback.
- No DOM scraping, cookie access, or automatic message extraction.
- CLI work continues through the existing safe conversation workspace.
- Maximum 8 planned tasks.
- Maximum 2 concurrent CLI workers.
- Maximum 1 revision round.
- Existing single-agent mode remains available.

---

### Task 1: Plan protocol and validator

**Files:**
- Create: `src/orchestration-types.ts`
- Create: `src/orchestration-engine.ts`
- Test: `tests/test_cradle_orchestration_patch.py`

**Interfaces:**
- Produces `OrchestrationTarget`, `OrchestrationTaskSpec`, `OrchestrationPlan`, `parseOrchestrationPlan(raw: string)`.

- [ ] **Step 1: Write failing plan-contract tests** covering valid JSON, unsupported target, duplicate task ID, missing dependency, cycle, and >8 tasks.
- [ ] **Step 2: Run the focused test and verify RED** because orchestration files do not exist.
- [ ] **Step 3: Implement strict parsing and graph validation** with bounded title/prompt sizes and supported targets only.
- [ ] **Step 4: Run focused tests and verify GREEN.**

### Task 2: Scheduler and web handoff state

**Files:**
- Modify: `src/orchestration-engine.ts`
- Test: `tests/test_cradle_orchestration_patch.py`

**Interfaces:**
- Produces `CradleSession`, `CradleTaskState`, dependency-ready task selection, web-response submission, skip handling, and one-round revision guard.

- [ ] **Step 1: Write failing scheduler tests** asserting dependencies, `waiting_web`, non-empty web response, skip behavior, and revision round cap.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement session state transitions** without modifying CLI execution code.
- [ ] **Step 4: Run focused tests and verify GREEN.**

### Task 3: Claude manager prompts and CLI execution integration

**Files:**
- Modify: `src/orchestration-engine.ts`
- Modify: `src/agent-client.ts`
- Test: `tests/test_cradle_orchestration_patch.py`

**Interfaces:**
- Consumes existing `runAgentTask()` and `getAppPreferences()`.
- Produces `startCradleOrchestration()`, `resumeCradleSession()`, `retryCradleSynthesis()`.

- [ ] **Step 1: Write failing tests** proving the planning prompt requests strict JSON, CLI targets route through existing agent task execution, worker results are labeled in synthesis context, and revision is capped at one.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement Claude planning/synthesis calls and max-2 CLI scheduler.**
- [ ] **Step 4: Run focused tests and verify GREEN.**

### Task 4: Web-agent handoff utilities

**Files:**
- Create: `src/web-agent-handoff.ts`
- Test: `tests/test_cradle_web_handoff_patch.py`

**Interfaces:**
- Produces `openWebAgent(target)`, `copyWebAgentPrompt(prompt)`, URL mapping for ChatGPT/Gemini.

- [ ] **Step 1: Write failing tests** for `https://chatgpt.com/`, `https://gemini.google.com/app`, explicit open action, and explicit clipboard-copy action.
- [ ] **Step 2: Run tests and verify RED.**
- [ ] **Step 3: Implement browser open via Tauri opener and clipboard write on click only.**
- [ ] **Step 4: Run tests and verify GREEN.**

### Task 5: CRADLE UI

**Files:**
- Create: `src/orchestration-ui.ts`
- Modify: `src/agent-runtime-ui.ts`
- Modify via patcher: `src/styles.css`, `src/main.ts`
- Test: `tests/test_cradle_orchestration_ui_patch.py`

**Interfaces:**
- Produces `initializeCradleOrchestrationUi()` and DOM events that take over chat submission only when CRADLE mode is enabled.

- [ ] **Step 1: Write failing UI contract tests** for mode toggle, manager badge, task list, web open/copy/paste/submit controls, cancel, synthesis retry, and no overlap with existing toolbar.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement compact UI** preserving normal chat behavior when the toggle is off.
- [ ] **Step 4: Run focused tests and TypeScript strict/noUnused.**

### Task 6: Patch application and verification

**Files:**
- Modify: `tools/apply-ai-character-foundation.py`
- Create: `tools/verify-cradle-orchestration.py`
- Modify: `tools/run-bundle-tests.py`
- Modify: `README-APPLY.md`

**Interfaces:**
- Installs new TS modules, main initialization, CSS, verifier, docs, and infographic.

- [ ] **Step 1: Write failing patch/idempotency tests** for v21 → v22.
- [ ] **Step 2: Implement patch copy/main/CSS integration.**
- [ ] **Step 3: Apply to a v21-like fixture and run all old verifiers plus the CRADLE verifier.**
- [ ] **Step 4: Apply v22 a second time and verify zero changes.**

### Task 7: Final regression and artifact packaging

**Files:**
- Update: `SOURCE-MANIFEST.sha256`
- Package: `AI-Character-foundation-source-patch-2026-09-16-v22.zip`

**Interfaces:** None.

- [ ] **Step 1: Run all Python regression tests and bundle contracts.**
- [ ] **Step 2: Run TypeScript strict/noUnused fixture.**
- [ ] **Step 3: Run source-manifest verification and ZIP integrity verification.**
- [ ] **Step 4: Record limitations: Rust/macOS final compile remains user-side if toolchain is unavailable.**


### Task 8: Web-first routing and quota-aware fallback

**Files:**
- Modify: `src/orchestration-types.ts`
- Modify: `src/orchestration-engine.ts`
- Modify: `src/orchestration-ui.ts`
- Modify: `src/web-agent-handoff.ts`
- Modify: `src-tauri/src/agent_commands.rs`
- Test: `tests/test_cradle_web_first_policy.py`

**Interfaces:**
- Produces `claude_web`, Web availability state, Claude Web manager handoff, analysis normalization, explicit Web→CLI fallback, and bounded CLI-quota→Web fallback.

- [x] Write failing Web-first policy tests and verify RED.
- [x] Add Claude Web allowlisted launcher and labels.
- [x] Route planning/synthesis through Claude Web first with explicit CLI fallback.
- [x] Normalize analysis tasks to Web targets while keeping local modify tasks on CLI.
- [x] Add Web-limit feedback and bounded CLI quota fallback.
- [x] Run focused tests, full Python regression, bundle contracts, and TypeScript strict/noUnused.
