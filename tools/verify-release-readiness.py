#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


PLACEHOLDER_PRODUCT_NAMES = {"tauri app", "tauri-app", "app", "application"}
PLACEHOLDER_IDENTIFIERS = {
    "com.tauri.dev",
    "com.tauri.app",
    "com.example.app",
    "com.example.tauri",
}
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$")
VERSION_RE = re.compile(r'^\s*version\s*=\s*"([^"]+)"\s*$', re.MULTILINE)


def check(condition: bool, label: str, blockers: list[str]) -> None:
    if condition:
        print(f"PASS: {label}")
    else:
        print(f"FAIL: {label}")
        blockers.append(label)


def info(label: str, value: str) -> None:
    print(f"INFO: {label}: {value}")


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError(f"{path} JSON 파싱 실패: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{path} 최상위 값은 JSON object여야 합니다.")
    return value


def nested(data: dict[str, Any], *keys: str) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def find_tauri_config(root: Path) -> Path | None:
    candidates = [
        root / "src-tauri/tauri.conf.json",
        root / "src-tauri/tauri.conf.json5",
    ]
    return next((path for path in candidates if path.is_file()), None)


def cargo_version(root: Path) -> str | None:
    cargo = root / "src-tauri/Cargo.toml"
    if not cargo.is_file():
        return None
    match = VERSION_RE.search(cargo.read_text(encoding="utf-8"))
    return match.group(1) if match else None


