use crate::agent_core::{resolve_agent_binary, AgentKind};
use crate::process_util;
use crate::settings::load_settings;
use crate::windows_process::command_with_args;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const OFFICIAL_MARKETPLACE: &str = "claude-plugins-official";
const OFFICIAL_MARKETPLACE_SOURCE: &str = "anthropics/claude-plugins-official";
const COMMUNITY_MARKETPLACE_SOURCE: &str = "anthropics/claude-plugins-community";
const PLUGIN_CATALOG_URL: &str = "https://claude.com/plugins";
const PLUGIN_OFFICIAL_REPO_URL: &str = "https://github.com/anthropics/claude-plugins-official";

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePlugin {
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub version: String,
    pub description: String,
    pub installed: bool,
    pub enabled: bool,
    pub source: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePluginSnapshot {
    pub claude_ready: bool,
    pub marketplace_ready: bool,
    pub claude_path: String,
    pub message: String,
    pub marketplaces: Vec<String>,
    pub installed: Vec<ClaudePlugin>,
    pub available: Vec<ClaudePlugin>,
}

fn claude_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".claude"))
}

fn claude_binary() -> Result<PathBuf, String> {
    #[cfg(windows)]
    crate::windows_setup::refresh_process_path();
    let settings = load_settings().ok();
    let saved = settings
        .as_ref()
        .and_then(|item| item.agent_path(AgentKind::Claude).map(PathBuf::as_path));
    resolve_agent_binary(AgentKind::Claude, saved)
}

fn run_claude(args: &[&str], timeout: Duration) -> Result<String, String> {
    let binary = claude_binary()?;
    let mut command = command_with_args(&binary, args);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.stdin(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Claude 플러그인 명령 실패: {error}"))?;
    let stdout_reader = child.stdout.take().map(process_util::spawn_reader);
    let stderr_reader = child.stderr.take().map(process_util::spawn_reader);
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                // Left running, it would keep working (and holding files) after we gave up.
                process_util::kill_tree(&mut child);
                let _ = child.wait();
                return Err("Claude 플러그인 명령이 너무 오래 걸려 중단했습니다.".to_string());
            }
            Err(error) => return Err(format!("Claude 플러그인 명령 실패: {error}")),
        }
    };
    let deadline = Instant::now() + process_util::PIPE_GRACE;
    let collect = |reader: Option<(process_util::SharedOutput, std::thread::JoinHandle<()>)>| {
        reader
            .map(|(output, handle)| process_util::collect_until(&output, handle, deadline))
            .unwrap_or_default()
    };
    let stdout = String::from_utf8_lossy(&collect(stdout_reader)).trim().to_string();
    let stderr = String::from_utf8_lossy(&collect(stderr_reader)).trim().to_string();
    if status.success() {
        return Ok(if stdout.is_empty() { stderr } else { stdout });
    }
    let detail = if stderr.is_empty() { stdout } else { stderr };
    if is_already_registered_error(&detail) {
        return Ok(detail);
    }
    Err(friendly_plugin_error(&detail))
}

fn is_already_registered_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("already")
        || lower.contains("exists")
        || lower.contains("duplicate")
        || lower.contains("이미")
}

fn friendly_plugin_error(detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    if detail.trim().is_empty() {
        "Claude 플러그인 명령이 실패했습니다.".to_string()
    } else if lower.contains("not found")
        || lower.contains("enoent")
        || lower.contains("찾을 수 없")
    {
        format!("Claude CLI를 찾지 못했습니다. 설정에서 Claude를 설치한 뒤 다시 연결하세요. {detail}")
    } else if lower.contains("login") || lower.contains("unauthorized") || lower.contains("auth")
    {
        format!("Claude 로그인이 필요합니다. 설정 → 로그인에서 Claude 로그인을 하세요. {detail}")
    } else if lower.contains("enotfound")
        || lower.contains("econn")
        || lower.contains("network")
        || lower.contains("offline")
        || lower.contains("연결")
    {
        format!("인터넷에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 누르세요. {detail}")
    } else {
        detail.to_string()
    }
}

