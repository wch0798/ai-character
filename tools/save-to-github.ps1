# 현재 변경을 GitHub에 커밋하고 올립니다.
$ErrorActionPreference = "Stop"
$env:GIT_TERMINAL_PROMPT = "1"
$env:GCM_INTERACTIVE = "auto"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$git = "C:\Program Files\Git\cmd\git.exe"
if (-not (Test-Path $git)) {
    $git = "git.exe"
}

Write-Host "=== AI Character GitHub 저장 ==="
Write-Host "프로젝트: $Root"

& $git add -A
$staged = @(& $git diff --cached --name-only)
$secretHit = @(
    $staged | Where-Object {
        $_ -match '(^|[/\\])(keys\.env|\.env|credentials\.json|auth\.json)$'
    }
)
if ($secretHit.Count -gt 0) {
    & $git restore --staged -- @secretHit
    Write-Host "비밀 파일은 커밋에서 제외했습니다."
    $staged = @(& $git diff --cached --name-only)
}

if ($staged) {
    $summary = ($staged | Select-Object -First 5) -join ", "
    if ($staged.Count -gt 5) {
        $summary = "$summary, ..."
    }
    & $git commit -m "Save: $summary"
} else {
    Write-Host "새로 커밋할 변경이 없습니다. 원격만 올립니다."
}

& $git -c credential.helper=manager-core push origin HEAD
Write-Host "GitHub 저장 완료."
