$ErrorActionPreference = "Stop"
. "$PSScriptRoot\windows-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Use-ProjectPath

$LogDir = Join-Path $Root ".ai-character-logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogDir "launch-$Stamp.log"

function Write-Log([string]$Message) {
    Write-Host $Message
    Add-Content -Path $LogFile -Value $Message -Encoding UTF8
}

function Stop-Port([int]$Port) {
    $pattern = ":$Port\s+. *LISTENING"
    netstat -ano | ForEach-Object {
        if ($_ -match $pattern) {
            $procId = ($_ -split '\s+')[-1]
            if ($procId -match '^\d+$' -and $procId -ne '0') {
                Write-Log "  포트 ${Port}: 종료 중 -> $procId"
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            }
        }
    }
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

Write-Log "1) 기존 프로세스 종료"
Get-Process -Name "ai-character","node" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -like "*$Root*" } |
    ForEach-Object {
        Write-Log "  종료: $($_.ProcessName) $($_.Id)"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }

Write-Log "2) 포트 정리"
foreach ($port in 1420, 1421, 4318) {
    Stop-Port $port
}

Write-Log "3) AI Character 시작 (npm run tauri dev)"
& (Join-Path $nodeDir "npm.cmd") run tauri -- dev