pub fn sanitize_plugin_spec(raw: &str) -> Result<String, String> {
    let spec = raw.trim();
    if spec.is_empty() || spec.len() > 160 {
        return Err("플러그인 이름을 확인해주세요.".to_string());
    }
    if !spec
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '@' | '/'))
    {
        return Err("플러그인 이름에 사용할 수 없는 문자가 있습니다.".to_string());
    }
    Ok(spec.to_string())
}

fn qualify_plugin_spec(raw: &str) -> Result<String, String> {
    let spec = sanitize_plugin_spec(raw)?;
    if spec.contains('@') {
        Ok(spec)
    } else {
        Ok(format!("{spec}@{OFFICIAL_MARKETPLACE}"))
    }
}

fn plugin_id(name: &str, marketplace: &str) -> String {
    if name.contains('@') || marketplace.is_empty() {
        name.to_string()
    } else {
        format!("{name}@{marketplace}")
    }
}

fn recommended_plugins() -> Vec<ClaudePlugin> {
    [
        ("frontend-design", "UI·프론트 디자인 작업을 도와줍니다."),
        ("feature-dev", "기능 개발 흐름을 도와줍니다."),
        ("code-review", "코드 리뷰를 도와줍니다."),
        ("commit-commands", "커밋 관련 명령을 추가합니다."),
        ("security-guidance", "보안 가이드를 같이 씁니다."),
    ]
    .into_iter()
    .map(|(name, description)| ClaudePlugin {
        id: plugin_id(name, OFFICIAL_MARKETPLACE),
        name: name.to_string(),
        marketplace: OFFICIAL_MARKETPLACE.to_string(),
        version: String::new(),
        description: description.to_string(),
        installed: false,
        enabled: false,
        source: "recommended".to_string(),
    })
    .collect()
}

fn string_field(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn bool_field(value: &Value, keys: &[&str], default: bool) -> bool {
    for key in keys {
        if let Some(flag) = value.get(*key).and_then(Value::as_bool) {
            return flag;
        }
    }
    default
}

fn plugin_from_value(value: &Value) -> Option<ClaudePlugin> {
    let object = value.as_object()?;
    if object.contains_key("plugins") && !object.contains_key("enabled") && !object.contains_key("installed") {
        return None;
    }
    let name = string_field(value, &["name", "id", "plugin"]);
    if name.is_empty() {
        return None;
    }
    let marketplace = string_field(value, &["marketplace", "source", "marketplaceName"]);
    let installed = bool_field(value, &["installed", "isInstalled"], marketplace.is_empty() || object.contains_key("enabled"));
    Some(ClaudePlugin {
        id: plugin_id(&name, &marketplace),
        name,
        marketplace,
        version: string_field(value, &["version"]),
        description: string_field(value, &["description", "summary"]),
        installed,
        enabled: bool_field(value, &["enabled", "isEnabled", "active"], installed),
        source: if installed {
            "installed".to_string()
        } else {
            "marketplace".to_string()
        },
    })
}

fn collect_plugins(value: &Value, out: &mut Vec<ClaudePlugin>) {
    match value {
        Value::Array(items) => {
            for item in items {
                if let Some(plugin) = plugin_from_value(item) {
                    out.push(plugin);
                } else {
                    collect_plugins(item, out);
                }
            }
        }
        Value::Object(map) => {
            if let Some(plugin) = plugin_from_value(value) {
                out.push(plugin);
                return;
            }
            for key in ["plugins", "installed", "available", "disabled", "items", "data"] {
                if let Some(child) = map.get(key) {
                    collect_plugins(child, out);
                }
            }
        }
        _ => {}
    }
}

pub fn parse_plugin_list_json(raw: &str) -> Vec<ClaudePlugin> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut plugins = Vec::new();
    collect_plugins(&value, &mut plugins);
    plugins
}

