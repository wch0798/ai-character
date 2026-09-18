$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. "$PSScriptRoot\windows-env.ps1"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Use-ProjectPath

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message"
}

function Test-Cmd([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WingetPackage([string]$Id) {
    Write-Host "winget install $Id"
    $common = @(
        "install", "--id", $Id, "-e",
        "--accept-package-agreements", "--accept-source-agreements",
        "--disable-interactivity", "--source", "winget"
    )
    & winget @common --scope user
    if ($LASTEXITCODE -eq 0) { Use-ProjectPath; return $true }
    & winget @common
    if ($LASTEXITCODE -eq 0) { Use-ProjectPath; return $true }
    return $false
}

if (-not (Test-Cmd "winget")) {
    throw "winget이 없습니다. Microsoft Store에서 '앱 설치 관리자'를 설치한 뒤 다시 실행하세요."
}

Write-Step "Git"
if (-not (Test-Cmd "git")) {
    if (-not (Install-WingetPackage "Git.Git")) {
        throw "Git 설치에 실패했습니다."
    }
}

Write-Step "Node.js 22+"
Ensure-Node22 | Out-Null

Write-Step "WebView2"
if (-not (Install-WingetPackage "Microsoft.EdgeWebView2Runtime")) {
    Write-Host "WebView2는 이미 있거나 winget 설치에 실패했습니다. 앱 실행 시 필요하면 다시 설치됩니다."
}

Write-Step "Rust"
if (-not (Test-Cmd "rustc") -or -not (Test-Cmd "cargo")) {
    if (-not (Install-WingetPackage "Rustlang.Rustup")) {
        $rustup = Join-Path $env:TEMP "rustup-init.exe"
        Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustup -UseBasicParsing
        & $rustup -y --default-toolchain stable --profile minimal
    }
    Use-ProjectPath
}

Write-Step "Visual Studio C++ Build Tools"
if (-not (Install-WingetPackage "Microsoft.VisualStudio.2022.BuildTools")) {
    Write-Host "Build Tools 설치를 건너뜁니다. Tauri 빌드가 실패하면 Visual Studio Installer에서 C++ 워크로드를 추가하세요."
}

Use-ProjectPath
$nodeExe = Ensure-Node22
$npmCmd = Join-Path (Split-Path $nodeExe) "npm.cmd"

Write-Step "npm 패키지"
if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    & $npmCmd ci
} else {
    & $npmCmd install
}

Write-Host ""
Write-Host "Windows 환경 준비 완료."
Write-Host "개발 실행: AI Character.bat  또는  npm start"
Write-Host "설치 파일 빌드: npm run build:app:windows"
