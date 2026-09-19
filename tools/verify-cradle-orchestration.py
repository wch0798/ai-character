#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path


def check(condition: bool, label: str, failures: list[str]) -> None:
    if condition:
        print(f"PASS: {label}")
    else:
        print(f"FAIL: {label}")
        failures.append(label)


def read(root: Path, relative: str) -> str:
    path = root / relative
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project", nargs="?", default=".", type=Path)
    args = parser.parse_args()
    root = args.project.expanduser().resolve()
    failures: list[str] = []

    types = read(root, "src/orchestration-types.ts")
    plan = read(root, "src/orchestration-plan.ts")
    engine = read(root, "src/orchestration-engine.ts")
    handoff = read(root, "src/web-agent-handoff.ts")
    ui = read(root, "src/orchestration-ui.ts")
    client = read(root, "src/agent-client.ts")
    settings = read(root, "src-tauri/src/settings.rs")
    commands = read(root, "src-tauri/src/agent_commands.rs")
    lib = read(root, "src-tauri/src/lib.rs")
    main_ts = read(root, "src/main.ts")
    styles = read(root, "src/styles.css")
    settings_ui = read(root, "src/settings-ui.ts")

    check("claude_web" in types and "chatgpt_web" in types and "gemini_web" in types, "Web Agent target types", failures)
    check("parseOrchestrationPlan" in plan and "topologicalLayers" in plan, "strict orchestration plan validation", failures)
    check("runClaudeManagerWebFirst" in engine and "createPlanningPrompt" in engine, "Claude Web-first manager orchestration", failures)
    check("MAX_AUTOMATIC_CLI_WORKERS = 4" in engine and 'mode === "modify"' in engine, "bounded automatic CLI scheduling", failures)
    check("availableModifyCliTargets" in engine and "CLI_SPREAD_ORDER" in engine, "CRADLE spreads file work across Cursor and other CLIs", failures)
    check("revisionRound === 0" in engine and "session.revisionRound = 1" in engine, "single revision round cap", failures)
    check("cancelCradleOrchestration" in engine and "activeCliTaskIds" in engine and "cancelAgent" in engine, "CRADLE session cancellation", failures)
    check("retryCradleSynthesis" in engine and "canRetrySynthesis" in engine, "synthesis-only retry without rerunning workers", failures)
    check('claude_web: "Claude Web"' in handoff and "open_web_agent" in handoff, "Claude Web handoff", failures)
    check('chatgpt_web: "ChatGPT Web"' in handoff and "open_web_agent" in handoff, "ChatGPT Web handoff", failures)
    check('gemini_web: "Gemini Web"' in handoff and "navigator.clipboard.writeText" in handoff, "Gemini Web handoff", failures)
    check("한 번에 열기+복사" in ui and "웹 열기" in ui and "프롬프트 복사" in ui and "결과 전달" in ui and "한도 초과/사용 불가" in ui, "human-in-the-loop Web fallback controls", failures)
    check("prepareWebAgentHandoff" in handoff and "prepareWebAgentHandoff" in ui, "one-click web handoff prepare", failures)
    check("normalizePlanForWebFirst" in engine and "fallbackWebTaskToCli" in engine and "isQuotaOrLimitError" in engine, "Web-first routing and bounded fallback", failures)
    check("CRADLE 중지" in ui and "합성 다시 시도" in ui and "닫기" in ui, "CRADLE stop, retry, and close controls", failures)
    check("cradleEnabled: boolean" in client and "emitRuntimeEvents?: boolean" in client, "frontend CRADLE preference and silent workers", failures)
    check("pub cradle_enabled: bool" in settings and "cradle_enabled: true" in settings, "CRADLE preference persisted and enabled by default", failures)
    check("pub fn open_web_agent" in commands and "open_preferred_for_target" in read(root, "src-tauri/src/web_accounts.rs"), "backend opens isolated preferred account windows", failures)
    check("open_web_agent" in lib, "Tauri handler exposes web launcher", failures)
    check("askCradleCompat" in main_ts and "initializeCradleOrchestrationUi" in main_ts, "chat routed through CRADLE compatibility layer", failures)
    check("AI-Character CRADLE orchestration" in styles and "#ai-cradle-panel" in styles, "CRADLE narrow-window styles", failures)
    check("CRADLE 자동 분배" in settings_ui and "cradleEnabled: cradleCheckbox.checked" in settings_ui, "settings expose CRADLE toggle", failures)
    check((root / "docs/assets/cradle-orchestration.png").is_file(), "CRADLE architecture infographic installed", failures)

    if failures:
        print("\nRESULT: FAIL")
        return 1
    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