pub fn parse_plugin_list_text(raw: &str) -> Vec<ClaudePlugin> {
    let mut plugins = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("Available") || line.starts_with("Installed") {
            continue;
        }
        let enabled = !line.to_ascii_lowercase().contains("disabled");
        let installed = !line.to_ascii_lowercase().contains("available");
        let mut name = line
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(|ch| ch == '-' || ch == '*')
            .to_string();
        let marketplace = line
            .split('@')
            .nth(1)
            .map(|part| {
                part.split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_')
                    .to_string()
            })
            .unwrap_or_default();
        if name.contains('@') {
            name = name.split('@').next().unwrap_or(&name).to_string();
        }
        if name.is_empty() || name.eq_ignore_ascii_case("name") {
            continue;
        }
        plugins.push(ClaudePlugin {
            id: plugin_id(&name, &marketplace),
            name,
            marketplace,
            version: String::new(),
            description: String::new(),
            installed,
            enabled: enabled && installed,
            source: if installed {
                "installed".to_string()
            } else {
                "marketplace".to_string()
            },
        });
    }
    plugins
}

fn is_claude_plugin_dir(path: &Path) -> bool {
    path.join("plugin.json").is_file()
        || path.join(".claude-plugin").join("plugin.json").is_file()
}

fn read_plugin_name(path: &Path) -> String {
    for candidate in [path.join("plugin.json"), path.join(".claude-plugin").join("plugin.json")] {
        if let Ok(raw) = std::fs::read_to_string(candidate) {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                let name = string_field(&value, &["name"]);
                if !name.is_empty() {
                    return name;
                }
            }
        }
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("plugin")
        .to_string()
}

fn scan_local_plugin_dir(root: &Path) -> Vec<ClaudePlugin> {
    let mut plugins = Vec::new();
    if !root.is_dir() {
        return plugins;
    }
    if is_claude_plugin_dir(root) {
        let name = read_plugin_name(root);
        plugins.push(ClaudePlugin {
            id: name.clone(),
            name,
            marketplace: "local".to_string(),
            version: String::new(),
            description: root.display().to_string(),
            installed: true,
            enabled: true,
            source: "local".to_string(),
        });
        return plugins;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return plugins;
    };
    for entry in entries.flatten() {
        let child = entry.path();
        if !child.is_dir() {
            continue;
        }
        let skip = child
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, "marketplaces" | "cache" | ".git"));
        if skip {
            continue;
        }
        if is_claude_plugin_dir(&child) {
            let name = read_plugin_name(&child);
            plugins.push(ClaudePlugin {
                id: name.clone(),
                name,
                marketplace: "local".to_string(),
                version: String::new(),
                description: child.display().to_string(),
                installed: true,
                enabled: true,
                source: "local".to_string(),
            });
        }
    }
    plugins
}

fn local_plugins() -> Vec<ClaudePlugin> {
    let mut plugins = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        plugins.extend(scan_local_plugin_dir(&home.join(".claude").join("plugins")));
        plugins.extend(scan_local_plugin_dir(
            &home.join(".claude").join("plugins").join("local"),
        ));
        plugins.extend(scan_local_plugin_dir(&home.join(".claude").join("skills")));
    }
    if let Ok(settings) = load_settings() {
        if let Some(project) = settings.project_dir.as_ref() {
            plugins.extend(scan_local_plugin_dir(&project.join(".claude").join("plugins")));
        }
    }
    plugins
}

fn enabled_from_settings() -> Vec<String> {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return Vec::new();
    };
    let path = PathBuf::from(home).join(".claude").join("settings.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(map) = value.get("enabledPlugins").and_then(Value::as_object) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(key, flag)| {
            if flag.as_bool().unwrap_or(false) {
                Some(key.clone())
            } else {
                None
            }
        })
        .collect()
}

fn read_json_object(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()))
}

