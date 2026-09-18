# Windows NSIS 설치 파일을 실행합니다.
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\windows-env.ps1"
$Root = Split-Path -Parent $PSScriptRoot
$NsisDir = Join-Path $Root "src-tauri\target\release\bundle\nsis"
$Installer = Get-ChildItem $NsisDir -Filter "*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $Installer) {
    Write-Error "설치 파일이 없습니다: $NsisDir`n먼저 npm run build:app:windows 를 실행하세요."
}

Write-Host "설치 실행: $($Installer.FullName)"
Start-Process -FilePath $Installer.FullName -Wait
