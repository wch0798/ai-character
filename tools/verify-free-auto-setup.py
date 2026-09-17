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

router = text("src-tauri/src/provider_router.rs")
commands = text("src-tauri/src/agent_commands.rs")
lib = text("src-tauri/src/lib.rs")
client = text("src/agent-client.ts")
settings_ui = text("src/settings-ui.ts")
handoff = text("src/web-agent-handoff.ts")
cradle_ui = text("src/orchestration-ui.ts")
css = text("src/styles.css")

check("free auto readiness backend", "struct FreeAutoReadiness" in router and "fn free_auto_readiness" in router)
check("Jina key checked without persistence", "JINA_API_KEY" in router and "jina_api_configured" in router)
check("local keys.env loader", "keys.env" in text("src-tauri/src/local_env.rs") and "load_on_startup" in text("src-tauri/src/local_env.rs"))
check("keys.env open command", "open_keys_env_file" in commands and "open_keys_env_file" in lib)
check("Tauri command registered", "get_free_auto_readiness" in commands and "get_free_auto_readiness" in lib)
check("TypeScript readiness bridge", "getFreeAutoReadiness" in client and "FreeAutoReadiness" in client)
check("one-click free auto settings UI", "무료 자동 모드 켜기" in settings_ui and "키 파일 열기" in settings_ui)
check("easy setup CSS", "ai-settings-easy" in css and "ai-settings-easy-list" in css)
check("one-click web handoff helper", "prepareWebAgentHandoff" in handoff)
check("web handoff simplified to one action", "한 번에 열기+복사" in cradle_ui and "prepareWebAgentHandoff" in cradle_ui)
check("automatic-first cradle labels", "자동 Provider 우선" in cradle_ui)
check("keys.env example present", (root / "keys.env.example").is_file())
check("keys.env gitignored", "keys.env" in text(".gitignore"))

if all(checks):
    print("\nRESULT: PASS")
    raise SystemExit(0)
print("\nRESULT: FAIL")
raise SystemExit(1)
