# Windows 릴리스 빌드 (NSIS 설치 파일)
# 필요: Node.js 22+, Rust stable, WebView2
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "npm ci / build..."
npm ci
npm run build

Write-Host "tauri build --bundles nsis..."
npm run tauri build -- --bundles nsis

$NsisDir = Join-Path $Root "src-tauri\target\release\bundle\nsis"
Write-Host ""
Write-Host "완료. 설치 파일:"
Get-ChildItem $NsisDir -Filter "*.exe" | ForEach-Object { Write-Host " - $($_.FullName)" }
