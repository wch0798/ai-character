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

    engine = read("src-tauri/src/workspace_changes.rs")
    workspace = read("src-tauri/src/workspace.rs")
    commands = read("src-tauri/src/agent_commands.rs")
    lib = read("src-tauri/src/lib.rs")
    client = read("src/agent-client.ts")
    runtime = read("src/agent-runtime-ui.ts")
    css = read("src/styles.css")
    cargo = read("src-tauri/Cargo.toml")

    check(
        "workspace change engine present",
        "pub fn list_workspace_changes" in engine
        and "pub fn workspace_file_diff" in engine
        and "WorkspaceChangeKind" in engine
        and "similar::TextDiff" in engine,
    )
    check(
        "workspace change handlers exposed",
        all(
            name in commands and name in lib
            for name in [
                "get_workspace_changes",
                "get_workspace_diff",
                "apply_workspace_changes",
                "discard_workspace_changes",
            ]
        ),
    )
    check(
        "frontend change bridge present",
        all(
            token in client
            for token in [
                "getWorkspaceChanges",
                "getWorkspaceDiff",
                "applyWorkspaceChanges",
                "discardWorkspaceChanges",
                "conversationId: options.conversationId ?? null",
            ]
        ),
    )
    check(
        "change review UI present",
        all(
            token in runtime
            for token in [
                '"agent-change-panel"',
                '"agent-change-list"',
                '"agent-diff-output"',
                '"agent-apply-button"',
                '"agent-discard-button"',
                '"원본에 적용"',
            ]
        ),
    )
    check(
        "checkpoint apply/discard present",
        'join("checkpoints")' in engine
        and "rollback_from_checkpoint" in engine
        and "reset_project_snapshot" in workspace
        and "discard_workspace_changes" in engine,
    )
    check(
        "unsafe relative paths rejected",
        "Component::ParentDir" in engine
        and "Component::RootDir" in engine
        and "Component::Prefix" in engine,
    )
    check(
        "protected/generated trees excluded",
        all(token in engine for token in ['".ai-character"', '".ai-character-backup"', '".git"', '"node_modules"', '"target"', '"dist"']),
    )
    check(
        "new project folders import into existing snapshots",
        "fn sync_new_files_into_snapshot" in workspace
        and "merge_imported_into_baseline" in workspace,
    )
    check(
        "change review CSS present",
        "/* AI-Character workspace change review */" in css
        and "#agent-change-panel" in css
        and "#agent-diff-output" in css,
    )
    check(
        "similar dependency present",
        any(line.strip().startswith("similar =") for line in cargo.splitlines()),
    )

    if failures:
        print(f"\nRESULT: FAIL ({failures} checks failed)")
        return 1

    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
