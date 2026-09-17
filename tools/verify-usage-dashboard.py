#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


def check(ok: bool, label: str, failures: list[str]) -> None:
    print(("PASS" if ok else "FAIL") + f": {label}")
    if not ok:
        failures.append(label)


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").expanduser().resolve()
    failures: list[str] = []

    dashboard = root / "usage-dashboard"
    server = (dashboard / "server.mjs").read_text(encoding="utf-8") if (dashboard / "server.mjs").is_file() else ""
    page = (dashboard / "public" / "index.html").read_text(encoding="utf-8") if (dashboard / "public" / "index.html").is_file() else ""
    rust = (root / "src-tauri" / "src" / "usage_dashboard.rs").read_text(encoding="utf-8") if (root / "src-tauri" / "src" / "usage_dashboard.rs").is_file() else ""
    lib = (root / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8") if (root / "src-tauri" / "src" / "lib.rs").is_file() else ""
    client = (root / "src" / "agent-client.ts").read_text(encoding="utf-8") if (root / "src" / "agent-client.ts").is_file() else ""
    main_ts = (root / "src" / "main.ts").read_text(encoding="utf-8") if (root / "src" / "main.ts").is_file() else ""

    check(dashboard.is_dir(), "usage-dashboard folder present", failures)
    check("resolveAppDir" in server and "AI_CHARACTER_DIR" in server, "dashboard resolves project .ai-character dir", failures)
    check("PROVIDERS" in server and "collectCursor" in server, "dashboard has extensible provider registry with Cursor", failures)
    check("AI-Character 계정 사용량" in page and "/api/usage" in page, "dashboard page present", failures)
    check("data.providers" in page or "providers.map" in page, "dashboard UI renders providers dynamically", failures)
    check("open_usage_dashboard" in rust and "spawn_dashboard_server" in rust, "backend starts usage dashboard", failures)
    check("dashboard_api_is_current" in rust and "clear_port" in rust, "backend restarts stale usage dashboard", failures)
    check("open_usage_dashboard" in lib and "mod usage_dashboard" in lib, "Tauri exposes usage dashboard command", failures)
    check("openUsageDashboard" in client, "frontend bridge for usage dashboard", failures)
    check('"사용량"' in main_ts and "openUsageDashboard" in main_ts, "right-click opens usage dashboard", failures)

    print(f"\nRESULT: {'PASS' if not failures else 'FAIL'}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
