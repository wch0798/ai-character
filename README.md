# AI Character

Tauri + Vanilla TypeScript 데스크톱 캐릭터 앱.

## 실행 (터미널 없이)

### Windows

1. 처음 한 번: `npm run setup:windows`  
   Git, Node.js, WebView2, Rust, C++ Build Tools를 자동 설치합니다.
2. `AI Character.bat` 을 더블클릭하거나 `npm start` 로 실행합니다.
3. 앱이 뜨면 Windows에서는 **없는 필수 프로그램(Git/Node/Claude/Cursor Agent/Codex/Antigravity)을 자동 설치**합니다.  
   실패 항목은 설정 → **필수 프로그램 설치**로 다시 시도하세요.

설치 파일(NSIS) 만들기:

```powershell
npm run build:app:windows
npm run install:local:windows
```

### macOS

프로젝트 폴더의 **`AI Character.app`** 을 더블클릭하세요.  
터미널 창은 뜨지 않고, 캐릭터 앱만 실행됩니다.

- 시작 전 포트 `1420` / `1421` / `4318` 과 기존 프로세스를 정리합니다.
- 로그: `.ai-character-logs/` (gitignore)
- 종료: `npm run stop`

로그가 보이는 터미널이 필요하면 `AI Character 실행.command` 를 쓰세요.

## 사용량 대시보드

앱 실행 시 자동으로 뜨지 않습니다. 캐릭터 **우클릭 → 사용량** 하면 서버를 켜고 브라우저로 엽니다.  
대시보드는 **`127.0.0.1` 전용**입니다. 포트 포워딩/외부 공개하지 마세요.

## 키 / 비밀

- 실제 키는 설정 프로젝트의 `.ai-character/keys.env` 에만 둡니다.
- 저장소에는 `keys.env.example` 만 있습니다. `keys.env` 는 gitignore 됩니다.
- Agent 작업 복사본에는 `keys.env` / `.env` 등 민감 파일이 **복사되지 않습니다**.

## 정식 빌드 (배포용)

```bash
npm run build:app
npm run install:local   # /Applications에 설치 + 검역 제거 후 실행
```

산출물: `src-tauri/target/release/bundle/macos/` 아래 `.app` / `.dmg`

**DMG만 끌어다 놓으면 안 열릴 수 있습니다.** Apple 공증이 없는 ad-hoc 서명이라 macOS가 막을 수 있습니다.  
이때는 `npm run install:local` 을 쓰거나, 설치 후 터미널에서:

```bash
xattr -cr "/Applications/AI Character.app"
open "/Applications/AI Character.app"
```

또는 Finder에서 앱 **우클릭 → 열기**.

## 보안 점검

```bash
python3 tools/verify-security-baseline.py .
```

## 개발

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
