#!/usr/bin/env bash
# AI Character 관련 프로세스·포트만 정리 (실행하지 않음)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORTS=(1420 1421 4318)

echo "=== AI Character 종료 ==="
echo "프로젝트: ${ROOT}"

for pattern in \
  "AI/AI-Character/src-tauri/target/debug/ai-character" \
  "AI/AI-Character/node_modules/.bin/vite" \
  "AI/AI-Character/node_modules/.bin/tauri" \
  "AI/AI-Character/node_modules/@tauri-apps" \
  "AI/AI-Character/usage-dashboard/server.mjs" \
  "vite.*AI/AI-Character" \
  "INIT_CWD=.*/AI/AI-Character"
do
  pids="$(pgrep -f "${pattern}" 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "프로세스 종료: ${pattern} → ${pids//$'\n'/ }"
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    sleep 0.3
    pids="$(pgrep -f "${pattern}" 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      # shellcheck disable=SC2086
      kill -9 ${pids} 2>/dev/null || true
    fi
  fi
done

bin_pids="$(pgrep -x ai-character 2>/dev/null || true)"
if [[ -n "${bin_pids}" ]]; then
  echo "프로세스 종료: ai-character → ${bin_pids//$'\n'/ }"
  # shellcheck disable=SC2086
  kill ${bin_pids} 2>/dev/null || true
  sleep 0.2
  bin_pids="$(pgrep -x ai-character 2>/dev/null || true)"
  if [[ -n "${bin_pids}" ]]; then
    # shellcheck disable=SC2086
    kill -9 ${bin_pids} 2>/dev/null || true
  fi
fi

for port in "${PORTS[@]}"; do
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "포트 ${port} 종료 → ${pids//$'\n'/ }"
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    sleep 0.3
    pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      # shellcheck disable=SC2086
      kill -9 ${pids} 2>/dev/null || true
    fi
  else
    echo "포트 ${port}: 비어 있음"
  fi
done

rm -f "${ROOT}/.ai-character-logs/launch.lock"
echo "완료"
