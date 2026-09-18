//! Windows에서 Git/Node/Agent CLI를 콘솔 창 없이 자동 설치합니다.
//! winget App Execution Alias, PATH 미갱신, .cmd 직접 실행 실패를 모두 우회합니다.

#![cfg(windows)]

use crate::environment_preflight::git_binary;
use crate::windows_process::hide_console;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(program_files) = env::var_os("ProgramFiles") {
        let root = PathBuf::from(program_files);
        dirs.push(root.join("Git").join("cmd"));
        dirs.push(root.join("Git").join("bin"));
        dirs.push(root.join("nodejs"));
    }
    if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
        let root = PathBuf::from(program_files_x86);
        dirs.push(root.join("Git").join("cmd"));
        dirs.push(root.join("Microsoft").join("EdgeWebView").join("Application"));
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join("Programs").join("Git").join("cmd"));
        dirs.push(local.join("Programs").join("Git").join("bin"));
        dirs.push(local.join("Programs").join("nodejs"));
        dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
        dirs.push(local.join("cursor-agent"));
        dirs.push(
            local
                .join("Programs")
                .join("cursor")
                .join("resources")
                .join("app")
                .join("bin"),
        );
        dirs.push(local.join("Microsoft").join("WindowsApps"));
    }
    if let Some(appdata) = env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(home) = env::var_os("USERPROFILE") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".cursor").join("bin"));
        dirs.push(home.join(".antigravity").join("bin"));
        dirs.push(home.join(".claude").join("bin"));
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
    }
    dirs
}

fn powershell_path_value() -> Option<String> {
    let mut command = Command::new("powershell.exe");
    hide_console(&mut command);
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')",
        ])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub fn refresh_process_path() {
    let mut parts: Vec<PathBuf> = Vec::new();
    if let Some(combined) = powershell_path_value() {
        parts.extend(env::split_paths(&combined));
    }
    if let Some(current) = env::var_os("PATH") {
        parts.extend(env::split_paths(&current));
    }
    parts.extend(extra_bin_dirs());

    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for part in parts {
        if part.as_os_str().is_empty() {
            continue;
        }
        let key = part.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            unique.push(part);
        }
    }
    if let Ok(joined) = env::join_paths(unique) {
        env::set_var("PATH", joined);
    }
}

fn combined_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("{stdout}\n{stderr}")
}

fn looks_installed(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("already installed")
        || lower.contains("no available upgrade")
        || lower.contains("successfully installed")
        || lower.contains("is installed")
        || lower.contains("existing package")
}

fn run_hidden(program: &str, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new(program);
    hide_console(&mut command);
    command
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("{program} 실행 실패: {error}"))
}

pub fn run_powershell(script: &str) -> Result<String, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = env::temp_dir().join(format!(
        "ai-character-setup-{}-{stamp}.ps1",
        std::process::id()
    ));
    let wrapped = format!(
        "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n{script}\n"
    );
    fs::write(&path, wrapped).map_err(|error| format!("설치 스크립트 작성 실패: {error}"))?;
    let path_str = path.to_string_lossy().to_string();
    let result = run_hidden(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &path_str,
        ],
    );
    let _ = fs::remove_file(&path);
    let output = result?;
    let text = combined_text(&output);
    if output.status.success() {
        return Ok(text);
    }
    Err(if text.trim().is_empty() {
        format!("PowerShell 실패 (exit={:?})", output.status.code())
    } else {
        text.trim().to_string()
    })
}

fn winget_args(package_id: &str, user_scope: bool) -> Vec<String> {
    let mut args = vec![
        "install".to_string(),
        "--id".to_string(),
        package_id.to_string(),
        "-e".to_string(),
        "--accept-package-agreements".to_string(),
        "--accept-source-agreements".to_string(),
        "--disable-interactivity".to_string(),
        "--source".to_string(),
        "winget".to_string(),
    ];
    if user_scope {
        args.push("--scope".to_string());
        args.push("user".to_string());
    }
    args
}

fn run_winget_once(package_id: &str, user_scope: bool) -> Result<String, String> {
    refresh_process_path();
    let args = winget_args(package_id, user_scope);
    let mut cmd_args: Vec<&str> = vec!["/D", "/C", "winget"];
    for arg in &args {
        cmd_args.push(arg.as_str());
    }
    let output = run_hidden("cmd.exe", &cmd_args)?;
    let text = combined_text(&output);
    if output.status.success() || looks_installed(&text) {
        refresh_process_path();
        return Ok(format!("{package_id} 설치 완료"));
    }
    Err(text.trim().to_string())
}

