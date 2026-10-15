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
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    workspace = read("src-tauri/src/workspace.rs")
    changes = read("src-tauri/src/workspace_changes.rs")
    client = read("src/agent-client.ts")
    runtime = read("src/agent-runtime-ui.ts")
    css = read("src/styles.css")
    cargo = read("src-tauri/Cargo.toml")
    core = read("src-tauri/src/agent_core.rs")

    check(
        "baseline manifest present",
        'join("project-baseline.tsv")' in workspace
        and "pub fn load_project_baseline" in workspace
        and "Sha256" in workspace,
    )
    check(
        "agent changes derive from baseline",
        "load_project_baseline" in changes
        and "workspace_entry_matches_baseline" in changes
        and "paths.extend(baseline.keys().cloned())" in changes
        and "paths.extend(original_files.keys()" not in changes,
    )
    check(
        "external edits flagged as conflicts",
        "pub conflict: bool" in changes
        and "pub conflict_reason: Option<String>" in changes
        and "baseline_entry_matches_path" in changes
        and "원본이 작업 시작 후 변경되었습니다" in changes,
    )
    check(
        "conflicted apply blocked",
        "충돌이 있는 변경은 원본에 적용할 수 없습니다" in changes
        and ".filter(|change| change.conflict)" in changes,
    )
    check(
        "frontend conflict warning present",
        "conflict: boolean" in client
        and "conflictReason: string | null" in client
        and 'button.dataset.conflict = change.conflict ? "true" : "false"' in runtime
        and "원본이 밖에서 바뀌어 적용할 수 없습니다" in runtime
        and "applyButton.disabled = hasConflicts" in runtime,
    )
    check(
        "conflict CSS present",
        "/* AI-Character workspace conflict warnings */" in css
        and '.agent-change-item[data-conflict="true"]' in css,
    )
    check(
        "sha2 dependency present",
        any(line.strip().startswith("sha2 =") for line in cargo.splitlines()),
    )
    check(
        "legacy unused run_request wrapper removed",
        "pub fn run_request(request: &AgentRequest)" not in core,
    )

    if failures:
        print(f"\nRESULT: FAIL ({failures} checks failed)")
        return 1
    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
