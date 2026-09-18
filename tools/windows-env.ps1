# UTF-8 콘솔 + Node 22+ 를 런처/설치 스크립트가 공통으로 씁니다.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

try {
    chcp 65001 | Out-Null
} catch {}
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

$ManagedNodeDir = Join-Path $env:LOCALAPPDATA "Programs\nodejs"
$ManagedNode = Join-Path $ManagedNodeDir "node.exe"

function Add-FrontPath([string]$Dir) {
    if (-not $Dir -or -not (Test-Path $Dir)) { return }
    $parts = @($Dir) + @($env:Path -split ';' | Where-Object { $_ -and ($_ -ne $Dir) })
    $env:Path = ($parts -join ';')
}

function Use-ProjectPath {
    Add-FrontPath "$env:USERPROFILE\.cargo\bin"
    Add-FrontPath "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
    Add-FrontPath "$env:APPDATA\npm"
    Add-FrontPath "$env:ProgramFiles\Git\cmd"
    Add-FrontPath "$env:LOCALAPPDATA\Programs\Git\cmd"
    Add-FrontPath "$env:ProgramFiles\nodejs"
    Add-FrontPath $ManagedNodeDir
}

function Get-NodeMajorFrom([string]$Exe) {
    if (-not $Exe -or -not (Test-Path $Exe)) { return 0 }
    $ver = & $Exe -v 2>$null
    if ($ver -match 'v(\d+)') { return [int]$Matches[1] }
    return 0
}

function Get-ActiveNodeExe {
    Use-ProjectPath
    if ((Get-NodeMajorFrom $ManagedNode) -ge 22) {
        return $ManagedNode
    }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd -and (Get-NodeMajorFrom $cmd.Source) -ge 22) {
        return $cmd.Source
    }
    return $null
}

function Install-ManagedNode {
    Write-Host "Node.js 22+ 를 사용자 폴더에 설치합니다. (기존 v20과 충돌하지 않음)"
    New-Item -ItemType Directory -Force -Path $ManagedNodeDir | Out-Null
    $dir = Join-Path $env:TEMP "ai-character-node"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
    $lts = $index | Where-Object { $_.lts -and $_.version -like 'v22*' } | Select-Object -First 1
    if (-not $lts) { $lts = $index | Where-Object { $_.lts } | Select-Object -First 1 }
    if (-not $lts) { throw "Node.js LTS 버전을 찾지 못했습니다." }
    $ver = $lts.version
    $zipName = "node-$ver-win-x64.zip"
    $zip = Join-Path $dir $zipName
    Write-Host "다운로드: $zipName"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/$zipName" -OutFile $zip -UseBasicParsing
    $extract = Join-Path $dir "node-$ver-win-x64"
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
    Copy-Item -Path (Join-Path $extract '*') -Destination $ManagedNodeDir -Recurse -Force
    if ((Get-NodeMajorFrom $ManagedNode) -lt 22) {
        throw "Node.js 설치 후에도 버전이 22 미만입니다."
    }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$($ManagedNodeDir)*") {
        [Environment]::SetEnvironmentVariable("Path", "$($ManagedNodeDir);$userPath", "User")
    }
    Use-ProjectPath
    Write-Host "Node.js $ver 설치 완료: $ManagedNode"
}

function Ensure-Node22 {
    Use-ProjectPath
    $exe = Get-ActiveNodeExe
    if ($exe) {
        Write-Host "Node.js: $(& $exe -v) ($exe)"
        return $exe
    }
    Install-ManagedNode
    return $ManagedNode
}
