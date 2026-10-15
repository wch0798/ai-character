#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("project", nargs="?", default=".", type=Path)
    args = parser.parse_args()
    root = args.project.expanduser().resolve()
    failures: list[str] = []

    def check(condition: bool, message: str) -> None:
        print(("PASS" if condition else "FAIL") + f": {message}")
        if not condition:
            failures.append(message)

    def read(relative: str) -> str:
        path = root / relative
        check(path.is_file(), f"{relative} exists")
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    lib = read("src-tauri/src/lib.rs")
    core = read("src-tauri/src/agent_core.rs")
    commands = read("src-tauri/src/agent_commands.rs")
    workspace = read("src-tauri/src/workspace.rs")
    settings = read("src-tauri/src/settings.rs")
    client = read("src/agent-client.ts")
    main_ts = read("src/main.ts")

    check("const CLAUDE_BIN" not in lib, "hard-coded CLAUDE_BIN removed")
    check("const PROJECT_DIR" not in lib, "hard-coded PROJECT_DIR removed")
    check("PROJECT_DIR" not in lib, "legacy PROJECT_DIR references removed")
    check("/Volumes/백업/AI/AI-Character" not in lib, "hard-coded Mac project path removed")
    check("/opt/homebrew/bin/claude" not in lib, "hard-coded Claude path removed")

    for name in [
        "ask_claude", "run_agent", "cancel_agent", "get_project_dir",
        "set_project_dir", "set_agent_path", "detect_agent",
    ]:
        check(name in lib, f"Tauri handler exposes {name}")

    attachment_names = [
        "inspect_attachment_access",
        "stage_attachment",
        "remove_staged_attachment",
    ]
    if any(name in lib for name in attachment_names):
        for marker in [
            "fn attachment_stage_root(",
            "fn stage_attachment_impl(",
            "fn inspect_attachment_access_impl(",
            "fn inspect_attachment_access(",
            "fn stage_attachment(",
            "fn remove_staged_attachment(",
        ]:
            check(marker in lib, f"attachment implementation preserved: {marker}")

    check("pub enum AgentKind" in core, "common AgentKind exists")
    check("resolve_agent_binary" in core, "agent auto-detection exists")
    check("request_cancel" in core, "agent cancellation exists")
    check("timeout" in core.lower(), "agent timeout exists")
    check("ensure_project_snapshot" in commands, "run_agent supports safe project snapshot")
    check("managed_workspace_permission_args" in core, "managed workspace skips CLI permission prompts")
    check("cursor-agent" in core, "Cursor CLI is searched as cursor-agent")
    check("bypassPermissions" in core, "Claude workspace uses bypassPermissions")
    check("write_agent_context_file" in workspace, "workspace writes sanitized agent context")
    check("is_sensitive_file_name" in workspace and "continue;" in workspace, "snapshot skips secret files")
    check("sync_new_files_into_snapshot" in workspace, "existing conversations import newly added project folders")
    check("이 폴더에 쓸 권한이 없습니다" in commands, "new project folders are probed for write access")
    safe_confirm = (root / "src/safe-confirm.ts").read_text(encoding="utf-8") if (root / "src/safe-confirm.ts").is_file() else ""
    check(
        "confirmSensitiveAgentAccess" in client and "return safeConfirm(" in client and "return true;" in safe_confirm,
        "sensitive-file dialog no longer blocks project runs",
    )
    check('"node_modules"' in workspace and '".git"' in workspace, "snapshot excludes generated/VCS trees")
    check("symlink_metadata" in workspace, "snapshot checks symlinks")
    check("Application Support" in settings and "APPDATA" in settings, "settings cover macOS and Windows")
    check("ensureProjectDirectory" in client, "frontend project folder picker bridge exists")
    check('directory: true' in client, "frontend selects a directory")
    check("askClaudeCompat(" in main_ts or "askCradleCompat(" in main_ts, "chat submit uses common agent bridge")
    conversation_wired = re.search(
        r'(?:askClaudeCompat|askCradleCompat)\s*\([\s\S]{0,1200}?'
        r'[A-Za-z_$][\w$]*\?\.getActiveId\(\)\s*\?\?\s*null',
        main_ts,
    )
    check(conversation_wired is not None, "conversation id forwarded to agent workspace (null-safe)")
    legacy_ask_claude_import = re.search(
        r'import\s*\{[^}]*\baskClaude\b[^}]*\}\s*from\s*["\']\./claude-client["\']',
        main_ts,
    )
    check(legacy_ask_claude_import is None, "legacy askClaude import removed")

    css = root / "src/styles.css"
    if css.is_file():
        css_text = css.read_text(encoding="utf-8")
        check(r"\n\n/* Chat history manager */" not in css_text, "known literal-newline CSS build bug absent")

    if failures:
        print(f"\nRESULT: FAIL ({len(failures)} checks failed)")
        raise SystemExit(1)
    print("\nRESULT: PASS")


if __name__ == "__main__":
    main()
