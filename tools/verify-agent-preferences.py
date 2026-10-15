#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
checks = []

def read(rel: str) -> str:
    path = root / rel
    return path.read_text(encoding="utf-8") if path.is_file() else ""

def check(label: str, condition: bool) -> None:
    checks.append((label, condition))
    print(("PASS" if condition else "FAIL") + f": {label}")

settings = read("src-tauri/src/settings.rs")
commands = read("src-tauri/src/agent_commands.rs")
workspace = read("src-tauri/src/workspace.rs")
client = read("src/agent-client.ts")
ui = read("src/settings-ui.ts")
lib = read("src-tauri/src/lib.rs")
css = read("src/styles.css")

check("default Agent persisted", "default_agent" in settings and "AgentKind::Claude" in settings)
check("default timeout persisted", "timeout_seconds" in settings and "180" in settings)
check("sensitive warning persisted", "warn_sensitive_files" in settings and "true" in settings)
check("preferences Tauri commands exposed", all(name in commands and name in lib for name in ["get_app_preferences", "set_app_preferences", "get_sensitive_files"]))
check("backend sensitive acknowledgement enforced", "sensitive_acknowledged" in commands and "민감 파일 경고" in commands)
check("sensitive file scanner present", "pub fn sensitive_project_files" in workspace and '".env"' in workspace and '".pem"' in workspace)
check("chat uses configured Agent", "preferences.defaultAgent" in client)
check("chat uses configured timeout", "preferences.timeoutSeconds" in client)
check(
    "chat does not block on sensitive files",
    "confirmSensitiveAgentAccess" in client
    and "return safeConfirm(" in client
    and "return true;" in read("src/safe-confirm.ts")
    and "sensitiveAcknowledged" in client,
)
check("settings UI exposes default Agent", "기본 Agent" in ui and "defaultAgentSelect" in ui)
check("settings UI exposes timeout", "Timeout (초)" in ui and "timeoutInput" in ui)
check("settings UI exposes sensitive warning", "민감 파일 접근 전 경고" in ui and "sensitiveCheckbox" in ui)
check("settings runtime field CSS present", "/* AI-Character settings runtime fields */" in css)

failures = [label for label, ok in checks if not ok]
print(f"\nRESULT: {'PASS' if not failures else 'FAIL'}" + ("" if not failures else f" ({len(failures)} checks failed)"))
raise SystemExit(1 if failures else 0)
