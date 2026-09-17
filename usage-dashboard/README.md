# AI-Character 계정 사용량 대시보드

Node 22.5 이상, 추가 설치 없음. AI-Character 앱에서 캐릭터 우클릭 → **사용량**으로 열 수 있습니다.

Provider 레지스트리 구조라 Claude / Codex / Cursor / Antigravity가 같은 슬롯으로 표시되고, 새 AI는 `server.mjs`의 `PROVIDERS`에 collect 함수만 추가하면 API·UI에 자동 반영됩니다.

## 앱에서 열기
앱을 켤 때 대시보드가 **자동으로 같이 뜨지는 않습니다.** 필요할 때만 엽니다.

1. AI Character 실행 (`AI Character.app` 더블클릭 또는 `AI Character 실행.command`)
2. 캐릭터에서 우클릭 → **사용량**
3. 서버가 꺼져 있으면 자동으로 켜고(이미 떠 있으면 포트 정리 후 재시작), 브라우저에서 `http://localhost:4318`을 엽니다.

## 수동 실행
```
cd /Volumes/백업/AI/AI-Character/usage-dashboard
AI_CHARACTER_DIR="/Volumes/백업/테스트/.ai-character" node server.mjs
```
`사용량 대시보드: http://localhost:4318` 이 나오면 브라우저에서 엽니다. 끄려면 Ctrl+C.

## 동작 확인
```
cd /Volumes/백업/AI/AI-Character/usage-dashboard
AI_CHARACTER_DIR="/Volumes/백업/테스트/.ai-character" node selftest.mjs
```

읽는 데이터 (모두 읽기 전용):
- `.ai-character/state.db` — 앱 에이전트 실행 기록(Claude/Codex/Cursor/Antigravity 등), 대화 목록
- `~/.claude/projects/**/*.jsonl` — Claude 토큰 사용량
- `~/.codex/sessions/**/*.jsonl` — Codex 토큰 사용량과 사용 한도
- `~/.cursor/cli-config.json` — Cursor 로그인 계정
- `~/.cursor/ai-tracking/ai-code-tracking.db` — Cursor Composer 코드 추적(토큰 대체 지표)
- `~/.claude.json` / `~/.codex/auth.json` — 로그인 계정(이메일·이름·요금제만)
- `.ai-character/keys.env` — 키 설정 여부와 끝 4자리만

환경 변수: `PORT`, `AI_CHARACTER_DIR`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CURSOR_HOME`, `ANTIGRAVITY_HOME`
