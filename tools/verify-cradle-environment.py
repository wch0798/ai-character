#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
checks = []

def check(label: str, ok: bool):
    checks.append(ok)
    print(("PASS" if ok else "FAIL") + f": {label}")

backend = (root / "src-tauri/src/environment_preflight.rs").read_text(encoding="utf-8")
commands = (root / "src-tauri/src/agent_commands.rs").read_text(encoding="utf-8")
ui = (root / "src/settings-ui.ts").read_text(encoding="utf-8")
engine = (root / "src/orchestration-engine.ts").read_text(encoding="utf-8")
lib = (root / "src-tauri/src/lib.rs").read_text(encoding="utf-8")

check("Git preflight backend exists", "pub fn git_status" in backend)
check("conversation workspace auto git init", "prepare_workspace_git" in backend and ('arg(\"init\")' in backend or '[\"init\"]' in backend))
check("baseline commit does not stage project files", "--allow-empty" in backend and "git add" not in backend.lower())
check("Codex trust recovery exists", "is_codex_trust_error" in commands and "--skip-git-repo-check" in commands)
check("environment commands registered", all(x in lib for x in ["get_cradle_environment_status", "prepare_cradle_environment", "launch_git_installer"]))
check("CRADLE 환경 준비 UI", "CRADLE 환경 준비" in ui and "Git 설치" in ui)
check("environment failure reroute", "isRecoverableEnvironmentError" in engine and "fallbackCliTaskToAlternative" in engine)

if all(checks):
    print("RESULT: PASS")
    raise SystemExit(0)
print("RESULT: FAIL")
raise SystemExit(1)
