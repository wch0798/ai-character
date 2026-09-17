#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
checks = []

def text(rel: str) -> str:
    path = root / rel
    return path.read_text(encoding="utf-8") if path.is_file() else ""

def check(label: str, ok: bool) -> None:
    checks.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}: {label}")

settings = text("src-tauri/src/settings.rs")
commands = text("src-tauri/src/agent_commands.rs")
core = text("src-tauri/src/agent_core.rs")
client = text("src/agent-client.ts")
ui = text("src/settings-ui.ts")

check("agent model preference persistence", "agent_models" in settings and "agent_model_presets" in settings)
check("preferences bridge exposes models", "agentModels" in client and "agentModelPresets" in client)
check("settings UI exposes model presets", "모델 프리셋" in ui and "프리셋 추가" in ui and "프리셋 삭제" in ui)
check("model is applied to agent command", "args_for_with_options" in core and '"--model"' in core and "request.model.as_deref()" in core)
check("backend validates model values", "validate_agent_models" in commands and "128" in commands)

failures = len([ok for ok in checks if not ok])
if failures:
    print(f"RESULT: FAIL ({failures} checks failed)")
    raise SystemExit(1)
print("RESULT: PASS")