def signing_identities() -> list[str]:
    if sys.platform != "darwin" or shutil.which("security") is None:
        return []
    try:
        result = subprocess.run(
            ["security", "find-identity", "-v", "-p", "codesigning"],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except Exception:
        return []
    identities: list[str] = []
    for line in result.stdout.splitlines():
        if '"' in line:
            identities.append(line.strip())
    return identities


def main() -> int:
    parser = argparse.ArgumentParser(description="AI-Character Tauri release readiness verifier")
    parser.add_argument("project", nargs="?", default=".", type=Path)
    parser.add_argument("--mode", choices=("local", "distribution"), default="local")
    args = parser.parse_args()

    root = args.project.expanduser().resolve()
    local_blockers: list[str] = []
    distribution_blockers: list[str] = []

    package_path = root / "package.json"
    check(package_path.is_file(), "package.json exists", local_blockers)
    package: dict[str, Any] = {}
    if package_path.is_file():
        try:
            package = load_json(package_path)
        except RuntimeError as error:
            print(f"FAIL: {error}")
            local_blockers.append("package.json parses")

    scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
    dependencies: dict[str, Any] = {}
    for key in ("dependencies", "devDependencies"):
        value = package.get(key)
        if isinstance(value, dict):
            dependencies.update(value)
    check(bool(scripts.get("tauri")), "package.json has tauri script", local_blockers)
    check("@tauri-apps/cli" in dependencies, "Tauri CLI dependency installed", local_blockers)

    config_path = find_tauri_config(root)
    check(config_path is not None, "Tauri config exists", local_blockers)
    config: dict[str, Any] = {}
    if config_path is not None:
        if config_path.suffix == ".json5":
            print("FAIL: tauri.conf.json5는 이 verifier에서 직접 파싱하지 않습니다. JSON config로 확인해주세요.")
            local_blockers.append("Tauri config is parseable JSON")
        else:
            try:
                config = load_json(config_path)
            except RuntimeError as error:
                print(f"FAIL: {error}")
                local_blockers.append("Tauri config parses")

    product_name = config.get("productName") if isinstance(config, dict) else None
    product_ok = isinstance(product_name, str) and bool(product_name.strip()) and product_name.strip().lower() not in PLACEHOLDER_PRODUCT_NAMES
    check(product_ok, "productName is release-ready", local_blockers)
    if product_ok:
        info("productName", product_name.strip())

    identifier = config.get("identifier") if isinstance(config, dict) else None
    identifier_ok = (
        isinstance(identifier, str)
        and bool(identifier.strip())
        and identifier.strip().lower() not in PLACEHOLDER_IDENTIFIERS
        and "." in identifier
        and bool(IDENTIFIER_RE.fullmatch(identifier.strip()))
    )
    check(identifier_ok, "identifier is unique-looking reverse-DNS value", local_blockers)
    if identifier_ok:
        info("identifier", identifier.strip())

    version = config.get("version") if isinstance(config.get("version"), str) else cargo_version(root)
    check(bool(version), "release version is defined", local_blockers)
    if version:
        info("version", str(version))

    before_build = nested(config, "build", "beforeBuildCommand")
    frontend_dist = nested(config, "build", "frontendDist")
    check(isinstance(before_build, str) and bool(before_build.strip()), "beforeBuildCommand is configured", local_blockers)
    check(isinstance(frontend_dist, str) and bool(frontend_dist.strip()), "frontendDist is configured", local_blockers)

    bundle = config.get("bundle") if isinstance(config.get("bundle"), dict) else {}
    active = bundle.get("active")
    check(active is not False, "bundle.active allows packaging", local_blockers)

    icons = bundle.get("icon") if isinstance(bundle.get("icon"), list) else []
    config_dir = config_path.parent if config_path else root / "src-tauri"
    icon_paths = [config_dir / str(item) for item in icons if isinstance(item, str) and item.strip()]
    check(bool(icon_paths), "bundle icon list is configured", local_blockers)
    check(bool(icon_paths) and all(path.is_file() for path in icon_paths), "bundle icons exist", local_blockers)
    if icon_paths:
        missing = [str(path.relative_to(root)) if path.is_relative_to(root) else str(path) for path in icon_paths if not path.is_file()]
        if missing:
            info("missing icons", ", ".join(missing))

    resources = bundle.get("resources") if isinstance(bundle.get("resources"), list) else []
    check(any("live2d" in str(item) for item in resources), "Live2D resources are bundled", local_blockers)
    windows = bundle.get("windows") if isinstance(bundle.get("windows"), dict) else {}
    webview_mode = windows.get("webviewInstallMode") if isinstance(windows.get("webviewInstallMode"), dict) else {}
    check(webview_mode.get("type") == "offlineInstaller", "WebView2 offline installer is bundled", local_blockers)
    nsis = windows.get("nsis") if isinstance(windows.get("nsis"), dict) else {}
    check(nsis.get("installMode") in {"currentUser", "perMachine", "both"}, "NSIS install mode is set", local_blockers)
    hooks = nsis.get("installerHooks") if isinstance(nsis.get("installerHooks"), str) else ""
    hooks_path = config_dir / hooks.lstrip("./") if hooks else None
    check(bool(hooks_path) and hooks_path.is_file(), "NSIS installer hooks exist", local_blockers)

    macos = bundle.get("macOS") if isinstance(bundle.get("macOS"), dict) else {}
    config_identity = macos.get("signingIdentity") if isinstance(macos.get("signingIdentity"), str) else ""
    env_identity = os.environ.get("APPLE_SIGNING_IDENTITY", "").strip()
    identity = env_identity or config_identity.strip()
    identities = signing_identities()
    if identities:
        info("macOS code signing identities", str(len(identities)))
    else:
        info("macOS code signing identities", "none detected or not running on macOS")

    signing_ok = bool(identity and identity != "-")
    if args.mode == "distribution":
        check(signing_ok, "Developer ID signing identity configured", distribution_blockers)
    else:
        info("signing", "Developer ID configured" if signing_ok else "not required for local bundle check")

    api_notary = all(os.environ.get(name, "").strip() for name in ("APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"))
    apple_id_notary = all(os.environ.get(name, "").strip() for name in ("APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"))
    notarization_ok = api_notary or apple_id_notary
    if args.mode == "distribution":
        check(notarization_ok, "Apple notarization credentials configured", distribution_blockers)
    else:
        info("notarization", "credentials detected" if notarization_ok else "not required for local bundle check")

    print("\nLocal bundle blockers:")
    if local_blockers:
        for item in local_blockers:
            print(f"  - {item}")
    else:
        print("  none")

    print("Distribution blockers:")
    if distribution_blockers:
        for item in distribution_blockers:
            print(f"  - {item}")
    else:
        print("  none" if args.mode == "distribution" else "  not evaluated in local mode")

    failures = local_blockers + (distribution_blockers if args.mode == "distribution" else [])
    if failures:
        print(f"\nRESULT: FAIL ({len(failures)} blockers)")
        return 1
    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
