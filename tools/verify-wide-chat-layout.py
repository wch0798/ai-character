#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def check(condition: bool, message: str, failures: list[str]) -> None:
    if condition:
        print(f"PASS: {message}")
    else:
        print(f"FAIL: {message}")
        failures.append(message)


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").expanduser().resolve()
    css_path = root / "src/styles.css"
    main_path = root / "src/main.ts"
    config_path = root / "src-tauri/tauri.conf.json"
    failures: list[str] = []

    css = css_path.read_text(encoding="utf-8") if css_path.is_file() else ""
    main_ts = main_path.read_text(encoding="utf-8") if main_path.is_file() else ""

    check(
        "/* AI-Character wide side chat layout v22.1 */" in css,
        "wide side-chat CSS installed",
        failures,
    )
    pane_match = re.search(
        r"--ai-character-character-pane-width:\s*([0-9]+)px",
        css,
    )
    check(pane_match is not None, "original character lane width preserved", failures)
    check(
        "left: calc(var(--ai-character-character-pane-width) + 12px)" in css
        and "top: 12px" in css
        and "bottom: 12px" in css
        and "height: auto" in css,
        "chat occupies added right-side window area",
        failures,
    )
    check(
        "/* AI-Character wide chat model anchor v22.1 */" in main_ts
        and "characterPaneCenter" in main_ts
        and "model.x =" in main_ts,
        "Live2D character anchored inside original-width left lane",
        failures,
    )
    check(
        "modelYBeforeChat = null" in main_ts,
        "side chat disables legacy vertical character lift",
        failures,
    )
    stale_model_y_import = (
        main_ts.count("getModelYFromBounds") == 1
        and re.search(r"(?m)^[ \t]*getModelYFromBounds[ \t]*,[ \t]*$", main_ts) is not None
    )
    check(
        not stale_model_y_import,
        "obsolete getModelYFromBounds import removed",
        failures,
    )

    if not config_path.is_file():
        check(False, "tauri main-window config exists", failures)
    else:
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
            windows = config.get("app", {}).get("windows", [])
            window = next((item for item in windows if item.get("label") == "main"), windows[0] if windows else {})
            width = window.get("width", 0)
            min_width = window.get("minWidth", 0)
            pane_width = int(pane_match.group(1)) if pane_match else 0
            check(
                isinstance(width, (int, float)) and width >= pane_width + 400,
                "main window widened while character lane stays fixed",
                failures,
            )
            check(window.get("resizable") is True, "main window remains resizable", failures)
            check(
                isinstance(min_width, (int, float)) and min_width >= pane_width + 320,
                "minimum width protects side-by-side layout",
                failures,
            )
        except Exception as error:
            print(f"FAIL: tauri config parse: {error}")
            failures.append("tauri config parse")

    if failures:
        print(f"\nRESULT: FAIL ({len(failures)})")
        raise SystemExit(1)
    print("\nRESULT: PASS")


if __name__ == "__main__":
    main()
