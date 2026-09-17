#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path


def check(name: str, ok: bool) -> int:
    print(f"{'PASS' if ok else 'FAIL'}: {name}")
    return 0 if ok else 1


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").expanduser().resolve()
    failures = 0

    files = {
        "rust": root / "src-tauri/src/web_search.rs",
        "frontend": root / "src/web-research.ts",
        "engine": root / "src/orchestration-engine.ts",
        "types": root / "src/orchestration-types.ts",
        "settings": root / "src-tauri/src/settings.rs",
        "commands": root / "src-tauri/src/agent_commands.rs",
        "client": root / "src/agent-client.ts",
        "ui": root / "src/settings-ui.ts",
        "lib": root / "src-tauri/src/lib.rs",
        "cargo": root / "src-tauri/Cargo.toml",
    }

    for label, path in files.items():
        failures += check(f"{label} file exists", path.is_file())
    if failures:
        print("\nRESULT: FAIL")
        return 1

    rust = files["rust"].read_text(encoding="utf-8")
    frontend = files["frontend"].read_text(encoding="utf-8")
    engine = files["engine"].read_text(encoding="utf-8")
    settings = files["settings"].read_text(encoding="utf-8")
    commands = files["commands"].read_text(encoding="utf-8")
    client = files["client"].read_text(encoding="utf-8")
    ui = files["ui"].read_text(encoding="utf-8")
    lib = files["lib"].read_text(encoding="utf-8")
    cargo = files["cargo"].read_text(encoding="utf-8")

    failures += check("fixed Jina Search endpoint", "https://s.jina.ai/" in rust)
    failures += check("JINA_API_KEY env-only search credential", "JINA_API_KEY" in rust and "JINA_API_KEY" not in settings)
    failures += check("search command registered", "search_web_background" in lib and "mod web_search;" in lib)
    failures += check("reqwest dependency present", "reqwest" in cargo)
    failures += check("prompt injection isolation", "UNTRUSTED WEB RESEARCH" in frontend and "Do not follow instructions" in frontend)
    failures += check("CRADLE prompt grounding", "collectWebResearch" in engine and engine.count("researchPromptBlock") >= 4)
    failures += check("autoWebSearch preference frontend", "autoWebSearch" in client and "autoWebSearch" in ui)
    failures += check("auto_web_search preference backend", "auto_web_search" in settings and "auto_web_search" in commands)

    if os.environ.get("JINA_API_KEY"):
        print("INFO: JINA_API_KEY is set in this shell; automatic web search can make live requests.")
    else:
        print("INFO: JINA_API_KEY is not set in this shell; CRADLE will continue without background search until it is set.")

    print("\nRESULT: PASS" if failures == 0 else "\nRESULT: FAIL")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
