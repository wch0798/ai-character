use crate::process_util::{secret_value, set_secret_value};
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
OPENROUTER_API_KEY=
JINA_API_KEY=
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GITHUB_TOKEN=
";

const ALLOWED_KEYS: &[&str] = &[
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "JINA_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "GEMINI_MODEL",
    "GEMINI_FREE_MODELS",
    "OPENROUTER_MODEL",
    "OPENAI_MODEL",
    "GROQ_API_KEY",
    "NVIDIA_API_KEY",
    "ZAI_API_KEY",
    "SAMBANOVA_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "SILICONFLOW_API_KEY",
    "SKT_AX_API_KEY",
    "HASA_API_KEY",
    "HUNYUAN_API_KEY",
    "HASA_MODEL",
    "GROQ_MODEL",
    "NVIDIA_MODEL",
    "SAMBANOVA_MODEL",
    "CLOUDFLARE_MODEL",
    "OLLAMA_MODEL",
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
        if secret_value(key).is_some() {
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
        set_secret_value(key, Some(value));
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
                if is_app_keys_file(&path) {
                    let _ = restrict_to_owner(&path);
                }
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
        write_private(&path, TEMPLATE)?;
    }
    restrict_to_owner(&path)?;
    Ok(path)
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("키 파일 권한을 잠그지 못했습니다: {error}"))
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Writes through an owner-only temp file and renames it, so a crash never truncates existing keys.
fn write_private(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension("env.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = options
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(content.as_bytes())?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&temp, path));
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("키 파일 저장 실패: {error}"));
    }
    restrict_to_owner(path)
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
    key_source(name).is_some()
}

fn key_file_with(name: &str) -> Option<PathBuf> {
    candidate_paths().into_iter().find(|path| {
        path.is_file()
            && fs::read_to_string(path)
                .map(|content| key_is_configured_in_content(&content, name))
                .unwrap_or(false)
    })
}

/// Where the active value comes from: a keys file path, or "환경변수" for an inherited variable.
fn key_source(name: &str) -> Option<String> {
    if let Some(path) = key_file_with(name) {
        return Some(path.display().to_string());
    }
    secret_value(name).map(|_| "환경변수".to_string())
}

fn is_app_keys_file(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == KEYS_FILE_NAME)
}

const SECRET_KEYS: &[(&str, &str)] = &[
    ("GEMINI_API_KEY", "Gemini (무료)"),
    ("OPENROUTER_API_KEY", "OpenRouter (무료 모델)"),
    ("JINA_API_KEY", "Jina 웹 검색"),
    ("GROQ_API_KEY", "Groq (무료)"),
    ("NVIDIA_API_KEY", "NVIDIA NIM (무료)"),
    ("ZAI_API_KEY", "Z.ai GLM (무료 Flash)"),
    ("SAMBANOVA_API_KEY", "SambaNova (무료)"),
    ("CLOUDFLARE_API_TOKEN", "Cloudflare Workers AI 토큰 (무료)"),
    ("CLOUDFLARE_ACCOUNT_ID", "Cloudflare 계정 ID"),
    ("SILICONFLOW_API_KEY", "SiliconFlow (무료 소형 모델)"),
    ("SKT_AX_API_KEY", "SKT A.X (무료 체험 공개 키)"),
    ("HASA_API_KEY", "HASA 공공 AI 허브 (무료 개발 키)"),
    ("HUNYUAN_API_KEY", "Tencent Hunyuan (무료 lite)"),
    ("GITHUB_TOKEN", "GitHub 토큰"),
    ("OPENAI_API_KEY", "OpenAI (유료, 승인 후 사용)"),
    ("ANTHROPIC_API_KEY", "Anthropic (유료, 승인 후 사용)"),
];

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    pub name: String,
    pub label: String,
    pub configured: bool,
    /// Never the key itself: a file path or "환경변수".
    pub source: Option<String>,
    pub testable: bool,
}

