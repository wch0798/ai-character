#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


def check(ok: bool, label: str, failures: list[str]) -> None:
    if ok:
        print(f"PASS: {label}")
    else:
        print(f"FAIL: {label}")
        failures.append(label)


def read(root: Path, relative: str) -> str:
    path = root / relative
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").expanduser().resolve()
    failures: list[str] = []

    settings = read(root, "src-tauri/src/settings.rs")
    commands = read(root, "src-tauri/src/agent_commands.rs")
    core = read(root, "src-tauri/src/agent_core.rs")
    client = read(root, "src/agent-client.ts")
    runtime = read(root, "src/agent-runtime-ui.ts")
    settings_ui = read(root, "src/settings-ui.ts")
    styles = read(root, "src/styles.css")

    check("agent_extra_args" in settings, "per-agent CLI args persisted", failures)
    check("settings.agent_extra_args(agent)" in commands, "per-agent CLI args reach execution", failures)
    check("args_for_with_options" in core and "request.extra_args" in core, "AgentRequest prepends extra args", failures)
    check("claude_plugin_dir_args" in core and "--plugin-dir" in core, "Claude plugin dirs are passed through", failures)
    check("sanitize_claude_extra_args" in core and "--bare" in core, "Claude --bare is stripped so plugins load", failures)
    check("agentExtraArgs" in client and "agentExtraArgs" in settings_ui, "frontend edits per-agent CLI args", failures)
    check("ai-agent-advanced" in settings_ui and "보통은 비워두세요" in settings_ui, "extra CLI args collapsed under advanced options", failures)
    check("고급 옵션 · ${count}개 설정됨" in settings_ui, "saved CLI arg count is surfaced", failures)
    check("AI-Character compact agent advanced options" in styles and "grid-template-columns: minmax(0, 1fr) auto" in styles, "agent settings cards use narrow-window layout", failures)
    check("agent-runtime-agent" in runtime, "current Agent badge exists", failures)
    check("ai-character:preferences-updated" in runtime and "ai-character:preferences-updated" in settings_ui, "Agent badge updates after preference save", failures)
    check("userFacingAgentError" in client and "userMessage" in client, "friendly Agent error mapping exists", failures)
    check("agent-runtime-details" in runtime and "기술 로그" in runtime, "technical error details are separated", failures)
    check("AI-Character agent experience v17" in styles, "v17 Agent experience styles installed", failures)

    vite_path = next((root / name for name in ("vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs") if (root / name).is_file()), None)
    vite = vite_path.read_text(encoding="utf-8") if vite_path else ""
    check(vite_path is not None, "Vite config found", failures)
    check("AI-Character Vite 8 chunking" in vite, "Vite 8 code splitting configured", failures)
    check("codeSplitting" in vite and "maxSize: 280000" in vite, "vendor chunks capped for build splitting", failures)
    check("strictExecutionOrder: true" in vite, "chunk execution order preserved", failures)

    if failures:
        print(f"\nRESULT: FAIL ({len(failures)} checks failed)")
        return 1
    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
