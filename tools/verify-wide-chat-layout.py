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
        "left: var(--ai-character-chat-left) !important" in css
        and "bottom: var(--ai-character-hud-strip, 40px) !important" in css
        and "min-width: 480px !important" in css,
        "chat occupies added right-side window area",
        failures,
    )
    check(
        "chatLeftForCharacterLayout" in main_ts
        and "characterPaneWidthForChat" in main_ts
        and "occupancyFromModelBounds" in main_ts
        and "applyCharacterChatLane" in main_ts
        and "model.x =" in main_ts,
        "Live2D character anchored inside original-width left lane",
        failures,
    )
    check(
        "characterBaselineY" in main_ts
        and "syncChatModelPosition" in main_ts,
        "side chat keeps character on the same baseline",
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
                isinstance(width, (int, float))
                and width >= pane_width
                and min_width <= pane_width
                and "minChatAppWindowSize" in main_ts
                and "setSize(" in main_ts,
                "window starts at the character lane and widens for chat at runtime",
                failures,
            )
            check(
                window.get("resizable") is False,
                "OS chrome resize disabled; chat uses in-app handles",
                failures,
            )
            check(
                "MIN_CHAT_WIDTH" in main_ts
                and "setMinSize" in main_ts
                and "minChatAppWindowSize" in main_ts,
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
