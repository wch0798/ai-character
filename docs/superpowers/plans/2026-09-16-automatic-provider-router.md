# Automatic Provider Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a background automatic provider router that prefers free official Gemini API, retains Jina web research, uses existing CLI workers for local modifications, optionally enables paid OpenAI API, and falls back to existing Web handoff when automatic providers are unavailable.

**Architecture:** Add a focused Rust `provider_router` module for API provider status, quota classification, and text generation. Add a TypeScript client and extend CRADLE targets with `gemini_api`/`openai_api`; planning/synthesis uses automatic providers first, modify tasks keep using CLI, and manual Web handoff remains the last fallback.

**Tech Stack:** Tauri 2, Rust, reqwest, serde/serde_json, TypeScript, existing CRADLE orchestration engine.

**Spec:** Conversation-approved v24 Automatic Provider Router design.

## Global Constraints

- API keys are read from environment variables only and are never persisted.
- `GEMINI_API_KEY` powers the free-first automatic provider.
- OpenAI API is opt-in and disabled by default even when `OPENAI_API_KEY` exists.
- Local file modification remains a CLI/workspace operation; API/Web providers may analyze or return patches but do not directly mutate the original project.
- Provider quota/limit failures are remembered for the current app session and trigger fallback instead of loops.
- Existing single-Agent mode, workspace safety, diff/checkpoint/conflict detection, and v23 web research remain intact.

---

### Task 1: Backend automatic provider API

**Files:**
- Create: `src-tauri/src/provider_router.rs`
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/agent_commands.rs`
- Modify via patcher: target `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`
- Test: `tests/test_automatic_provider_router_patch.py`

**Interfaces:**
- Produces Tauri commands `get_automatic_provider_status` and `run_automatic_provider`.
- Provider IDs: `gemini_api`, `openai_api`.

- [x] Write failing contract tests for environment-only keys, Gemini REST endpoint, OpenAI Responses endpoint, quota classification, and paid OpenAI opt-in.
- [x] Run the focused test and confirm RED.
- [x] Implement `provider_router.rs` and preference persistence.
- [x] Run the focused test and confirm GREEN.

### Task 2: TypeScript router client and CRADLE targets

**Files:**
- Create: `src/automatic-provider.ts`
- Modify: `src/orchestration-types.ts`
- Modify: `src/orchestration-plan.ts`
- Test: `tests/test_automatic_provider_router_patch.py`

**Interfaces:**
- `getAutomaticProviderStatuses()`
- `runAutomaticProvider(provider, prompt)`
- `AutomaticApiTarget = "gemini_api" | "openai_api"`

- [x] Extend failing tests for types/parser/client commands.
- [x] Run focused tests and confirm RED.
- [x] Implement client and target parsing.
- [x] Run focused tests and confirm GREEN.

### Task 3: Automatic CRADLE routing and fallback

**Files:**
- Modify: `src/orchestration-engine.ts`
- Modify: `src/orchestration-ui.ts`
- Test: `tests/test_automatic_provider_router_patch.py`

**Interfaces:**
- Manager planning/synthesis automatic order: Gemini API -> Claude CLI -> optional OpenAI API -> Claude Web handoff.
- Analyze worker order prefers available Gemini API; modify workers stay CLI-first; quota failure falls back once.

- [x] Write failing tests for automatic manager, analyze normalization, quota memory, and manual Web fallback.
- [x] Run focused tests and confirm RED.
- [x] Implement minimal routing changes.
- [x] Run focused tests and confirm GREEN.

### Task 4: Settings UI and verification

**Files:**
- Modify: `src/settings-ui.ts`
- Modify: `src/agent-client.ts`
- Create: `tools/verify-automatic-provider-router.py`
- Modify: `tools/apply-ai-character-foundation.py`
- Test: `tests/test_automatic_provider_router_patch.py`

**Interfaces:**
- Preference `geminiApiEnabled` defaults true.
- Preference `allowPaidOpenAiApi` defaults false.

- [x] Add failing tests for settings controls and patcher wiring.
- [x] Run focused tests and confirm RED.
- [x] Implement settings UI, patcher wiring, and verifier.
- [x] Run focused tests and confirm GREEN.

### Task 5: Full regression and package

**Files:**
- Update: `README-APPLY.md`
- Regenerate: `SOURCE-MANIFEST.sha256`

- [x] Run all Python regression tests and bundle contract tests.
- [x] Run TypeScript strict/noUnused fixture.
- [x] Apply v24 to a v23.1 integration fixture, run all verifiers, and verify second apply changes 0 files.
- [x] Regenerate source manifest, create ZIP, verify ZIP contents/checksums, record SHA-256.
