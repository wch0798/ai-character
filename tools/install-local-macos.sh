#!/usr/bin/env bash
# 로컬 배포용: 서명된 .app을 /Applications에 설치하고 검역 속성을 제거합니다.
# (Apple Developer 공증이 없으면 DMG에서 복사만 하면 Gatekeeper가 막을 수 있습니다.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/src-tauri/target/release/bundle/macos/AI Character.app}"
DEST="/Applications/AI Character.app"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: 앱을 찾을 수 없습니다: $SRC" >&2
  echo "먼저 npm run build:app 을 실행하세요." >&2
  exit 1
fi

echo "서명 확인/재서명..."
codesign --force --deep --sign - "$SRC" >/dev/null
codesign --verify --deep --strict "$SRC"

echo "설치: $DEST"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
codesign --force --deep --sign - "$DEST" >/dev/null
xattr -cr "$DEST" 2>/dev/null || true

echo "기존 프로세스 종료 후 실행..."
pkill -f "/Applications/AI Character.app/Contents/MacOS/ai-character" 2>/dev/null || true
pkill -f "/Contents/MacOS/ai-character" 2>/dev/null || true
sleep 1
open "$DEST"
echo "완료. Dock 또는 화면 위 투명 창(캐릭터)을 확인하세요."
echo
echo "만약 여전히 안 열리면:"
echo "  시스템 설정 → 개인정보 보호 및 보안 → '확인 없이 열기'"
echo "  또는: xattr -cr \"$DEST\""
