#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
MODE="${AI_CHARACTER_RELEASE_MODE:-local}"
cd "$ROOT"
ROOT="$(pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: macOS .app/.dmg release build must run on macOS." >&2
  exit 1
fi

python3 tools/verify-release-readiness.py . --mode "$MODE"
npm run build

# .app은 필수, .dmg는 디스크 이미지 도구 권한에 따라 실패할 수 있음
set +e
npm run tauri build -- --bundles app,dmg
BUILD_STATUS=$?
set -e

APP_PATH="$(find "$ROOT/src-tauri/target/release/bundle/macos" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -n 1 || true)"
if [[ -z "$APP_PATH" ]]; then
  echo "ERROR: .app bundle missing (tauri build status=$BUILD_STATUS)" >&2
  exit 1
fi

echo
echo "Ad-hoc codesign (Gatekeeper 로컬 실행용)..."
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
xattr -cr "$APP_PATH" 2>/dev/null || true

# DMG가 이미 만들어졌다면 안의 앱 서명과 다를 수 있어, 가능하면 app만 다시 묶어 서명 상태를 맞춤
if [[ "$BUILD_STATUS" -eq 0 ]]; then
  set +e
  npm run tauri build -- --bundles dmg
  DMG_STATUS=$?
  set -e
  # dmg 재생성 후 app이 다시 linker-signed로 덮일 수 있어 재서명
  codesign --force --deep --sign - "$APP_PATH"
  xattr -cr "$APP_PATH" 2>/dev/null || true
  if [[ "$DMG_STATUS" -ne 0 ]]; then
    BUILD_STATUS=$DMG_STATUS
  fi
fi

echo
echo "Release artifacts:"
FOUND=0
while IFS= read -r path; do
  FOUND=1
  echo "  - ${path#$ROOT/}"
done < <(find "$ROOT/src-tauri/target/release/bundle" \( -type d -name '*.app' -o -type f -name '*.dmg' \) -print 2>/dev/null | sort)

if [[ "$FOUND" -eq 0 ]]; then
  echo "ERROR: no .app or .dmg artifacts found under src-tauri/target" >&2
  exit 1
fi

if [[ "$BUILD_STATUS" -ne 0 ]]; then
  echo
  echo "WARN: full bundle reported status $BUILD_STATUS (often DMG/hdiutil)."
  echo "      .app is ready; re-run if you need the .dmg."
fi

echo
echo "로컬 설치(권장): bash tools/install-local-macos.sh"
echo "NOTE: Apple Developer 공증이 없으면 DMG→Applications 복사 후"
echo "      우클릭→열기 또는 xattr -cr \"/Applications/AI Character.app\" 이 필요합니다."