/// For files we rewrite: a missing file is empty, but one we can't read or parse must stop the
/// write. Treating it as `{}` would replace the user's Claude settings (permissions, hooks,
/// model) with only our one key.
fn read_json_object_for_update(path: &Path) -> Result<Value, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        Err(error) => {
            return Err(format!(
                "{}을(를) 읽지 못해 바꾸지 않았습니다. Claude가 쓰는 중일 수 있으니 잠시 뒤 다시 시도하세요. ({error})",
                path.display()
            ))
        }
    };
    let raw = raw.trim_start_matches('\u{feff}');
    if raw.trim().is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    serde_json::from_str::<Value>(raw)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| {
            format!(
                "{}의 내용이 올바른 설정 형식이 아니라 바꾸지 않았습니다. 파일을 열어 고친 뒤 다시 시도하세요.",
                path.display()
            )
        })
}

/// Written to a temporary file next to the target and then swapped in, so a crash mid-write
/// never leaves a half-written settings file.
fn write_json_object(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("폴더를 만들지 못했습니다: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(value)
        .map_err(|error| format!("설정 저장 실패: {error}"))?;
    let mut temp = path.as_os_str().to_owned();
    temp.push(".ai-character.tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, raw).map_err(|error| format!("설정 저장 실패: {error}"))?;
    std::fs::rename(&temp, path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("설정 저장 실패: {error}")
    })
}

/// Marketplace names become folders under ~/.claude/plugins/marketplaces, which is emptied
/// before a fresh download, so an empty name or `..` would point at the whole folder.
pub fn is_safe_marketplace_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

/// `owner/repo` (also `github.com/owner/repo`, a trailing `/` or `.git`) → (name, `owner/repo`).
pub fn custom_marketplace(source: &str) -> Result<(String, String), String> {
    let invalid = || "마켓 주소는 GitHub의 ‘소유자/저장소’ 형태로 적어주세요. 예: anthropics/claude-plugins-official".to_string();
    let source = source.strip_prefix("github.com/").unwrap_or(source);
    let source = source.strip_suffix('/').unwrap_or(source);
    let source = source.strip_suffix(".git").unwrap_or(source);
    let mut parts = source.split('/');
    let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(invalid());
    };
    if !is_safe_marketplace_name(owner) || !is_safe_marketplace_name(repo) {
        return Err(invalid());
    }
    Ok((repo.to_string(), format!("{owner}/{repo}")))
}

pub fn register_known_marketplace(home: &Path, name: &str, repo: &str) -> Result<PathBuf, String> {
    if !is_safe_marketplace_name(name) {
        return Err(format!("마켓 이름 ‘{name}’은(는) 쓸 수 없습니다."));
    }
    let install_dir = home.join("plugins").join("marketplaces").join(name);
    std::fs::create_dir_all(&install_dir)
        .map_err(|error| format!("마켓 폴더를 만들지 못했습니다: {error}"))?;

    let settings_path = home.join("settings.json");
    let mut settings = read_json_object_for_update(&settings_path)?;
    let extra = settings
        .as_object_mut()
        .ok_or_else(|| "Claude 설정을 읽지 못했습니다.".to_string())?
        .entry("extraKnownMarketplaces")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    extra.as_object_mut().ok_or_else(|| "마켓 설정을 쓰지 못했습니다.".to_string())?
        .insert(
            name.to_string(),
            serde_json::json!({
                "source": {
                    "source": "github",
                    "repo": repo
                }
            }),
        );
    write_json_object(&settings_path, &settings)?;

    let known_path = home.join("plugins").join("known_marketplaces.json");
    let mut known = read_json_object_for_update(&known_path)?;
    known.as_object_mut().ok_or_else(|| "마켓 목록을 쓰지 못했습니다.".to_string())?
        .insert(
            name.to_string(),
            serde_json::json!({
                "source": {
                    "source": "github",
                    "repo": repo
                },
                "installLocation": install_dir.to_string_lossy()
            }),
        );
    write_json_object(&known_path, &known)?;
    Ok(install_dir)
}

pub fn registered_marketplaces(home: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let mut push = |value: &Value| {
        if let Some(map) = value.as_object() {
            for key in map.keys() {
                if !names.iter().any(|existing| existing == key) {
                    names.push(key.clone());
                }
            }
        }
    };
    push(&read_json_object(&home.join("settings.json")).get("extraKnownMarketplaces").cloned().unwrap_or(Value::Null));
    push(&read_json_object(&home.join("plugins").join("known_marketplaces.json")));
    names
}