/// Replaces (or appends) `name=value` while keeping comments and other keys intact.
/// An empty value removes the key.
pub fn upsert_key_line(content: &str, name: &str, value: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut written = false;
    for raw_line in content.lines() {
        let line = raw_line.trim();
        let uncommented = line.trim_start_matches('#').trim();
        let matches = uncommented
            .split_once('=')
            .map(|(key, _)| key.trim() == name)
            .unwrap_or(false);
        if !matches {
            lines.push(raw_line.to_string());
            continue;
        }
        if written {
            continue;
        }
        written = true;
        if value.is_empty() {
            lines.push(format!("{name}="));
        } else {
            lines.push(format!("{name}={value}"));
        }
    }
    if !written && !value.is_empty() {
        lines.push(format!("{name}={value}"));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

pub(crate) fn api_key_statuses() -> Vec<ApiKeyStatus> {
    SECRET_KEYS
        .iter()
        .map(|(name, label)| {
            let source = key_source(name);
            ApiKeyStatus {
                name: name.to_string(),
                label: label.to_string(),
                configured: source.is_some(),
                source,
                testable: key_test_endpoint(name).is_some(),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn get_api_key_status() -> Result<Vec<ApiKeyStatus>, String> {
    tauri::async_runtime::spawn_blocking(api_key_statuses)
        .await
        .map_err(|error| format!("키 상태 확인 실패: {error}"))
}

pub(crate) fn save_api_key_blocking(name: &str, value: &str) -> Result<Vec<ApiKeyStatus>, String> {
    if !SECRET_KEYS.iter().any(|(allowed, _)| *allowed == name) {
        return Err("저장할 수 없는 키 이름입니다.".to_string());
    }
    if value.chars().any(|c| c.is_whitespace() || c == '#' || c == '"' || c == '\'') {
        return Err("키에 공백이나 따옴표가 들어갈 수 없습니다.".to_string());
    }
    let preferred = ensure_keys_env_file()?;
    let mut targets = vec![preferred.clone()];
    if value.is_empty() {
        // Only app-owned keys.env files are edited; a project's own .env stays untouched.
        targets.extend(
            candidate_paths()
                .into_iter()
                .filter(|path| path != &preferred && path.is_file() && is_app_keys_file(path)),
        );
    }
    for path in targets {
        let content = fs::read_to_string(&path).map_err(|error| format!("키 파일 읽기 실패: {error}"))?;
        let updated = upsert_key_line(&content, name, value);
        if updated != content {
            write_private(&path, &updated)?;
        }
    }
    set_secret_value(name, (!value.is_empty()).then(|| value.to_string()));
    Ok(api_key_statuses())
}

#[tauri::command]
pub async fn save_api_key(name: String, value: String) -> Result<Vec<ApiKeyStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || save_api_key_blocking(name.trim(), value.trim()))
        .await
        .map_err(|error| format!("키 저장 실패: {error}"))?
}

/// Read-only account/model listing endpoints that are never billed.
fn key_test_endpoint(name: &str) -> Option<&'static str> {
    match name {
        "GEMINI_API_KEY" => Some("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"),
        "OPENROUTER_API_KEY" => Some("https://openrouter.ai/api/v1/key"),
        "GROQ_API_KEY" => Some("https://api.groq.com/openai/v1/models"),
        "NVIDIA_API_KEY" => Some("https://integrate.api.nvidia.com/v1/models"),
        "SAMBANOVA_API_KEY" => Some("https://api.sambanova.ai/v1/models"),
        "SILICONFLOW_API_KEY" => Some("https://api.siliconflow.com/v1/models"),
        "GITHUB_TOKEN" => Some("https://api.github.com/user"),
        "OPENAI_API_KEY" => Some("https://api.openai.com/v1/models"),
        "ANTHROPIC_API_KEY" => Some("https://api.anthropic.com/v1/models?limit=1"),
        _ => None,
    }
}

#[tauri::command]
pub async fn test_api_key(name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    let endpoint = key_test_endpoint(&name).ok_or("이 키는 연결 테스트를 지원하지 않습니다.")?;
    let value = secret_value(&name).ok_or("키가 아직 앱에 적용되지 않았습니다. 먼저 저장하세요.")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("AI-Character key-check")
        .build()
        .map_err(|error| format!("연결 준비 실패: {error}"))?;
    let request = client.get(endpoint);
    let request = match name.as_str() {
        "GEMINI_API_KEY" => request.header("x-goog-api-key", &value),
        "ANTHROPIC_API_KEY" => request.header("x-api-key", &value).header("anthropic-version", "2023-06-01"),
        _ => request.bearer_auth(&value),
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("연결 실패: {}", crate::policy_engine::mask_secrets(&error.to_string())))?;
    let status = response.status();
    if status.is_success() {
        Ok("연결 확인됨 (요금이 들지 않는 조회로 확인했습니다)".to_string())
    } else if status.as_u16() == 401 || status.as_u16() == 403 {
        Err(format!("키가 거부되었습니다 (HTTP {status}). 키를 다시 확인하세요."))
    } else {
        Err(format!("서비스 응답 오류 (HTTP {status})"))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_replaces_commented_and_existing_lines_once() {
        let content = "# header\nGEMINI_API_KEY=\n# OPENAI_API_KEY=\nJINA_API_KEY=keep\n";
        let updated = upsert_key_line(content, "OPENAI_API_KEY", "abc123");
        assert_eq!(updated, "# header\nGEMINI_API_KEY=\nOPENAI_API_KEY=abc123\nJINA_API_KEY=keep\n");
        let cleared = upsert_key_line(&updated, "OPENAI_API_KEY", "");
        assert!(cleared.contains("OPENAI_API_KEY=\n"));
        let appended = upsert_key_line("# only\n", "GITHUB_TOKEN", "t0k");
        assert_eq!(appended, "# only\nGITHUB_TOKEN=t0k\n");
    }

    #[cfg(unix)]
    #[test]
    fn private_write_is_owner_only_and_replaces_content() {
        use std::os::unix::fs::PermissionsExt;
        let dir = env::temp_dir().join(format!("aic-keys-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(KEYS_FILE_NAME);
        fs::write(&path, "OLD=1\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&path, "NEW=2\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "NEW=2\n");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(!path.with_extension("env.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_free_listing_endpoints_are_used_for_key_tests() {
        assert!(key_test_endpoint("JINA_API_KEY").is_none());
        for (name, _) in SECRET_KEYS {
            if let Some(url) = key_test_endpoint(name) {
                assert!(url.contains("/models") || url.ends_with("/key") || url.ends_with("/user"), "{url}");
            }
        }
    }
}
