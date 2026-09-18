//! 기본 브라우저/구글 계정과 섞이지 않는 로그인용 브라우저 프로필.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn profile_root() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .ok_or_else(|| "사용자 데이터 폴더를 찾지 못했습니다.".to_string())?;
    Ok(base.join("ai-character").join("isolated-browser"))
}

pub fn profile_dir(profile_id: &str) -> Result<PathBuf, String> {
    let dir = profile_root()?.join(sanitize(profile_id));
    fs::create_dir_all(&dir)
        .map_err(|error| format!("분리 브라우저 프로필 폴더 생성 실패: {error}"))?;
    Ok(dir)
}

fn sanitize(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn chromium_browser() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let root = PathBuf::from(program_files);
        candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
        candidates.push(root.join("Google/Chrome/Application/chrome.exe"));
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        let root = PathBuf::from(program_files_x86);
        candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
        candidates.push(root.join("Google/Chrome/Application/chrome.exe"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local).join("Google/Chrome/Application/chrome.exe"),
        );
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "분리 로그인용 Edge/Chrome을 찾지 못했습니다. Edge 또는 Chrome을 설치하세요."
                .to_string()
        })
}

/// 기본 구글/Edge 프로필과 분리된 창으로 URL을 엽니다.
pub fn open_url(profile_id: &str, url: &str) -> Result<(), String> {
    let browser = chromium_browser()?;
    let profile = profile_dir(profile_id)?;
    let mut command = Command::new(&browser);
    #[cfg(windows)]
    {
        crate::windows_process::hide_console(&mut command);
    }
    command
        .args([
            format!("--user-data-dir={}", profile.display()),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
            "--disable-sync".into(),
            "--disable-features=FedCm,Translate".into(),
            "--new-window".into(),
            url.to_string(),
        ])
        .spawn()
        .map_err(|error| format!("분리 브라우저 실행 실패: {error}"))?;
    Ok(())
}

/// CLI가 시스템 기본 브라우저 대신 이 스크립트를 열도록 BROWSER에 넣습니다.
pub fn browser_launcher(profile_id: &str) -> Result<PathBuf, String> {
    let browser = chromium_browser()?;
    let profile = profile_dir(profile_id)?;
    let script = profile_root()?.join(format!("launch-{}.cmd", sanitize(profile_id)));
    if let Some(parent) = script.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("브라우저 런처 폴더 생성 실패: {error}"))?;
    }
    let body = format!(
        "@echo off\r\nsetlocal\r\nstart \"\" \"{browser}\" --user-data-dir=\"{profile}\" --no-first-run --no-default-browser-check --disable-sync --disable-features=FedCm,Translate --new-window %*\r\n",
        browser = browser.display(),
        profile = profile.display(),
    );
    fs::write(&script, body).map_err(|error| format!("브라우저 런처 작성 실패: {error}"))?;
    Ok(script)
}

pub fn cli_browser_env(profile_id: &str) -> Result<Vec<(String, String)>, String> {
    let launcher = browser_launcher(profile_id)?;
    let value = launcher.display().to_string();
    Ok(vec![
        ("BROWSER".into(), value.clone()),
        ("GH_BROWSER".into(), value.clone()),
        ("GIT_BROWSER".into(), value),
    ])
}

#[allow(dead_code)]
pub fn launcher_exists(path: &Path) -> bool {
    path.is_file()
}