fn marketplace_catalog_exists(dir: &Path) -> bool {
    dir.join(".claude-plugin").join("marketplace.json").is_file()
        || dir.join("marketplace.json").is_file()
}

fn clone_marketplace(install_dir: &Path, repo: &str) -> Result<(), String> {
    if marketplace_catalog_exists(install_dir) {
        return Ok(());
    }
    let Some(git) = crate::environment_preflight::git_binary() else {
        return Err("Git이 없어 공식 마켓을 받지 못했습니다. 설정에서 Git을 설치하세요.".to_string());
    };
    let safe_to_replace = install_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_safe_marketplace_name);
    if !safe_to_replace {
        return Err("마켓 폴더 위치가 올바르지 않아 받지 않았습니다.".to_string());
    }
    if install_dir.exists() {
        let _ = std::fs::remove_dir_all(install_dir);
    }
    if let Some(parent) = install_dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("마켓 폴더를 만들지 못했습니다: {error}"))?;
    }
    let url = format!("https://github.com/{repo}.git");
    let args = ["clone".to_string(), "--depth".into(), "1".into(), url, install_dir.to_string_lossy().into_owned()];
    // A repo that doesn't exist makes Git ask for a password; nobody can answer that prompt here.
    let envs = [("GIT_TERMINAL_PROMPT", OsString::from("0")), ("GCM_INTERACTIVE", OsString::from("never"))];
    let output = process_util::run_command(&git, &args, None, &envs, Duration::from_secs(180));
    if output.success && marketplace_catalog_exists(install_dir) {
        return Ok(());
    }
    if output.timed_out {
        return Err("마켓 목록을 받는 데 너무 오래 걸려 중단했습니다. 네트워크를 확인하세요.".to_string());
    }
    let detail = output.output.trim().to_string();
    Err(if detail.is_empty() {
        "공식 마켓을 받지 못했습니다. 네트워크를 확인하세요.".to_string()
    } else {
        friendly_plugin_error(&detail)
    })
}

fn merge_plugin(target: &mut Vec<ClaudePlugin>, incoming: ClaudePlugin) {
    if let Some(existing) = target.iter_mut().find(|item| item.id == incoming.id || item.name == incoming.name) {
        if existing.description.is_empty() {
            existing.description = incoming.description;
        }
        if existing.marketplace.is_empty() {
            existing.marketplace = incoming.marketplace;
        }
        if existing.version.is_empty() {
            existing.version = incoming.version;
        }
        existing.installed = existing.installed || incoming.installed;
        existing.enabled = existing.enabled || incoming.enabled;
        return;
    }
    target.push(incoming);
}

fn snapshot_from_cli() -> Result<ClaudePluginSnapshot, String> {
    let binary = claude_binary()?;
    let mut marketplaces = run_claude(
        &["plugin", "marketplace", "list"],
        Duration::from_secs(20),
    )
    .unwrap_or_default()
    .lines()
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .map(ToString::to_string)
    .collect::<Vec<_>>();
    if let Some(home) = claude_home() {
        for name in registered_marketplaces(&home) {
            if !marketplaces.iter().any(|existing| existing.contains(&name)) {
                marketplaces.push(name);
            }
        }
    }

    let listed = match run_claude(
        &["plugin", "list", "--json", "--available"],
        Duration::from_secs(40),
    ) {
        Ok(text) => text,
        Err(_) => run_claude(&["plugin", "list", "--json"], Duration::from_secs(20))
            .or_else(|_| run_claude(&["plugin", "list"], Duration::from_secs(20)))
            .unwrap_or_default(),
    };

    let mut parsed = parse_plugin_list_json(&listed);
    if parsed.is_empty() {
        parsed = parse_plugin_list_text(&listed);
    }

    let enabled = enabled_from_settings();
    let mut installed = Vec::new();
    let mut available = Vec::new();
    for mut plugin in parsed {
        if enabled.iter().any(|key| key == &plugin.id || key.starts_with(&format!("{}@", plugin.name))) {
            plugin.enabled = true;
            plugin.installed = true;
        }
        if plugin.installed {
            merge_plugin(&mut installed, plugin);
        } else {
            merge_plugin(&mut available, plugin);
        }
    }
    for plugin in local_plugins() {
        merge_plugin(&mut installed, plugin);
    }
    for mut plugin in recommended_plugins() {
        if installed.iter().any(|item| item.name == plugin.name) {
            continue;
        }
        if available.iter().any(|item| item.name == plugin.name) {
            continue;
        }
        plugin.source = "recommended".to_string();
        available.push(plugin);
    }

    available.sort_by(|a, b| a.name.cmp(&b.name));
    installed.sort_by(|a, b| a.name.cmp(&b.name));

    let enabled_count = installed.iter().filter(|item| item.enabled).count();
    let marketplace_ready = marketplaces.iter().any(|item| item.contains(OFFICIAL_MARKETPLACE));
    Ok(ClaudePluginSnapshot {
        claude_ready: true,
        marketplace_ready,
        claude_path: binary.display().to_string(),
        message: snapshot_message(marketplace_ready, installed.len(), enabled_count),
        marketplaces,
        installed,
        available,
    })
}

