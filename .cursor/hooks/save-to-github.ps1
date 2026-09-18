# AI Character 변경을 GitHub origin에 저장합니다.
# Cursor stop hook에서 사용합니다. 로그인 창을 띄우지 않습니다.
$ErrorActionPreference = "Continue"
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "never"
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

$git = "C:\Program Files\Git\cmd\git.exe"
if (-not (Test-Path $git)) {
    $gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
        Write-HookOk
    }
    $git = $gitCmd.Source
}

& $git add -A 2>$null | Out-Null

$staged = @(& $git diff --cached --name-only)
if (-not $staged) {
    Write-HookOk
}

$secretHit = @(
    $staged | Where-Object {
        $_ -match '(^|[/\\])(keys\.env|\.env|credentials\.json|auth\.json)$'
    }
)
if ($secretHit.Count -gt 0) {
    & $git restore --staged -- @secretHit 2>$null | Out-Null
    $staged = @(& $git diff --cached --name-only)
    if (-not $staged) {
        Write-HookOk
    }
}

$summary = ($staged | Select-Object -First 5) -join ", "
if ($staged.Count -gt 5) {
    $summary = "$summary, ..."
}
$message = "Save: $summary"
& $git commit -m $message 2>$null | Out-Null
& $git -c credential.helper=manager-core push origin HEAD 2>$null | Out-Null
Write-HookOk
