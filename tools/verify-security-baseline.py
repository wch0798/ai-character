#!/usr/bin/env python3
"""보안/비밀 파일 노출 기본 점검."""
from __future__ import annotations

import sys
from pathlib import Path


SENSITIVE_NAMES = {
    "keys.env",
    ".env",
    "credentials.json",
    "service-account.json",
    "auth.json",
}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    failures: list[str] = []

    gitignore = (root / ".gitignore").read_text(encoding="utf-8")
    for needle in ("keys.env", ".ai-character/", ".ai-character-backup/", "src-tauri/target/"):
        ok = needle in gitignore
        print(("PASS" if ok else "FAIL") + f": .gitignore has {needle}")
        if not ok:
            failures.append(needle)

    tauri = (root / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    csp_ok = '"csp": null' not in tauri and "default-src" in tauri and "wasm-unsafe-eval" in tauri
    print(("PASS" if csp_ok else "FAIL") + ": CSP configured (includes wasm-unsafe-eval)")
    if not csp_ok:
        failures.append("csp")

    id_ok = '"identifier": "local.ai.character"' in tauri
    print(("PASS" if id_ok else "FAIL") + ": bundle identifier is local.ai.character")
    if not id_ok:
        failures.append("identifier")

    server = (root / "usage-dashboard" / "server.mjs").read_text(encoding="utf-8")
    listen_ok = ".listen(PORT, '127.0.0.1'" in server or '.listen(PORT, "127.0.0.1"' in server
    host_ok = "local only" in server or "Forbidden" in server
    print(("PASS" if listen_ok else "FAIL") + ": usage dashboard binds 127.0.0.1")
    print(("PASS" if host_ok else "FAIL") + ": usage dashboard rejects non-local Host")
    if not listen_ok:
        failures.append("listen")
    if not host_ok:
        failures.append("host")

    workspace = (root / "src-tauri" / "src" / "workspace.rs").read_text(encoding="utf-8")
    skip_ok = "is_sensitive_file_name" in workspace and "keys.env" in workspace
    print(("PASS" if skip_ok else "FAIL") + ": workspace skips sensitive files")
    if not skip_ok:
        failures.append("workspace-sensitive")

    agent_cmds = (root / "src-tauri" / "src" / "agent_commands.rs").read_text(encoding="utf-8")
    path_guard = "assert_agent_path_allowed" in agent_cmds and "프로젝트 폴더 밖" in agent_cmds
    print(("PASS" if path_guard else "FAIL") + ": Agent CLI rejects paths outside project")
    if not path_guard:
        failures.append("agent-path-guard")

    leaked = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        parts = set(path.parts)
        if "node_modules" in parts or "target" in parts or ".git" in parts:
            continue
        if path.name in SENSITIVE_NAMES and path.name != "keys.env.example":
            # allow example templates only
            if path.name.endswith(".example"):
                continue
            leaked.append(str(path.relative_to(root)))
    if leaked:
        print("FAIL: tracked-looking secret files present:")
        for item in leaked[:20]:
            print(f"  - {item}")
        failures.append("leaked-secrets")
    else:
        print("PASS: no keys.env/.env secret files in repo tree")

    backup = root / ".ai-character-backup"
    if backup.exists():
        print("WARN: .ai-character-backup still exists (should be cleaned)")
    else:
        print("PASS: .ai-character-backup cleaned")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
