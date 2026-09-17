use crate::settings::load_settings;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const KEYS_FILE_NAME: &str = "keys.env";
const TEMPLATE: &str = "# AI-Character local API keys
# 이 파일은 git에 올라가지 않습니다. 값을 채운 뒤 앱을 다시 실행하세요.
# npm run tauri dev

GEMINI_API_KEY=
JINA_API_KEY=
# OPENAI_API_KEY=
";

const ALLOWED_KEYS: &[&str] = &[
    "GEMINI_API_KEY",
    "JINA_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_MODEL",
    "OPENAI_MODEL",
];

fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(custom) = env::var("AI_CHARACTER_KEYS_FILE") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            paths.push(PathBuf::from(trimmed));
        }
    }
    // 앱 지원 폴더를 프로젝트(/Volumes)보다 우선 — 시작 시 외장 디스크 TCC를 피함
    #[cfg(target_os = "macos")]
    if let Some(home) = env::var_os("HOME") {
        paths.push(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("AI-Character")
                .join(KEYS_FILE_NAME),
        );
    }
    #[cfg(windows)]
    if let Some(appdata) = env::var_os("APPDATA") {
        paths.push(
            PathBuf::from(appdata)
                .join("AI-Character")
                .join(KEYS_FILE_NAME),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(config) = env::var_os("XDG_CONFIG_HOME") {
            paths.push(
                PathBuf::from(config)
                    .join("ai-character")
                    .join(KEYS_FILE_NAME),
            );
        } else if let Some(home) = env::var_os("HOME") {
            paths.push(
                PathBuf::from(home)
                    .join(".config")
                    .join("ai-character")
                    .join(KEYS_FILE_NAME),
            );
        }
    }
    if let Ok(settings) = load_settings() {
        if let Some(project) = settings.project_dir {
            paths.push(project.join(".ai-character").join(KEYS_FILE_NAME));
        }
    }
    if let Ok(cwd) = env::current_dir() {
        paths.push(cwd.join(".ai-character").join(KEYS_FILE_NAME));
        paths.push(cwd.join(".env.local"));
        paths.push(cwd.join(".env"));
    }
    paths
}

pub fn preferred_keys_path() -> PathBuf {
    if let Ok(custom) = env::var("AI_CHARACTER_KEYS_FILE") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = env::var_os("HOME") {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("AI-Character")
            .join(KEYS_FILE_NAME);
    }
    #[cfg(windows)]
    if let Some(appdata) = env::var_os("APPDATA") {
        return PathBuf::from(appdata)
            .join("AI-Character")
            .join(KEYS_FILE_NAME);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(config) = env::var_os("XDG_CONFIG_HOME") {
            return PathBuf::from(config)
                .join("ai-character")
                .join(KEYS_FILE_NAME);
        }
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home)
                .join(".config")
                .join("ai-character")
                .join(KEYS_FILE_NAME);
        }
    }
    if let Ok(settings) = load_settings() {
        if let Some(project) = settings.project_dir {
            return project.join(".ai-character").join(KEYS_FILE_NAME);
        }
    }
    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".ai-character")
        .join(KEYS_FILE_NAME)
}

fn is_allowed_key(name: &str) -> bool {
    ALLOWED_KEYS.iter().any(|allowed| *allowed == name)
}

fn parse_and_apply(content: &str) -> usize {
    let mut applied = 0;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !is_allowed_key(key) {
            continue;
        }
        if env::var_os(key).is_some() {
            continue;
        }
        let mut value = value.trim().to_string();
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = value[1..value.len().saturating_sub(1)].to_string();
        }
        if value.is_empty() {
            continue;
        }
        env::set_var(key, value);
        applied += 1;
    }
    applied
}

fn path_may_need_removable_tcc(path: &Path) -> bool {
    // macOS에서 /Volumes 아래는 제거 가능 볼륨 TCC 프롬프트를 유발할 수 있음
    path.components().any(|c| {
        matches!(c, std::path::Component::Normal(name) if name == "Volumes")
    })
}

pub fn load_on_startup() -> Option<PathBuf> {
    // 시작 직후엔 홈/앱 지원 경로만 읽어 외장 디스크 권한 대화에 막히지 않게 한다.
    for path in candidate_paths() {
        if path_may_need_removable_tcc(&path) {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(content) => {
                let applied = parse_and_apply(&content);
                eprintln!(
                    "AI-Character: loaded {} key(s) from {}",
                    applied,
                    path.display()
                );
                return Some(path);
            }
            Err(error) => {
                eprintln!(
                    "AI-Character: failed to read keys file {}: {error}",
                    path.display()
                );
            }
        }
    }
    None
}

pub fn ensure_keys_env_file() -> Result<PathBuf, String> {
    let path = preferred_keys_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("키 폴더를 만들지 못했습니다: {error}"))?;
    }
    if !path.exists() {
        fs::write(&path, TEMPLATE)
            .map_err(|error| format!("키 파일을 만들지 못했습니다: {error}"))?;
    }
    Ok(path)
}

pub fn open_keys_env_file() -> Result<String, String> {
    let path = ensure_keys_env_file()?;
    open_path(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .status()
            .map_err(|error| format!("키 파일 열기 실패: {error}"))?;
        return Ok(());
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("cmd");
        crate::windows_process::hide_console(&mut command);
        command
            .args(["/C", "start", "", &path.to_string_lossy()])
            .status()
            .map_err(|error| format!("키 파일 열기 실패: {error}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|error| format!("키 파일 열기 실패: {error}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("이 OS에서는 키 파일 자동 열기를 지원하지 않습니다.".to_string())
}

pub fn loaded_keys_path() -> Option<String> {
    candidate_paths()
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

fn key_is_configured_in_content(content: &str, name: &str) -> bool {
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != name {
            continue;
        }
        let mut value = value.trim().to_string();
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = value[1..value.len().saturating_sub(1)].to_string();
        }
        return !value.is_empty();
    }
    false
}

fn key_is_configured(name: &str) -> bool {
    if env::var(name).map(|value| !value.trim().is_empty()).unwrap_or(false) {
        return true;
    }
    for path in candidate_paths() {
        if !path.is_file() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if key_is_configured_in_content(&content, name) {
                return true;
            }
        }
    }
    false
}

pub fn configured_account_summary() -> String {
    let accounts = [
        ("GEMINI_API_KEY", "Gemini API"),
        ("OPENAI_API_KEY", "OpenAI API"),
        ("JINA_API_KEY", "Jina search"),
    ];
    let lines: Vec<String> = accounts
        .iter()
        .map(|(key, label)| {
            format!(
                "- {label}: {}",
                if key_is_configured(key) {
                    "configured"
                } else {
                    "not configured"
                }
            )
        })
        .collect();
    if lines.is_empty() {
        "- none listed".to_string()
    } else {
        lines.join("\n")
    }
}
