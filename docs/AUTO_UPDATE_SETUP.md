# 앱 자동 업데이트 설정 (처음 하는 분용)

설치된 AI Character가 GitHub에서 새 버전을 **스스로 받아 설치**하게 만드는 방법입니다.
한 번만 해 두면 그다음부터는 신경 쓸 일이 거의 없습니다.

> 같은 안내를 **브라우저 설정 페이지**에서 단계별로 볼 수 있습니다.
> 트레이(메뉴 막대) 아이콘 → **처음 설정 (웹)** → 왼쪽의 **7. 자동 업데이트**
> (또는 앱 설정 → 자동화 탭 → **웹에서 서명 설정 열기**)
> 각 단계의 **열기 + 이름 복사** 버튼을 누르면 GitHub 화면이 열리고, 입력할 이름이 자동으로 복사됩니다.

---

## 왜 필요한가요?

앱은 새 버전을 받을 때 "정말 내가 만든 파일인지"를 **서명**으로 확인합니다.

| 파일 | 역할 | 어디에 넣나 | 남이 봐도 되나 |
| --- | --- | --- | --- |
| `xxx.key` (개인키) | 새 버전에 도장을 찍음 | GitHub **Secret** | ❌ 절대 안 됨 |
| `xxx.key.pub` (공개키) | 도장이 진짜인지 확인 | GitHub **Variable** → 앱 안에 들어감 | ⭕ 괜찮음 |
| 키 비밀번호 (넣었다면) | 개인키 잠금 해제 | GitHub **Secret** | ❌ 절대 안 됨 |

> ⚠️ 개인키를 잃어버리면 이미 설치된 앱은 더 이상 업데이트를 받지 못합니다.
> 암호 관리자나 외장 백업에 한 부 더 보관하세요.
> 개인키는 채팅, 메일, git 저장소에 **절대** 올리지 마세요.

---

## 1단계. 키 파일 확인

`npx tauri signer generate` 로 키를 만들었다면 파일이 두 개 있습니다.

- `~/.tauri/ai-character.key` ← 개인키 (예시 경로)
- `~/.tauri/ai-character.key.pub` ← 공개키

파일 내용을 보려면 Finder에서 파일을 **텍스트 편집기**로 열면 됩니다.
(숨김 폴더 `~/.tauri` 는 Finder에서 `⌘ + Shift + .` 을 누르면 보입니다.)

## 2단계. 공개키 → GitHub Variable

1. 이 주소를 엽니다: <https://github.com/wch0798/ai-character/settings/variables/actions/new>
2. **Name**: `AI_CHARACTER_UPDATER_PUBKEY`
3. **Value**: `.key.pub` 파일 내용 **전체**를 붙여넣기
4. **Add variable** 클릭

> Secret이 아니라 **Variable** 입니다. 탭을 헷갈리지 마세요.

## 3단계. 개인키 → GitHub Secret

1. 이 주소를 엽니다: <https://github.com/wch0798/ai-character/settings/secrets/actions/new>
2. **Name**: `TAURI_SIGNING_PRIVATE_KEY`
3. **Secret**: `.key` 파일(끝이 `.pub` 이 아닌 것) 내용 **전체**를 붙여넣기
4. **Add secret** 클릭

## 4단계. 키 비밀번호 → GitHub Secret (비밀번호를 넣었을 때만)

1. 같은 주소에서 **New repository secret**
2. **Name**: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
3. **Secret**: 키를 만들 때 입력한 비밀번호
4. **Add secret** 클릭

비밀번호 없이 만들었다면 이 단계는 건너뜁니다.

## 5단계. 자동 배포 파일을 GitHub에 올리기

`.github/workflows/release.yml` 파일이 GitHub에 있어야 합니다.
Cursor 채팅에 **"변경 내용 커밋하고 푸시해줘"** 라고 말하면 됩니다.

확인: <https://github.com/wch0798/ai-character/blob/main/.github/workflows/release.yml>
파일 내용이 보이면 완료, 404가 뜨면 아직 안 올라간 것입니다.

## 6단계. 서명된 설치본 만들기

1. <https://github.com/wch0798/ai-character/actions/workflows/release.yml> 을 엽니다.
2. 오른쪽 **Run workflow** → 초록 **Run workflow** 버튼 클릭
3. 20~40분 기다립니다. 초록 체크 ✅ 가 뜨면 성공입니다.
4. 빨간 X ❌ 가 뜨면 그 항목을 눌러 오류 화면을 AI에게 보여 주세요.

> 빌드 로그에 `building without auto-update artifacts` 경고가 보이면
> 2·3단계의 이름 철자가 틀렸거나 Variable/Secret 탭을 바꿔 넣은 것입니다.

## 7단계. 새 설치본을 한 번 직접 설치

지금 쓰는 앱에는 공개키가 없으므로, **처음 한 번만** 직접 설치해야 합니다.

1. <https://github.com/wch0798/ai-character/releases/latest> 에서 **Assets** 를 펼칩니다.
2. 내 컴퓨터에 맞는 파일을 받습니다.
   - Apple 칩 Mac (M1~M4): `aarch64` 가 들어간 `.dmg`
   - Intel Mac: `x64` 가 들어간 `.dmg`
   - Windows: `x64-setup.exe`
3. 기존 앱을 종료하고 설치합니다. 설정과 대화 기록은 그대로 남습니다.

## 8단계. 확인

새로 설치한 앱에서 트레이 메뉴 **처음 설정 (웹)** → **7. 자동 업데이트** 를 엽니다.
맨 위에 `자동 업데이트 켜짐` 이 보이면 끝입니다.

---

## 다음 버전을 낼 때는?

1. `package.json` 과 `src-tauri/tauri.conf.json` 의 `"version"` 숫자를 올립니다. (예: `0.1.4` → `0.1.5`)
2. 커밋·푸시한 뒤 **6단계**만 다시 합니다.
3. 설치된 앱이 정해진 간격(기본 6시간)마다 확인해서 받아 두고, "지금 재시작" 버튼으로 적용합니다.

버전 숫자를 올리지 않으면 앱은 "이미 최신"이라고 판단해 받지 않습니다.

## 자주 묻는 것

- **소스로 실행(개발 모드)할 때도 필요한가요?** 아니요. 소스 실행은 git으로 업데이트되고, 서명은 배포용 설치본에만 필요합니다.
- **`tauri.conf.json` 의 `pubkey` 칸은 비어 있어도 되나요?** 네. 이 앱은 빌드할 때 GitHub Variable의 공개키를 앱 안에 넣는 방식이라 그 칸은 쓰지 않습니다.
- **개인키가 유출된 것 같아요.** 새 키를 만들고 2~4단계를 새 값으로 다시 한 뒤, 6~7단계로 새 설치본을 다시 배포하세요. 예전 키로 서명된 앱은 새 키 버전을 받지 못하므로 한 번 직접 재설치가 필요합니다.
