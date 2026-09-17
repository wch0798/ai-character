#!/usr/bin/env python3
from pathlib import Path
import re
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
checks = []

def check(label: str, condition: bool) -> None:
    checks.append((label, condition))
    print(("PASS" if condition else "FAIL") + f": {label}")

main = (root / "src/main.ts").read_text(encoding="utf-8") if (root / "src/main.ts").is_file() else ""
client = (root / "src/agent-client.ts").read_text(encoding="utf-8") if (root / "src/agent-client.ts").is_file() else ""
ui = (root / "src/settings-ui.ts").read_text(encoding="utf-8") if (root / "src/settings-ui.ts").is_file() else ""
css = (root / "src/styles.css").read_text(encoding="utf-8") if (root / "src/styles.css").is_file() else ""
changes = (root / "src-tauri/src/workspace_changes.rs").read_text(encoding="utf-8") if (root / "src-tauri/src/workspace_changes.rs").is_file() else ""

check("settings UI module present", "export function initializeSettingsUi" in ui)
check("settings UI initialized", 'initializeSettingsUi();' in main and 'from "./settings-ui"' in main)
check("project picker exposed", "export async function chooseProjectDirectory" in client and "chooseProjectDirectory" in ui)
check("agent executable picker exposed", "export async function chooseAgentExecutable" in client and "chooseAgentExecutable" in ui)
check("agent auto detection displayed", all(name in ui for name in ['"claude"', '"codex"', '"cursor"', '"antigravity"']) and "detectAgent" in ui)
check("settings CSS present", "/* AI-Character settings UI */" in css and "#ai-settings-panel" in css)
check("settings button hosted in chat toolbar", '#chat-history-toolbar' in ui and "toolbar.append(launcher)" in ui)
check("free auto setup section present", "한 번에 쓰기 (추천)" in ui and "무료 자동 모드 켜기" in ui and "getFreeAutoReadiness" in ui)
check("web account windows section present", "웹 계정 창" in ui and "모든 계정 창 열기" in ui)
panel_rule = re.search(r"#ai-settings-panel\s*\{(.*?)\}", css, re.S)
panel_css = panel_rule.group(1) if panel_rule else ""
check("settings panel stays below toolbar", "toolbar.offsetTop + toolbar.offsetHeight" in ui and "inset: 8px" not in panel_css and "left: 8px" in panel_css and "right: 8px" in panel_css)
check("safety policy visible", "원본 변경은 적용 버튼을 눌러야 반영됩니다" in ui and "충돌이 있으면 원본 적용을 차단합니다" in ui)
check("workspace warning cleanup present", "Err(error) if !current.exists()" not in changes)

failures = [label for label, ok in checks if not ok]
print(f"\nRESULT: {'PASS' if not failures else 'FAIL'}" + ("" if not failures else f" ({len(failures)} checks failed)"))
raise SystemExit(1 if failures else 0)