pub fn run_winget(package_id: &str) -> Result<String, String> {
    match run_winget_once(package_id, true) {
        Ok(message) => Ok(message),
        Err(user_error) => match run_winget_once(package_id, false) {
            Ok(message) => Ok(message),
            Err(machine_error) => {
                let detail = [user_error, machine_error]
                    .into_iter()
                    .filter(|item| !item.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join(" / ");
                Err(if detail.is_empty() {
                    format!("{package_id} 설치 실패")
                } else {
                    format!("{package_id} 설치 실패: {detail}")
                })
            }
        },
    }
}

fn executable_exists(dir: &Path, names: &[&str]) -> bool {
    names.iter().any(|name| dir.join(name).is_file())
}

pub fn node_binary() -> Option<PathBuf> {
    refresh_process_path();
    if let Some(value) = env::var_os("PATH") {
        for dir in env::split_paths(&value) {
            for name in ["node.exe", "node"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    for dir in extra_bin_dirs() {
        let candidate = dir.join("node.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn npm_command() -> Option<PathBuf> {
    refresh_process_path();
    if let Some(value) = env::var_os("PATH") {
        for dir in env::split_paths(&value) {
            for name in ["npm.cmd", "npm.exe", "npm"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    for dir in extra_bin_dirs() {
        for name in ["npm.cmd", "npm.exe"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn run_npm_global(package: &str) -> Result<String, String> {
    refresh_process_path();
    let npm = npm_command().ok_or_else(|| "npm이 없습니다. Node.js를 먼저 설치하세요.".to_string())?;
    let npm_str = npm.to_string_lossy().to_string();
    let output = run_hidden(
        "cmd.exe",
        &["/D", "/C", &npm_str, "install", "-g", package],
    )?;
    let text = combined_text(&output);
    if output.status.success() {
        refresh_process_path();
        return Ok(format!("{package} 전역 설치 완료"));
    }
    Err(format!(
        "{package} 설치 실패: {}",
        if text.trim().is_empty() {
            format!("exit={:?}", output.status.code())
        } else {
            text.trim().to_string()
        }
    ))
}

pub fn open_url(url: &str) -> Result<(), String> {
    run_hidden("cmd.exe", &["/C", "start", "", url]).map(|_| ())
}

pub fn install_git() -> Result<String, String> {
    refresh_process_path();
    if git_binary().is_some() {
        return Ok("Git 이미 설치됨".into());
    }
    if let Ok(message) = run_winget("Git.Git") {
        refresh_process_path();
        if git_binary().is_some() {
            return Ok(message);
        }
    }

    let script = r#"
$dir = Join-Path $env:TEMP 'ai-character-installers'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'ai-character' }
$asset = $rel.assets | Where-Object { $_.name -match '^Git-.*-64-bit\.exe$' } | Select-Object -First 1
if (-not $asset) { throw 'Git 설치 파일을 찾지 못했습니다.' }
$exe = Join-Path $dir $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing
$target = Join-Path $env:LOCALAPPDATA 'Programs\Git'
$proc = Start-Process -FilePath $exe -ArgumentList @('/VERYSILENT','/NORESTART','/NOCANCEL','/SP-','/CLOSEAPPLICATIONS',"/DIR=$target") -Wait -PassThru -WindowStyle Hidden
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "Git installer exit $($proc.ExitCode)" }
"#;
    run_powershell(script)?;
    refresh_process_path();
    if git_binary().is_some()
        || extra_bin_dirs()
            .iter()
            .any(|dir| executable_exists(dir, &["git.exe"]))
    {
        Ok("Git 설치 완료".into())
    } else {
        let _ = open_url("https://git-scm.com/download/win");
        Err("Git 설치 후에도 실행 파일을 찾지 못해 다운로드 페이지를 열었습니다.".into())
    }
}

pub fn install_node() -> Result<String, String> {
    refresh_process_path();
    if node_binary().is_some() {
        return Ok("Node.js 이미 설치됨".into());
    }
    if let Ok(message) = run_winget("OpenJS.NodeJS.LTS") {
        refresh_process_path();
        if node_binary().is_some() {
            return Ok(message);
        }
    }

    let script = r#"
$dir = Join-Path $env:TEMP 'ai-character-installers'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
$lts = $index | Where-Object { $_.lts -and $_.version -like 'v22*' } | Select-Object -First 1
if (-not $lts) { $lts = $index | Where-Object { $_.lts } | Select-Object -First 1 }
if (-not $lts) { throw 'Node.js LTS 버전을 찾지 못했습니다.' }
$ver = $lts.version
$zipName = "node-$ver-win-x64.zip"
$zip = Join-Path $dir $zipName
Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/$zipName" -OutFile $zip -UseBasicParsing
$extract = Join-Path $dir "node-$ver-win-x64"
if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
$target = Join-Path $env:LOCALAPPDATA 'Programs\nodejs'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $extract '*') -Destination $target -Recurse -Force
"#;
    run_powershell(script)?;
    refresh_process_path();
    if node_binary().is_some() {
        Ok("Node.js 설치 완료".into())
    } else {
        let _ = open_url("https://nodejs.org/en/download");
        Err("Node.js 설치 후에도 실행 파일을 찾지 못해 다운로드 페이지를 열었습니다.".into())
    }
}

pub fn install_claude() -> Result<String, String> {
    if let Ok(message) = run_winget("Anthropic.ClaudeCode") {
        refresh_process_path();
        return Ok(message);
    }
    match run_powershell("irm https://claude.ai/install.ps1 | iex") {
        Ok(_) => {
            refresh_process_path();
            Ok("Claude Code 설치 완료".into())
        }
        Err(script_error) => {
            if node_binary().is_none() {
                let _ = install_node();
            }
            run_npm_global("@anthropic-ai/claude-code").map_err(|npm_error| {
                let _ = open_url("https://docs.anthropic.com/en/docs/claude-code/overview");
                format!("{script_error} / {npm_error} — 문서를 열었습니다.")
            })
        }
    }
}

pub fn install_codex() -> Result<String, String> {
    if let Ok(message) = run_winget("OpenAI.Codex") {
        refresh_process_path();
        return Ok(message);
    }
    match run_powershell("irm https://chatgpt.com/codex/install.ps1 | iex") {
        Ok(_) => {
            refresh_process_path();
            Ok("Codex 설치 완료".into())
        }
        Err(script_error) => {
            if node_binary().is_none() {
                let _ = install_node();
            }
            run_npm_global("@openai/codex").map_err(|npm_error| {
                let _ = open_url("https://github.com/openai/codex");
                format!("{script_error} / {npm_error} — 문서를 열었습니다.")
            })
        }
    }
}

pub fn install_cursor_agent() -> Result<String, String> {
    let mut notes = Vec::new();
    match run_powershell("irm 'https://cursor.com/install?win32=true' | iex") {
        Ok(_) => notes.push("Cursor Agent CLI 설치 완료".to_string()),
        Err(error) => notes.push(error),
    }
    match run_winget("Anysphere.Cursor") {
        Ok(message) => notes.push(message),
        Err(error) => notes.push(error),
    }
    refresh_process_path();
    let local_ok = extra_bin_dirs().iter().any(|dir| {
        executable_exists(
            dir,
            &[
                "cursor-agent.exe",
                "agent.exe",
                "cursor-agent.cmd",
                "agent.cmd",
            ],
        )
    });
    if local_ok || notes.iter().any(|note| note.contains("설치 완료")) {
        Ok(notes.join(" / "))
    } else {
        let _ = open_url("https://cursor.com/download");
        Err(format!(
            "{} — Cursor 다운로드 페이지를 열었습니다.",
            notes.join(" / ")
        ))
    }
}

pub fn install_antigravity() -> Result<String, String> {
    for package in ["Google.AntigravityCLI", "Google.Antigravity"] {
        if let Ok(message) = run_winget(package) {
            refresh_process_path();
            return Ok(message);
        }
    }
    match run_powershell("irm https://antigravity.google/cli/install.ps1 | iex") {
        Ok(_) => {
            refresh_process_path();
            Ok("Antigravity 설치 완료".into())
        }
        Err(error) => {
            let _ = open_url("https://antigravity.google/");
            Err(format!(
                "{error} — Antigravity 공식 설치 페이지를 열었습니다. 설치 후 앱을 다시 실행하세요."
            ))
        }
    }
}
