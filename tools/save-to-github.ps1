# 현재 변경을 GitHub에 커밋하고 올립니다.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root ".cursor\hooks\save-to-github.ps1")