fn snapshot_message(marketplace_ready: bool, installed: usize, enabled: usize) -> String {
    if !marketplace_ready {
        "공식 마켓이 아직 없습니다. 공식 마켓 연결을 누르세요.".to_string()
    } else if installed == 0 {
        "공식 마켓 연결됨. 웹에서 이름을 찾아 설치하세요.".to_string()
    } else {
        format!("공식 마켓 연결됨 · 설치 {installed}개 · 사용 중 {enabled}개")
    }
}

fn offline_snapshot() -> ClaudePluginSnapshot {
    let home = claude_home();
    let marketplaces = home
        .as_deref()
        .map(registered_marketplaces)
        .unwrap_or_default();
    let marketplace_ready = marketplaces.iter().any(|item| item.contains(OFFICIAL_MARKETPLACE));
    let installed = local_plugins();
    ClaudePluginSnapshot {
        claude_ready: false,
        marketplace_ready,
        claude_path: String::new(),
        message: snapshot_message(marketplace_ready, installed.len(), 0),
        marketplaces,
        installed,
        available: recommended_plugins(),
    }
}

/// Plugin commands run the Claude CLI (and Git) for up to minutes, so they stay off the UI thread.
async fn off_ui_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("플러그인 작업 실행 실패: {error}"))?
}

#[tauri::command]
pub async fn get_claude_plugins(live: Option<bool>) -> Result<ClaudePluginSnapshot, String> {
    off_ui_thread(move || {
        if live.unwrap_or(false) {
            return snapshot_from_cli().or_else(|_| Ok(offline_snapshot()));
        }
        Ok(offline_snapshot())
    })
    .await
}

fn connect_marketplace(name: &str, repo: &str) -> Result<String, String> {
    let home = claude_home().ok_or_else(|| "사용자 폴더를 찾지 못했습니다.".to_string())?;
    let install_dir = register_known_marketplace(&home, name, repo)?;
    let _ = run_claude(
        &["plugin", "marketplace", "add", repo, "--scope", "user"],
        Duration::from_secs(90),
    );
    match clone_marketplace(&install_dir, repo) {
        Ok(()) => Ok(format!("{name} 마켓을 연결했습니다.")),
        Err(error) => Ok(format!(
            "{name} 마켓을 설정에 연결했습니다. 목록 받기는 다음에 다시 시도합니다. ({error})"
        )),
    }
}

#[tauri::command]
pub async fn add_claude_plugin_marketplace(source: String) -> Result<String, String> {
    off_ui_thread(move || add_marketplace(&source)).await
}

