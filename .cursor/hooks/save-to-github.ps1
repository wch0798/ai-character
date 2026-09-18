# AI Character 변경을 GitHub origin에 저장합니다.
# Cursor stop hook 및 tools/save-to-github.ps1 에서 사용합니다.
$ErrorActionPreference = "Continue"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

try {
    $null = [Console]::In.ReadToEnd()
} catch {}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

function Write-HookOk {
    Write-Output "{}"
    exit 0
}

if (-not (Test-Path (Join-Path $Root ".git"))) {
    Write-HookOk
}

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Write-HookOk
}

& git.exe add -A 2>$null | Out-Null

$staged = @(& git.exe diff --cached --name-only)
if (-not $staged) {
    Write-HookOk
}

$secretHit = @(
    $staged | Where-Object {
        $_ -match '(^|[/\\])(keys\.env|\.env|credentials\.json|auth\.json)$'
    }
)
if ($secretHit.Count -gt 0) {
    & git.exe restore --staged -- @secretHit 2>$null | Out-Null
    $staged = @(& git.exe diff --cached --name-only)
    if (-not $staged) {
        Write-HookOk
    }
}

$summary = ($staged | Select-Object -First 5) -join ", "
if ($staged.Count -gt 5) {
    $summary = "$summary, ..."
}
$message = "Save: $summary"
& git.exe commit -m $message 2>$null | Out-Null
& git.exe push origin HEAD 2>$null | Out-Null
Write-HookOk
