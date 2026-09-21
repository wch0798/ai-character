#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release/macos"
rm -rf "$OUT"
mkdir -p "$OUT"

VERSION="$(node -p "require('$ROOT/package.json').version")"
APP="$(find "$ROOT/src-tauri/target/release/bundle/macos" -maxdepth 1 -type d -name '*.app' | head -n 1 || true)"
if [[ -z "$APP" ]]; then
  echo "macOS .app 이 없습니다." >&2
  exit 1
fi

ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/AI-Character_${VERSION}_macos.app.zip"

shopt -s nullglob
for dmg in "$ROOT/src-tauri/target/release/bundle/dmg"/*.dmg "$ROOT/src-tauri/target/release/bundle/macos"/*.dmg; do
  cp "$dmg" "$OUT/"
done

cat > "$OUT/README.txt" <<EOF
AI Character macOS $VERSION

1) 권장: DMG를 열어 Applications로 복사하세요.
2) 압축판: AI-Character_${VERSION}_macos.app.zip 을 풀어 AI Character.app 을 실행하세요.

Apple 공증이 없으면 처음 실행 시 우클릭 → 열기, 또는:
xattr -cr "/Applications/AI Character.app"
EOF

echo "배포 폴더: $OUT"
ls -lh "$OUT"
