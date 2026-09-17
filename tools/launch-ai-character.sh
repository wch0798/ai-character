#!/usr/bin/env bash
# AI Character 개발 실행 런처
# - 기존 Vite(1420/1421), 사용량 대시보드(4318), ai-character 프로세스 정리 후 재시작
# - Finder에서 더블클릭하거나: npm start / bash tools/launch-ai-character.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Finder/더블클릭 환경에서도 Homebrew·로컬 bin을 찾도록 PATH 보강
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}"
if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  . "${HOME}/.nvm/nvm.sh"
fi
if [[ -s "${HOME}/.zshrc" ]]; then
  # PATH만 필요한 경우가 많아 zshrc를 non-interactive로 읽지 않고 후보만 추가
  :
fi

PORTS=(1420 1421 4318)
LOG_DIR="${ROOT}/.ai-character-logs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${LOG_DIR}/launch-${STAMP}.log"
LOCK_FILE="${LOG_DIR}/launch.lock"

log() {
  printf '%s\n' "$*" | tee -a "$LOG_FILE"
}

# 더블클릭이 연속으로 들어오면 서로 프로세스를 죽이지 않도록 잠금
if [[ -f "${LOCK_FILE}" ]]; then
  lock_pid="$(cat "${LOCK_FILE}" 2>/dev/null || true)"
  if [[ -n "${lock_pid}" ]] && kill -0 "${lock_pid}" 2>/dev/null; then
    echo "이미 실행 중입니다 (pid ${lock_pid}). 새 창을 열지 않습니다."
    echo "강제 재시작: npm run stop 후 다시 실행"
    exit 0
  fi
fi
echo $$ > "${LOCK_FILE}"
trap 'rm -f "${LOCK_FILE}"' EXIT INT TERM

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "${pids}" ]]; then
    log "  포트 ${port}: 사용 중 아님"
    return 0
  fi
  log "  포트 ${port}: 종료 중 → ${pids//$'\n'/ }"
  # 먼저 정중히, 안 죽으면 강제
  # shellcheck disable=SC2086
  kill ${pids} 2>/dev/null || true
  sleep 0.4
  pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
    sleep 0.2
  fi
  if lsof -ti "tcp:${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    log "  경고: 포트 ${port}가 아직 남아 있습니다"
    return 1
  fi
  log "  포트 ${port}: 정리 완료"
}

kill_project_processes() {
  # 한글 경로 NFC/NFD 차이로 전체 ROOT 매칭이 실패할 수 있어
  # ASCII 고유 구간(AI/AI-Character)과 바이너리명으로 잡는다.
  local patterns=(
    "AI/AI-Character/src-tauri/target/debug/ai-character"
    "AI/AI-Character/node_modules/.bin/vite"
    "AI/AI-Character/node_modules/.bin/tauri"
    "AI/AI-Character/node_modules/@tauri-apps"
    "AI/AI-Character/usage-dashboard/server.mjs"
    "vite.*AI/AI-Character"
  )
  local found=0
  for pattern in "${patterns[@]}"; do
    local pids
    pids="$(pgrep -f "${pattern}" 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      found=1
      log "  프로세스 종료: ${pattern} → ${pids//$'\n'/ }"
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
  # cmdline에 경로가 안 잡히는 debug 바이너리
  local bin_pids
  bin_pids="$(pgrep -x ai-character 2>/dev/null || true)"
  if [[ -n "${bin_pids}" ]]; then
    found=1
    log "  프로세스 종료: ai-character → ${bin_pids//$'\n'/ }"
    # shellcheck disable=SC2086
    kill ${bin_pids} 2>/dev/null || true
    sleep 0.2
    bin_pids="$(pgrep -x ai-character 2>/dev/null || true)"
    if [[ -n "${bin_pids}" ]]; then
      # shellcheck disable=SC2086
      kill -9 ${bin_pids} 2>/dev/null || true
    fi
  fi
  # npm 래퍼(부모)도 정리
  local npm_pids
  npm_pids="$(pgrep -f "npm run tauri" 2>/dev/null || true)"
  if [[ -n "${npm_pids}" ]]; then
    # cwd가 이 프로젝트인 npm만 남기기 어려우니, tauri 자식이 이미 죽은 고아 npm은
    # 포트 정리 단계에서 실질 영향이 없고, 아래에서는 AI-Character INIT_CWD 위주로 처리
    :
  fi
  npm_pids="$(pgrep -f "INIT_CWD=.*/AI/AI-Character" 2>/dev/null || true)"
  if [[ -n "${npm_pids}" ]]; then
    found=1
    log "  npm 래퍼 종료 → ${npm_pids//$'\n'/ }"
    # shellcheck disable=SC2086
    kill ${npm_pids} 2>/dev/null || true
    sleep 0.2
    npm_pids="$(pgrep -f "INIT_CWD=.*/AI/AI-Character" 2>/dev/null || true)"
    if [[ -n "${npm_pids}" ]]; then
      # shellcheck disable=SC2086
      kill -9 ${npm_pids} 2>/dev/null || true
    fi
  fi
  if [[ "${found}" -eq 0 ]]; then
    log "  기존 AI Character 관련 프로세스 없음"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "ERROR: '${1}' 명령을 찾을 수 없습니다. PATH를 확인하세요."
    exit 1
  fi
}

log "=== AI Character 런처 ==="
log "프로젝트: ${ROOT}"
log "로그: ${LOG_FILE}"
log ""

require_cmd npm
require_cmd lsof
require_cmd node

log "1) 기존 프로세스 종료"
kill_project_processes

log ""
log "2) 포트 정리"
fail=0
for port in "${PORTS[@]}"; do
  kill_port "${port}" || fail=1
done
if [[ "${fail}" -ne 0 ]]; then
  log "ERROR: 일부 포트를 비우지 못했습니다. 다른 앱이 점유 중인지 확인하세요."
  exit 1
fi

log ""
log "3) AI Character 시작 (npm run tauri dev)"
if [[ "${AI_CHARACTER_HEADLESS:-}" == "1" ]]; then
  log "   백그라운드 실행 (터미널 없음). 종료: npm run stop"
else
  log "   창이 뜰 때까지 잠시 기다리세요. 종료하려면 Ctrl+C 또는 npm run stop"
fi
log ""

# 로그 파일로만 남김 (headless면 tee 없이 파일만 — 터미널 의존 제거)
if [[ "${AI_CHARACTER_HEADLESS:-}" == "1" ]]; then
  exec >>"$LOG_FILE" 2>&1
else
  exec > >(tee -a "$LOG_FILE") 2>&1
fi
exec npm run tauri dev
