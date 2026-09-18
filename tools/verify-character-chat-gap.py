#!/usr/bin/env python3
from __future__ import annotations

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
    failures: list[str] = []

    css = css_path.read_text(encoding="utf-8") if css_path.is_file() else ""
    main_ts = main_path.read_text(encoding="utf-8") if main_path.is_file() else ""

    check(
        "/* AI-Character compact character-chat gap v22.2 */" in css,
        "compact character-chat gap CSS installed",
        failures,
    )
    check(
        "--ai-character-chat-gap:" in css
        and "left: var(--ai-character-chat-left) !important" in css,
        "chat left edge uses runtime visible-character position",
        failures,
    )
    check(
        "chatLeftForCharacterLayout" in main_ts
        and "characterPaneWidthForChat" in main_ts
        and "characterDisplaySize" in main_ts
        and "occupancyFromModelBounds" in main_ts,
        "Live2D visible right edge measured for compact spacing",
        failures,
    )
    check(
        "MIN_CHAT_WIDTH" in main_ts
        and "minChatAppWindowSize" in main_ts,
        "dynamic chat position preserves usable chat width",
        failures,
    )

    if failures:
        print(f"\nRESULT: FAIL ({len(failures)})")
        raise SystemExit(1)
    print("\nRESULT: PASS")


if __name__ == "__main__":
    main()
