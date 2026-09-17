#!/usr/bin/env python3
from pathlib import Path
import argparse
import re
import sys


def check(condition: bool, message: str, failures: list[str]) -> None:
    if condition:
        print(f"PASS: {message}")
    else:
        print(f"FAIL: {message}")
        failures.append(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("project", nargs="?", default=".")
    args = parser.parse_args()
    root = Path(args.project).expanduser().resolve()
    failures: list[str] = []

    cargo = (root / "src-tauri/Cargo.toml").read_text(encoding="utf-8")
    lib = (root / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    rust_path = root / "src-tauri/src/chat_state.rs"
    ts_path = root / "src/chat-state-client.ts"
    main_ts = (root / "src/main.ts").read_text(encoding="utf-8")

    check(rust_path.is_file(), "SQLite backend module exists", failures)
    check(ts_path.is_file(), "SQLite frontend bridge exists", failures)
    check(bool(re.search(r'(?m)^\s*rusqlite\s*=', cargo)), "rusqlite dependency configured", failures)
    check("mod chat_state;" in lib, "chat_state module registered", failures)
    for name in ["load_ui_state", "save_ui_state", "get_state_db_path"]:
        check(name in lib, f"Tauri handler exposes {name}", failures)
    if rust_path.is_file():
        rust = rust_path.read_text(encoding="utf-8")
        check('join(".ai-character").join("state.db")' in rust, "state.db is project-local", failures)
        check("CREATE TABLE IF NOT EXISTS app_state" in rust, "SQLite schema initialization exists", failures)
    check('import { initializeSqliteStateMirror } from "./chat-state-client";' in main_ts, "frontend imports SQLite state mirror", failures)
    check("await initializeSqliteStateMirror();" in main_ts, "frontend restores state before app setup", failures)
    check(main_ts.count("await initializeSqliteStateMirror();") == 1, "SQLite restore wired exactly once", failures)

    if failures:
        print(f"\nRESULT: FAIL ({len(failures)} checks failed)")
        raise SystemExit(1)
    print("\nRESULT: PASS")


if __name__ == "__main__":
    main()
