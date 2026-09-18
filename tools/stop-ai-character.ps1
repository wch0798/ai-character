$ErrorActionPreference = "SilentlyContinue"
. "$PSScriptRoot\windows-env.ps1"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "=== AI Character 종료 ==="
Write-Host "프로젝트: $Root"

Get-Process -Name "ai-character" -ErrorAction SilentlyContinue |
    ForEach-Object {
        Write-Host "프로세스 종료: ai-character $($_.Id)"
        Stop-Process -Id $_.Id -Force
    }

Get-Process -Name "node" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -like "*$Root*" } |
    ForEach-Object {
        Write-Host "프로세스 종료: node $($_.Id)"
        Stop-Process -Id $_.Id -Force
    }

foreach ($port in 1420, 1421, 4318) {
    netstat -ano | ForEach-Object {
        if ($_ -match ":$port\s+. *LISTENING") {
            $procId = ($_ -split '\s+')[-1]
            if ($procId -match '^\d+$' -and $procId -ne '0') {
                Write-Host "포트 $port 종료 -> $procId"
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

Write-Host "완료."
