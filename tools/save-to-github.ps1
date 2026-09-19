function Get-GithubToken([string] $Root) {
    if ($env:GITHUB_TOKEN) {
        return $env:GITHUB_TOKEN
    }
    $paths = @(
        (Join-Path $env:APPDATA "AI-Character\keys.env"),
        (Join-Path $Root ".ai-character\keys.env")
    )
    foreach ($p in $paths) {
        if (-not $p -or -not (Test-Path $p)) { continue }
        foreach ($line in Get-Content -LiteralPath $p -ErrorAction SilentlyContinue) {
            if ($line -match '^\s*GITHUB_TOKEN\s*=\s*(.+)\s*$') {
                $value = $Matches[1].Trim().Trim('"').Trim("'")
                if ($value) { return $value }
            }
        }
    }
    return $null
}

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

$token = Get-GithubToken $Root
if ($token) {
    Write-Host "GITHUB_TOKEN으로 올립니다."
    $helper = "!f() { echo username=x-access-token; echo password=$token; }; f"
    & $git -c credential.helper= -c "credential.helper=$helper" push origin HEAD
} else {
    Write-Host "기본 브라우저 GitHub 로그인을 사용합니다. Gmail(Google) 계정이면 브라우저에서 로그인하세요."
    & $git -c credential.helper=manager-core push origin HEAD
}
Write-Host "GitHub 저장 완료."
