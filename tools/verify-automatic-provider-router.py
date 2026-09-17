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

rust = text("src-tauri/src/provider_router.rs")
settings = text("src-tauri/src/settings.rs")
commands = text("src-tauri/src/agent_commands.rs")
client = text("src/automatic-provider.ts")
engine = text("src/orchestration-engine.ts")
ui = text("src/settings-ui.ts")
lib = text("src-tauri/src/lib.rs")

check("automatic provider backend installed", "gemini_api" in rust and "openai_api" in rust)
check("Gemini key is environment-only", "GEMINI_API_KEY" in rust and "GEMINI_API_KEY" not in settings)
check("OpenAI paid API defaults opt-in", "allow_paid_openai_api: false" in settings)
check("provider commands registered", "get_automatic_provider_status" in commands and "run_automatic_provider" in commands)
check("provider commands reachable from Tauri", "get_automatic_provider_status" in lib and "run_automatic_provider" in lib)
check("TypeScript automatic provider bridge installed", "runAutomaticProvider" in client)
check("CRADLE automatic provider routing installed", "automaticProviderHealth" in engine and "runAutomaticManager" in engine)
check("settings explain Gemini free-first", "Gemini 공식 API 자동 사용" in ui and "GEMINI_API_KEY" in ui)
check("settings gate paid OpenAI", "OpenAI 유료 API 사용 허용" in ui and "allowPaidOpenAiApi" in ui)
check("free auto readiness command", "get_free_auto_readiness" in commands and "get_free_auto_readiness" in lib)
check("free auto one-click UI", "무료 자동 모드 켜기" in ui and "getFreeAutoReadiness" in text("src/agent-client.ts"))

if all(checks):
    print("\nRESULT: PASS")
    raise SystemExit(0)
print("\nRESULT: FAIL")
raise SystemExit(1)
