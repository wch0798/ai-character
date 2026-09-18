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
check("settings button hosted in chat toolbar", '#chat-history-toolbar' in ui and ("toolbar.append(launcher)" in ui or "insertBefore(launcher" in ui))
check("settings opened from chat, not floating mark", "ai-settings-fab" not in ui and 'makeButton("설정", "ai-settings-button")' in ui)
check("free auto setup section present", "한 번에 쓰기 (추천)" in ui and "무료 자동 모드 켜기" in ui and "getFreeAutoReadiness" in ui)
check("web account windows section present", "listWebAccounts" in ui and "openAllWebAccounts" in ui and "모든 계정 창을 엽니다" in ui)
check("each agent has a login action", "launchAgentLogin(row.agent)" in ui and "로그인" in ui and all(name in ui for name in ['"claude"', '"codex"', '"cursor"', '"antigravity"']))
check("missing agent shows install action", "찾을 수 없음 (설치)" in ui and "installAgentCli" in ui)
check("left click toggles chat, right click stays on character menu", 'setChatOpen(!isChatOpen())' in main and "event.button !== 0" in main and 'makeMenuButton("채팅 열기"' not in main and 'makeMenuButton("설정"' not in main)
check("right-click ignores chat chrome", '"#chat-panel, #ai-settings-panel' in main)
check("several agent chip opens settings", 'id = "agent-runtime-agent"' in (root / "src/agent-runtime-ui.ts").read_text(encoding="utf-8") and "ai-character:open-settings" in (root / "src/agent-runtime-ui.ts").read_text(encoding="utf-8"))
panel_rule = re.search(r"#ai-settings-panel\s*\{(.*?)\}", css, re.S)
panel_css = panel_rule.group(1) if panel_rule else ""
check("settings panel stays below toolbar", "toolbar.offsetTop + toolbar.offsetHeight" in ui and "inset: 8px" not in panel_css and "left: 8px" in panel_css and "right: 8px" in panel_css)
check("safety policy visible", "원본 변경은 적용 버튼을 눌러야 반영됩니다" in ui and "충돌이 있으면 원본 적용을 차단합니다" in ui)
check("workspace warning cleanup present", "Err(error) if !current.exists()" not in changes)

failures = [label for label, ok in checks if not ok]
print(f"\nRESULT: {'PASS' if not failures else 'FAIL'}" + ("" if not failures else f" ({len(failures)} checks failed)"))
raise SystemExit(1 if failures else 0)
