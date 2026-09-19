# tauri nsis 빌드 결과를 release/windows 로 모읍니다.
# 설치 파일 + (exe와 Live2D 리소스가 같이 든) 포터블 zip. exe 단독은 올리지 않습니다.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $Root "src-tauri\target\release"
$NsisDir = Join-Path $ReleaseDir "bundle\nsis"
$OutDir = Join-Path $Root "release\windows"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Get-ChildItem $OutDir -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

$Installer = Get-ChildItem $NsisDir -Filter "*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $Installer) {
    throw "NSIS 설치 파일이 없습니다: $NsisDir"
}

$Exe = Join-Path $ReleaseDir "ai-character.exe"
if (-not (Test-Path $Exe)) {
    throw "실행 파일이 없습니다: $Exe"
}
$exeSize = (Get-Item $Exe).Length
if ($exeSize -lt 20MB) {
    throw "실행 파일이 배포용이 아닙니다 ($([int]($exeSize/1MB))MB). localhost 개발 서버용입니다."
}

$ResourceCandidates = @(
    (Join-Path $ReleaseDir "resources\live2d"),
    (Join-Path $ReleaseDir "live2d")
)
$Live2D = $ResourceCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Live2D) {
    throw "Live2D 리소스가 실행 파일 옆에 없습니다. 설치 파일이 불완전합니다."
}

Copy-Item -Force $Installer.FullName (Join-Path $OutDir $Installer.Name)

$PortableDir = Join-Path $OutDir "AI-Character-portable"
New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null
Copy-Item -Force $Exe (Join-Path $PortableDir "ai-character.exe")
$portableResources = Join-Path $PortableDir "resources"
New-Item -ItemType Directory -Force -Path $portableResources | Out-Null
Copy-Item -Recurse -Force $Live2D (Join-Path $portableResources "live2d")

$version = (Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json).version
$zipPath = Join-Path $OutDir "AI-Character_$version`_windows-portable.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $PortableDir "*") -DestinationPath $zipPath -Force
Remove-Item -Recurse -Force $PortableDir

$readme = @"
AI Character Windows $version

1) 권장: $($Installer.Name) 를 실행하세요.
   앱, Live2D 모델, WebView2가 한 번에 설치되고 바탕화면 바로가기가 생깁니다.

2) 압축판: AI-Character_${version}_windows-portable.zip
   폴더 전체를 풀어서 ai-character.exe 를 실행하세요. exe만 따로 복사하면 캐릭터가 안 나옵니다.

에이전트 CLI(Claude/Codex/Cursor/Antigravity)는 앱 설정에서 설치합니다.
"@
Set-Content -Path (Join-Path $OutDir "README.txt") -Value $readme -Encoding UTF8

Write-Host "배포 폴더: $OutDir"
Get-ChildItem $OutDir | ForEach-Object {
    Write-Host (" - {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
}
