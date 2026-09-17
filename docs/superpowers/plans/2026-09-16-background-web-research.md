# CRADLE Background Web Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, background web research grounding to CRADLE.

**Architecture:** A Rust `web_search` module calls the fixed Jina Search endpoint with an API key supplied only through `JINA_API_KEY`. A TypeScript `web-research` module decides when to search, wraps results as untrusted reference material, and feeds the same bounded context into CRADLE planning, worker handoffs, and synthesis.

**Tech Stack:** Tauri/Rust, reqwest, TypeScript, existing settings and CRADLE modules.

**Spec:** `docs/superpowers/specs/2026-09-16-background-web-research-design.md`

## Global Constraints

- Never persist or log `JINA_API_KEY`.
- No consumer AI DOM scraping.
- Search failure is non-fatal.
- One background search per CRADLE request.
- Existing single-agent mode and workspace protections remain unchanged.

---

### Task 1: Web search backend

**Files:**
- Create: `src-tauri/src/web_search.rs`
- Modify: `src-tauri/src/lib.rs` through patcher
- Modify: `src-tauri/Cargo.toml` through patcher
- Test: `tests/test_background_web_search_patch.py`

**Interfaces:**
- Produces Tauri command `search_web_background(query, max_chars) -> WebSearchResponse`.

- [ ] Write failing contract tests for fixed provider URL, env-only key, limits, and command registration.
- [ ] Run the tests and verify RED.
- [ ] Implement the Rust module and Cargo dependency patch.
- [ ] Run the tests and verify GREEN.

### Task 2: Frontend research policy and prompt isolation

**Files:**
- Create: `src/web-research.ts`
- Modify: `src/orchestration-types.ts`
- Modify: `src/orchestration-engine.ts`
- Test: `tests/test_background_web_search_patch.py`

**Interfaces:**
- Produces `shouldAutoWebSearch`, `collectWebResearch`, and `buildUntrustedWebResearchBlock`.

- [ ] Write failing tests for intent detection, non-fatal failure, and injection-isolation wording.
- [ ] Run RED.
- [ ] Implement the policy module and CRADLE integration.
- [ ] Run GREEN.

### Task 3: Preference and settings UI

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/agent_commands.rs`
- Modify: `src/agent-client.ts`
- Modify: `src/settings-ui.ts`
- Test: `tests/test_background_web_search_patch.py`

**Interfaces:**
- Adds persisted `autoWebSearch: boolean`, default true.

- [ ] Write failing preference/UI contract tests.
- [ ] Run RED.
- [ ] Add round-trip setting and UI checkbox/help.
- [ ] Run GREEN.

### Task 4: Patch/verification/package

**Files:**
- Modify: `tools/apply-ai-character-foundation.py`
- Create: `tools/verify-background-web-search.py`
- Modify: `README-APPLY.md`

**Interfaces:**
- v22.2 -> v23 idempotent upgrade.

- [ ] Add failing patch/verifier expectations.
- [ ] Implement source copying, Cargo/lib registration, verifier and docs.
- [ ] Run full Python regression, bundle contract, TypeScript strict/noUnused, integration fixture, second-apply checksum, manifest, ZIP integrity.