fn add_marketplace(source: &str) -> Result<String, String> {
    let source = sanitize_plugin_spec(source)?;
    let (name, repo) = if source == OFFICIAL_MARKETPLACE_SOURCE || source == OFFICIAL_MARKETPLACE {
        (OFFICIAL_MARKETPLACE.to_string(), OFFICIAL_MARKETPLACE_SOURCE.to_string())
    } else if source == COMMUNITY_MARKETPLACE_SOURCE || source == "claude-plugins-community" {
        ("claude-plugins-community".to_string(), COMMUNITY_MARKETPLACE_SOURCE.to_string())
    } else if source.contains('/') {
        custom_marketplace(&source)?
    } else {
        (OFFICIAL_MARKETPLACE.to_string(), OFFICIAL_MARKETPLACE_SOURCE.to_string())
    };
    let message = connect_marketplace(&name, &repo)?;
    if name == OFFICIAL_MARKETPLACE {
        let _ = connect_marketplace("claude-plugins-community", COMMUNITY_MARKETPLACE_SOURCE);
    }
    Ok(format!("{message} 이제 웹에서 본 이름을 적어 설치하면 됩니다."))
}

#[tauri::command]
pub async fn install_claude_plugin(spec: String) -> Result<String, String> {
    off_ui_thread(move || install_plugin(&spec)).await
}

fn install_plugin(spec: &str) -> Result<String, String> {
    let spec = qualify_plugin_spec(spec)?;
    run_claude(
        &["plugin", "install", &spec, "--scope", "user"],
        Duration::from_secs(120),
    )?;
    let _ = run_claude(
        &["plugin", "enable", &spec, "--scope", "user"],
        Duration::from_secs(20),
    );
    Ok(format!("{spec} 을(를) 설치했고 채팅 Claude에서 같이 씁니다."))
}

#[tauri::command]
pub fn set_claude_plugin_enabled(spec: String, enabled: bool) -> Result<String, String> {
    let spec = qualify_plugin_spec(&spec)?;
    let action = if enabled { "enable" } else { "disable" };
    run_claude(
        &["plugin", action, &spec, "--scope", "user"],
        Duration::from_secs(20),
    )?;
    Ok(if enabled {
        format!("{spec} 을(를) 켰습니다. 다음 채팅부터 같이 씁니다.")
    } else {
        format!("{spec} 을(를) 껐습니다.")
    })
}

#[tauri::command]
pub fn uninstall_claude_plugin(spec: String) -> Result<String, String> {
    let spec = qualify_plugin_spec(&spec)?;
    run_claude(
        &["plugin", "uninstall", &spec, "--scope", "user", "-y"],
        Duration::from_secs(40),
    )?;
    Ok(format!("{spec} 을(를) 삭제했습니다."))
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateReport {
    pub marketplaces_updated: bool,
    pub updated: Vec<String>,
    pub failed: Vec<(String, String)>,
}

/// Refreshes marketplace catalogs, then updates every installed plugin.
/// Individual failures keep the previously installed version.
pub fn update_all_plugins() -> Result<PluginUpdateReport, String> {
    claude_binary()?;
    let mut report = PluginUpdateReport {
        marketplaces_updated: run_claude(&["plugin", "marketplace", "update"], Duration::from_secs(180)).is_ok(),
        ..Default::default()
    };
    let listed = run_claude(&["plugin", "list", "--json"], Duration::from_secs(30)).unwrap_or_default();
    for plugin in parse_plugin_list_json(&listed).into_iter().filter(|plugin| plugin.installed || !plugin.id.is_empty()) {
        let Ok(spec) = sanitize_plugin_spec(&plugin.id) else { continue };
        match run_claude(&["plugin", "update", &spec], Duration::from_secs(180)) {
            Ok(_) => report.updated.push(spec),
            Err(error) => report.failed.push((spec, error)),
        }
    }
    Ok(report)
}

#[tauri::command]
pub async fn update_claude_plugins() -> Result<PluginUpdateReport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(desktop)]
        let _guard = crate::updates::try_begin_update()
            .ok_or("자동 업데이트가 진행 중입니다. 끝난 뒤 다시 눌러 주세요.")?;
        update_all_plugins()
    })
    .await
        .map_err(|error| format!("플러그인 업데이트 작업 실패: {error}"))?
}

