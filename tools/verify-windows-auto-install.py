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


install = text("src-tauri/src/agent_install.rs")
setup = text("src-tauri/src/windows_setup.rs")
core = text("src-tauri/src/agent_core.rs")
lib = text("src-tauri/src/lib.rs")
preflight = text("src-tauri/src/environment_preflight.rs")
ui = text("src/settings-ui.ts")
pkg = text("package.json")

check("windows_setup module exists", "mod windows_setup" in lib and (root / "src-tauri/src/windows_setup.rs").is_file())
check("install commands are async/blocking", "spawn_blocking(install_all_required_runtimes_impl)" in install)
check("PATH refresh after Windows install", "refresh_process_path" in setup and "WinGet" in setup)
check("winget uses user scope fallback", "--scope" in setup and "user" in setup)
check("npm is launched via cmd.exe", '"cmd.exe"' in setup and '"install"' in setup and '"-g"' in setup)
check("Claude native/winget installers", "Anthropic.ClaudeCode" in setup and "https://claude.ai/install.ps1" in setup)
check("Codex native/winget installers", "OpenAI.Codex" in setup and "https://chatgpt.com/codex/install.ps1" in setup)
check("Cursor Agent CLI installer", "https://cursor.com/install?win32=true" in setup)
check("Antigravity CLI installer", "Google.AntigravityCLI" in setup)
check("Git silent user-dir fallback", "git-for-windows" in setup and "/VERYSILENT" in setup)
check("Node portable zip fallback", "nodejs.org/dist" in setup and "win-x64.zip" in setup)
check("first-run auto install on Windows", "installAllRequiredRuntimes" in ui and "없는 프로그램을 자동 설치합니다" in ui)
check("Windows launch scripts exist", (root / "tools/launch-ai-character.ps1").is_file() and (root / "tools/setup-windows.ps1").is_file())
check("Windows launcher starts release exe without Vite", "ai-character.exe" in text("tools/launch-ai-character.ps1") and "tauri dev" in text("tools/launch-ai-character.ps1") and "AI_CHARACTER_DEV" in text("tools/launch-ai-character.ps1"))
check("system tray menu exists", "mod app_tray" in lib and (root / "src-tauri/src/app_tray.rs").is_file() and "재시작" in (root / "src-tauri/src/app_tray.rs").read_text(encoding="utf-8"))
check("taskbar hidden for overlay window", '"skipTaskbar": true' in text("src-tauri/tauri.conf.json"))
check("GitHub auto-save hook exists", (root / ".cursor/hooks.json").is_file() and (root / ".cursor/hooks/save-to-github.ps1").is_file())
check("npm start is cross-platform", "node tools/launch.mjs" in pkg)
check("Cursor CLI search includes WinGet Links", "WinGet" in core and "Links" in core)
check("Windows treats exe and cmd as official", "is_preferred_windows_binary" in core and "windows_extension_rank" in core and "matches!(windows_extension_rank(path), 0 | 1)" in core)
check("native install is not skipped for npm shims", "is_preferred_windows_binary(agent, &path)" in install)
check("Git installer uses shared Windows setup", "windows_setup::install_git" in preflight)
check("cmd/bat binaries run via cmd.exe", "command_with_args" in text("src-tauri/src/windows_process.rs") and "command_with_args" in core)

if all(checks):
    print("\nRESULT: PASS")
    raise SystemExit(0)
print("\nRESULT: FAIL")
raise SystemExit(1)
