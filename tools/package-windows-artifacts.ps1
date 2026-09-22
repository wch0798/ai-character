# tauri nsis 빌드 결과를 release/windows 로 모읍니다.
# 설치 파일 + (exe와 Live2D 리소스가 같이 든) 포터블 zip. exe 단독은 올리지 않습니다.
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $Root "src-tauri\target\release"
$NsisDir = Join-Path $ReleaseDir "bundle\nsis"
$OutDir = Join-Path $Root "release\windows"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Get-ChildItem $OutDir -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

$Installer = Get-ChildItem $NsisDir -Filter "*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $Installer) {
    throw "NSIS installer not found: $NsisDir"
}

$Exe = Join-Path $ReleaseDir "ai-character.exe"
if (-not (Test-Path $Exe)) {
    throw "Release exe not found: $Exe"
}
$exeSize = (Get-Item $Exe).Length
if ($exeSize -lt 20MB) {
    throw "Exe is not a production build ($([int]($exeSize/1MB))MB). Do not ship a localhost/devUrl binary."
}

$ResourceCandidates = @(
    (Join-Path $ReleaseDir "resources\live2d"),
    (Join-Path $ReleaseDir "live2d")
)
$Live2D = $ResourceCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Live2D) {
    throw "Live2D resources missing next to the exe. Installer would be incomplete."
}

Copy-Item -Force $Installer.FullName (Join-Path $OutDir $Installer.Name)

$PortableDir = Join-Path $OutDir "AI-Character-portable"
New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null
Copy-Item -Force $Exe (Join-Path $PortableDir "ai-character.exe")
$portableResources = Join-Path $PortableDir "resources"
New-Item -ItemType Directory -Force -Path $portableResources | Out-Null
Copy-Item -Recurse -Force $Live2D (Join-Path $portableResources "live2d")

$version = (Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json).version
$zipPath = Join-Path $OutDir "AI-Character_$version`_windows-portable.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $PortableDir "*") -DestinationPath $zipPath -Force
Remove-Item -Recurse -Force $PortableDir

$readme = @"
AI Character Windows $version

1) Install: run $($Installer.Name)
   This installs the app, Live2D models, and WebView2, and creates a desktop shortcut.

2) Portable: unzip AI-Character_${version}_windows-portable.zip
   Keep the whole folder and run ai-character.exe. Copying only the exe hides the character.

Agent CLIs (Claude/Codex/Cursor/Antigravity) are installed from app settings.
"@
$utf8 = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText((Join-Path $OutDir "README.txt"), $readme, $utf8)

Write-Host "배포 폴더: $OutDir"
Get-ChildItem $OutDir | ForEach-Object {
    Write-Host (" - {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
}
