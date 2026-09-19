#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
checks = []

def check(label: str, ok: bool) -> None:
    checks.append(ok)
    print(("PASS" if ok else "FAIL") + f": {label}")

def text(rel: str) -> str:
    path = root / rel
    return path.read_text(encoding="utf-8") if path.is_file() else ""

backend = text("src-tauri/src/web_accounts.rs")
commands = text("src-tauri/src/agent_commands.rs")
lib = text("src-tauri/src/lib.rs")
caps = text("src-tauri/capabilities/default.json")
client = text("src/web-accounts.ts")
settings = text("src/settings-ui.ts")
settings_rs = text("src-tauri/src/settings.rs")
cradle_ui = text("src/orchestration-ui.ts")
handoff = text("src/web-agent-handoff.ts")
css = text("src/styles.css")

check("isolated profile data_directory", "data_directory" in backend and "profiles" in backend)
check("login uses isolated browser profiles", "isolated_browser" in text("src-tauri/src/lib.rs") and "cli_browser_env" in text("src-tauri/src/isolated_browser.rs") and "uses_system_browser" in text("src-tauri/src/isolated_browser.rs"))
check("GitHub Gmail login uses system browser", "github.com" in text("src-tauri/src/isolated_browser.rs") and "launch_github_login" in text("src-tauri/src/agent_install.rs"))
check("default multi-account slots", "claude-1" in backend and "chatgpt-1" in backend and "gemini-2" in backend)
check("open all accounts command", "open_all_web_accounts" in commands and "open_all_web_accounts" in lib)
check("capability allows webacct windows", "webacct-*" in caps)
check("frontend web accounts client", "openAllWebAccounts" in client and "listWebAccounts" in client)
check("settings account UI", "모든 웹 창 열기" in settings and "기본 브라우저로 GitHub 로그인" in settings)
check("web agent uses preferred account slot", "open_preferred_for_target" in backend)
check("alternate account slot opener", "open_alternate_for_target" in backend)
check("close account windows", "close_account" in backend and "close_web_account" in commands)
check("cradle alternate handoff UI", "다른 계정 창 열기+복사" in cradle_ui)
check("close after handoff preference", "close_web_account_after_handoff" in settings_rs)
check("close when cradle done UI", "closeWebAccountWhenCradleDone" in settings)
check("account row styles", "ai-web-account-row" in css)

if all(checks):
    print("\nRESULT: PASS")
    raise SystemExit(0)
print("\nRESULT: FAIL")
raise SystemExit(1)
