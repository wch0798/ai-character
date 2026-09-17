#!/usr/bin/env bash
# 로그를 보고 싶을 때만 사용 (Terminal이 열림).
# 평소에는 AI Character.app 더블클릭 → 터미널 없이 실행.
cd "$(dirname "$0")"
exec bash "./tools/launch-ai-character.sh"
