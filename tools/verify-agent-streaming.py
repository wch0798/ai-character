#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project", nargs="?", type=Path, default=Path("."))
    args = parser.parse_args()
    root = args.project.expanduser().resolve()

    failures = 0

    def check(label: str, condition: bool) -> None:
        nonlocal failures
        if condition:
            print(f"PASS: {label}")
        else:
            print(f"FAIL: {label}")
            failures += 1

    def read(relative: str) -> str:
        path = root / relative
        if not path.is_file():
            return ""
        return path.read_text(encoding="utf-8")

    core = read("src-tauri/src/agent_core.rs")
    commands = read("src-tauri/src/agent_commands.rs")
    client = read("src/agent-client.ts")
    runtime = read("src/agent-runtime-ui.ts")
    main_ts = read("src/main.ts")
    css = read("src/styles.css")
    cargo = read("src-tauri/Cargo.toml")

    check(
        "Rust emits agent-stream events",
        "run_request_streaming" in core
        and 'app.emit("agent-stream"' in commands
        and "AgentStreamPayload" in commands,
    )
    check(
        "frontend listens for agent-stream",
        'listen<AgentStreamEvent>("agent-stream"' in client
        and "event.payload.taskId !== taskId" in client,
    )
    check(
        "runtime UI initialized",
        'import { initializeAgentRuntimeUi } from "./agent-runtime-ui";' in main_ts
        and "initializeAgentRuntimeUi();" in main_ts
        and "export function initializeAgentRuntimeUi" in runtime,
    )
    check(
        "stop button wired",
        '"agent-stop-button"' in runtime
        and "cancelAgent(activeTaskId)" in runtime,
    )
    check(
        "runtime CSS present",
        "/* AI-Character Agent runtime streaming */" in css
        and "#agent-runtime-panel" in css
        and "#agent-stop-button" in css,
    )
    check(
        "serde derive dependency present",
        any(
            line.strip().startswith("serde =")
            for line in cargo.splitlines()
        ),
    )

    if failures:
        print(f"\nRESULT: FAIL ({failures} checks failed)")
        return 1

    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
