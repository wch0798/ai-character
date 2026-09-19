$ErrorActionPreference = "Stop"
. "$PSScriptRoot\windows-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Use-ProjectPath

$LogDir = Join-Path $Root ".ai-character-logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogDir "launch-$Stamp.log"
$ReleaseExe = Join-Path $Root "src-tauri\target\release\ai-character.exe"
$DevMode = $env:AI_CHARACTER_DEV -eq "1"

function Write-Log([string]$Message) {
    Write-Host $Message
    Add-Content -Path $LogFile -Value $Message -Encoding UTF8
}

Write-Log "=== AI Character Windows 런처 ==="
Write-Log "프로젝트: $Root"
Write-Log "로그: $LogFile"

$nodeExe = Ensure-Node22
$nodeDir = Split-Path $nodeExe
Add-FrontPath $nodeDir
Write-Log "Node.js: $(& $nodeExe -v)"

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Log "npm 패키지를 설치합니다."
    & (Join-Path $nodeDir "npm.cmd") ci
}

Write-Log "1) 기존 AI Character만 종료 (Node 전체는 건드리지 않음)"
Get-Process -Name "ai-character" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Log "  종료: $($_.ProcessName) $($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

if ($DevMode) {
    Write-Log "3) 개발 모드 (npm run tauri dev) — Node/Vite가 계속 켜집니다"
    & (Join-Path $nodeDir "npm.cmd") run tauri -- dev
    exit $LASTEXITCODE
}

Write-Log "2) 배포용 실행 파일로 시작합니다 (실행 중 Node를 켜 두지 않음)"
$needsReleaseBuild = -not (Test-Path $ReleaseExe)
if (-not $needsReleaseBuild) {
    $exeSize = (Get-Item $ReleaseExe).Length
    # cargo-only 빌드는 ~10MB이고 localhost:1420(Vite)을 연다. 배포 파일은 프론트/리소스가 들어가 수십 MB다.
    if ($exeSize -lt 20MB) {
        Write-Log "  실행 파일이 배포용이 아닙니다 ($([int]($exeSize/1MB))MB). tauri build로 다시 만듭니다."
        $needsReleaseBuild = $true
    }
}
if ($needsReleaseBuild) {
    Write-Log "  배포 파일을 빌드합니다."
    & (Join-Path $nodeDir "npm.cmd") run tauri -- build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "배포 빌드에 실패했습니다."
    }
}

if (-not (Test-Path $ReleaseExe)) {
    throw "실행 파일을 찾지 못했습니다: $ReleaseExe"
}

Write-Log "3) 실행: $ReleaseExe"
Start-Process -FilePath $ReleaseExe -WorkingDirectory $Root
Write-Log "시작했습니다. 이 창의 Node는 곧 종료되며 캐릭터 앱만 남습니다."
