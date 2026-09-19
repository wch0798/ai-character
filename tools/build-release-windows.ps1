# Windows 배포 패키지: NSIS 설치 파일 + (exe + Live2D 리소스) 포터블 zip
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\windows-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Use-ProjectPath
$nodeExe = Ensure-Node22
$nodeDir = Split-Path $nodeExe
Add-FrontPath $nodeDir
$npmCmd = Join-Path $nodeDir "npm.cmd"

Write-Host "Node.js: $(& $nodeExe -v)"

Get-Process -Name "ai-character" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "실행 중인 앱을 종료합니다: $($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Host "npm ci..."
    & $npmCmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci 실패" }
}

Write-Host "tauri build --bundles nsis (exe + Live2D + WebView2)..."
& $npmCmd run tauri -- build --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "tauri nsis 빌드 실패" }

& "$PSScriptRoot\package-windows-artifacts.ps1"