pub fn plugin_catalog_url(kind: &str) -> &'static str {
    match kind.trim() {
        "repo" | "official-repo" => PLUGIN_OFFICIAL_REPO_URL,
        _ => PLUGIN_CATALOG_URL,
    }
}

#[tauri::command]
pub fn open_claude_plugin_catalog(app: AppHandle, kind: String) -> Result<String, String> {
    crate::window_stack::suppress_main_always_on_top(&app);
    let url = plugin_catalog_url(&kind);
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("플러그인 페이지를 열지 못했습니다: {error}"))?;
    Ok("웹에서 원하는 플러그인을 찾은 다음, 이름을 아래에 적어 설치하세요.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_marketplace_must_be_owner_and_repo() {
        let ok = |source: &str| custom_marketplace(source).ok();
        let pair = |name: &str, repo: &str| Some((name.to_string(), repo.to_string()));
        assert_eq!(ok("me/tools"), pair("tools", "me/tools"));
        assert_eq!(ok("me/tools/"), pair("tools", "me/tools"));
        assert_eq!(ok("github.com/me/tools.git"), pair("tools", "me/tools"));
        for bad in ["me/", "me/..", "me/.", "../x", "me/tools/extra", "/tools", "me//tools"] {
            assert_eq!(ok(bad), None, "{bad}");
        }
        assert!(!is_safe_marketplace_name(""));
        assert!(!is_safe_marketplace_name(".."));
    }

    #[test]
    fn rejects_unsafe_plugin_spec() {
        assert!(sanitize_plugin_spec("frontend-design").is_ok());
        assert!(sanitize_plugin_spec("code-review@claude-plugins-official").is_ok());
        assert!(sanitize_plugin_spec("bad;rm").is_err());
        assert!(sanitize_plugin_spec("").is_err());
    }

    #[test]
    fn qualifies_official_marketplace() {
        assert_eq!(
            qualify_plugin_spec("frontend-design").unwrap(),
            "frontend-design@claude-plugins-official"
        );
    }

    #[test]
    fn parses_json_installed_and_available() {
        let plugins = parse_plugin_list_json(
            r#"{
              "installed": [
                {"name":"frontend-design","marketplace":"claude-plugins-official","enabled":true,"version":"1.0.0"}
              ],
              "available": [
                {"name":"code-review","marketplace":"claude-plugins-official","description":"리뷰","installed":false}
              ]
            }"#,
        );
        assert_eq!(plugins.len(), 2);
        assert!(plugins.iter().any(|item| item.name == "frontend-design" && item.enabled));
        assert!(plugins.iter().any(|item| item.name == "code-review" && !item.installed));
    }

    #[test]
    fn parses_text_plugin_lines() {
        let plugins = parse_plugin_list_text(
            "Installed\nfrontend-design 1.0.0 (enabled) @claude-plugins-official\ncode-review (disabled) @claude-plugins-official\n",
        );
        assert!(plugins.iter().any(|item| item.name == "frontend-design" && item.enabled));
        assert!(plugins.iter().any(|item| item.name == "code-review" && !item.enabled));
    }

    #[test]
    fn catalog_url_is_official_directory() {
        assert_eq!(plugin_catalog_url("catalog"), "https://claude.com/plugins");
        assert_eq!(
            plugin_catalog_url("repo"),
            "https://github.com/anthropics/claude-plugins-official"
        );
    }

    #[test]
    fn registers_official_marketplace_without_cli() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join(".claude");
        let dir = register_known_marketplace(
            &home,
            "claude-plugins-official",
            "anthropics/claude-plugins-official",
        )
        .unwrap();
        assert!(dir.ends_with("claude-plugins-official"));
        let names = registered_marketplaces(&home);
        assert!(names.iter().any(|name| name == "claude-plugins-official"));
        let settings = std::fs::read_to_string(home.join("settings.json")).unwrap();
        assert!(settings.contains("extraKnownMarketplaces"));
        assert!(settings.contains("anthropics/claude-plugins-official"));
    }
}
