use crate::agent_core::{
    canonical_existing_dir, claude_plugin_dir_args, inspect_agent_runtime,
    managed_workspace_permission_args, merge_extra_args, merge_plugin_dir_args, request_cancel,
    resolve_agent_binary,
    run_request_streaming, sanitize_claude_extra_args, seed_claude_project_settings, AgentKind,
    AgentRequest, AgentStreamChunk,
};
use crate::settings::{load_settings, save_settings};
use crate::run_history::{self, AgentRunRecord, RunStatus};
use crate::provider_router::{self, AutomaticProviderStatus, FreeAutoReadiness};
use crate::environment_preflight::{
    git_status, is_codex_trust_error, is_conversation_workspace,
    launch_git_installer as launch_git_install_helper, prepare_workspace_git, CradleEnvironmentStatus,
};
use crate::workspace::{ensure_project_snapshot, sensitive_project_files, write_agent_context_file};
use crate::workspace_changes;
use crate::workspace_changes::{
    ApplyWorkspaceResult, CheckpointRecord, RestoreCheckpointResult, WorkspaceChange,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Emitter;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStreamPayload {
    task_id: String,
    stream: &'static str,
    text: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    default_agent: String,
    cradle_enabled: bool,
    auto_web_search: bool,
    gemini_api_enabled: bool,
    allow_paid_open_ai_api: bool,
    close_web_account_after_handoff: bool,
    close_web_account_when_cradle_done: bool,
    timeout_seconds: u64,
    warn_sensitive_files: bool,
    agent_extra_args: HashMap<String, Vec<String>>,
    agent_models: HashMap<String, String>,
    agent_model_presets: HashMap<String, Vec<String>>,
}

fn preferences_from_settings(settings: &crate::settings::AppSettings) -> AppPreferences {
    let agent_extra_args = [
        AgentKind::Claude,
        AgentKind::Codex,
        AgentKind::Cursor,
        AgentKind::Antigravity,
    ]
    .into_iter()
    .filter_map(|agent| {
        let args = settings.agent_extra_args(agent);
        (!args.is_empty()).then(|| (agent.as_str().to_string(), args.to_vec()))
    })
    .collect();

    let agent_models = [
        AgentKind::Claude,
        AgentKind::Codex,
        AgentKind::Cursor,
        AgentKind::Antigravity,
    ]
    .into_iter()
    .filter_map(|agent| {
        settings
            .agent_model(agent)
            .map(|model| (agent.as_str().to_string(), model.to_string()))
    })
    .collect();

    let agent_model_presets = [
        AgentKind::Claude,
        AgentKind::Codex,
        AgentKind::Cursor,
        AgentKind::Antigravity,
    ]
    .into_iter()
    .filter_map(|agent| {
        let presets = settings.agent_model_presets(agent);
        (!presets.is_empty()).then(|| (agent.as_str().to_string(), presets.to_vec()))
    })
    .collect();

    AppPreferences {
        default_agent: settings.default_agent.as_str().to_string(),
        cradle_enabled: settings.cradle_enabled,
        auto_web_search: settings.auto_web_search,
        gemini_api_enabled: settings.gemini_api_enabled,
        allow_paid_open_ai_api: settings.allow_paid_openai_api,
        close_web_account_after_handoff: settings.close_web_account_after_handoff,
        close_web_account_when_cradle_done: settings.close_web_account_when_cradle_done,
        timeout_seconds: settings.timeout_seconds,
        warn_sensitive_files: settings.warn_sensitive_files,
        agent_extra_args,
        agent_models,
        agent_model_presets,
    }
}

fn is_path_within(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn assert_agent_path_allowed(configured_project: &Path, candidate: &Path) -> Result<(), String> {
    let root = canonical_existing_dir(configured_project)?;
    let path = canonical_existing_dir(candidate)?;

    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            let lower = name.to_ascii_lowercase();
            lower == "keys.env"
                || lower == ".env"
                || lower.ends_with(".pem")
                || lower.ends_with(".key")
                || lower == "credentials.json"
        })
    {
        return Err(
            "keys.env / 민감 파일 경로는 Agent 작업 폴더로 사용할 수 없습니다.".to_string(),
        );
    }

    // 허용: 설정 프로젝트 루트, 또는 그 안의 .ai-character/conversations 워크스페이스
    if is_path_within(&root, &path) {
        return Ok(());
    }

    Err(format!(
        "프로젝트 폴더 밖 경로는 Agent에 허용되지 않습니다: {}",
        path.display()
    ))
}

fn resolve_working_dir(
    configured_project: PathBuf,
    explicit_working_dir: Option<String>,
    conversation_id: Option<&str>,
) -> Result<PathBuf, String> {
    let configured = canonical_existing_dir(&configured_project)?;
    let project = match explicit_working_dir {
        Some(path) if !path.trim().is_empty() => {
            let candidate = PathBuf::from(path.trim());
            assert_agent_path_allowed(&configured, &candidate)?;
            let canonical = canonical_existing_dir(&candidate)?;
            if let Some(conversation_id) = conversation_id.map(str::trim).filter(|value| !value.is_empty()) {
                let expected_parent = canonical_existing_dir(
                    &crate::workspace::ensure_conversation_workspace(&configured, conversation_id)?,
                )?
                .join("worktrees");
                if crate::coder_worktree::is_conversation_worktree(&canonical)
                    && canonical.parent() == Some(expected_parent.as_path())
                {
                    return Ok(canonical);
                }
            }
            // 명시 경로가 conversation snapshot이면 그대로 쓰고,
            // 그 외에는 설정 프로젝트만 신뢰한다.
            let canonical = canonical_existing_dir(&candidate)?;
            if is_conversation_workspace(&canonical) && is_path_within(&configured, &canonical) {
                canonical
            } else if is_path_within(&configured, &canonical) && canonical == configured {
                configured.clone()
            } else if is_path_within(&configured, &canonical) {
                // 하위 폴더 지정은 거절 — 프로젝트 루트 또는 managed workspace만
                return Err(
                    "Agent 작업 경로는 설정한 프로젝트 루트(또는 대화 워크스페이스)만 허용됩니다."
                        .to_string(),
                );
            } else {
                configured.clone()
            }
        }
        _ => configured.clone(),
    };

    assert_agent_path_allowed(&configured, &project)?;

    if let Some(conversation_id) = conversation_id.filter(|value| !value.trim().is_empty()) {
        ensure_project_snapshot(&configured, conversation_id)
    } else {
        Ok(project)
    }
}

fn configured_project_dir() -> Result<PathBuf, String> {
    load_settings()?
        .project_dir
        .ok_or_else(|| {
            "프로젝트 폴더가 지정되지 않았습니다. 먼저 프로젝트 폴더를 선택해주세요."
                .to_string()
        })
}

/// Each conversation may work in its own folder (like a Claude Code session); conversations
/// without one use the default folder from settings.
const CONVERSATION_DIR_PREFIX: &str = "conversation_dir.";
const RECENT_DIRS_KEY: &str = "recent_project_dirs";
const RECENT_DIRS_MAX: usize = 8;

fn conversation_dir_key(conversation_id: &str) -> Option<String> {
    let id = conversation_id.trim();
    crate::workspace::validate_conversation_id(id).ok()?;
    Some(format!("{CONVERSATION_DIR_PREFIX}{id}"))
}

pub fn project_dir_for(settings: &crate::settings::AppSettings, conversation_id: Option<&str>) -> Option<PathBuf> {
    conversation_id
        .and_then(conversation_dir_key)
        .and_then(|key| settings.extra(&key).map(PathBuf::from))
        .or_else(|| settings.project_dir.clone())
}

pub fn configured_project_dir_for(conversation_id: Option<&str>) -> Result<PathBuf, String> {
    project_dir_for(&load_settings()?, conversation_id).ok_or_else(|| {
        "작업 폴더가 지정되지 않았습니다. 먼저 작업 폴더를 선택해주세요.".to_string()
    })
}

fn remember_recent_dir(settings: &mut crate::settings::AppSettings, dir: &Path) {
    let dir = dir.to_string_lossy().into_owned();
    let mut recent: Vec<String> = settings
        .extra(RECENT_DIRS_KEY)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty() && *line != dir)
        .map(str::to_string)
        .collect();
    recent.insert(0, dir);
    recent.truncate(RECENT_DIRS_MAX);
    settings.set_extra(RECENT_DIRS_KEY, Some(recent.join("\n")));
}

/// Checks a folder can be used as a work folder and prepares its `.ai-character` space.
fn prepare_project_dir(path: &str) -> Result<PathBuf, String> {
    let canonical = crate::path_guard::without_verbatim_drive_prefix(canonical_existing_dir(PathBuf::from(path.trim()).as_path())?);
    crate::path_guard::assert_project_dir_allowed(&canonical)?;
    let app_dir = canonical.join(".ai-character");
    std::fs::create_dir_all(&app_dir).map_err(|error| {
        format!(
            "이 폴더에 AI-Character 작업 공간을 만들 수 없습니다: {} ({error})",
            app_dir.display()
        )
    })?;
    let probe = app_dir.join(".write-ok");
    std::fs::write(&probe, b"ok").map_err(|error| {
        format!(
            "이 폴더에 쓸 권한이 없습니다. 다른 폴더를 선택해주세요: {} ({error})",
            canonical.display()
        )
    })?;
    let _ = std::fs::remove_file(&probe);
    Ok(canonical)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDir {
    /// The folder this conversation works in (its own, or the default one).
    pub path: Option<String>,
    /// True when the conversation picked its own folder instead of the default.
    pub custom: bool,
    pub default_path: Option<String>,
    pub recent: Vec<String>,
}

fn conversation_dir_status(settings: &crate::settings::AppSettings, conversation_id: Option<&str>) -> ConversationDir {
    let own = conversation_id
        .and_then(conversation_dir_key)
        .and_then(|key| settings.extra(&key).map(str::to_string));
    let default_path = settings.project_dir.as_ref().map(|dir| dir.to_string_lossy().into_owned());
    ConversationDir {
        custom: own.is_some(),
        path: own.or_else(|| default_path.clone()),
        default_path,
        recent: settings
            .extra(RECENT_DIRS_KEY)
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_string)
            .collect(),
    }
}

#[tauri::command]
pub fn get_conversation_dir(conversation_id: Option<String>) -> Result<ConversationDir, String> {
    Ok(conversation_dir_status(&load_settings()?, conversation_id.as_deref()))
}

/// `path: None` makes the conversation follow the default folder again.
#[tauri::command]
pub fn set_conversation_dir(conversation_id: String, path: Option<String>) -> Result<ConversationDir, String> {
    let key = conversation_dir_key(&conversation_id).ok_or("대화 ID가 올바르지 않습니다.")?;
    let chosen = match path.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(path) => Some(prepare_project_dir(path)?),
        None => None,
    };
    let mut settings = load_settings()?;
    match &chosen {
        Some(dir) => {
            settings.set_extra(&key, Some(dir.to_string_lossy().into_owned()));
            remember_recent_dir(&mut settings, dir);
            if settings.project_dir.is_none() {
                settings.project_dir = Some(dir.clone());
            }
        }
        None => settings.set_extra(&key, None),
    }
    save_settings(&settings)?;
    Ok(conversation_dir_status(&settings, Some(&conversation_id)))
}

#[tauri::command]
pub fn get_project_dir() -> Result<Option<String>, String> {
    Ok(load_settings()?
        .project_dir
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn set_project_dir(path: String) -> Result<String, String> {
    let canonical = prepare_project_dir(&path)?;
    let mut settings = load_settings()?;
    settings.project_dir = Some(canonical.clone());
    remember_recent_dir(&mut settings, &canonical);
    save_settings(&settings)?;
    if let Err(error) = crate::local_env::ensure_keys_env_file() {
        eprintln!("키 파일 준비 경고: {error}");
    }
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn set_agent_path(agent: String, path: String) -> Result<String, String> {
    let agent = AgentKind::parse(&agent)?;
    let path = crate::path_guard::assert_agent_binary_path(
        agent.binary_names(),
        PathBuf::from(path.trim()).as_path(),
    )?;
    let mut settings = load_settings()?;
    settings.set_agent_path(agent, path.clone());
    save_settings(&settings)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn detect_agent(agent: String) -> Result<String, String> {
    let agent = AgentKind::parse(&agent)?;
    let settings = load_settings()?;
    let saved = settings.agent_path(agent).map(PathBuf::as_path);
    let path = resolve_agent_binary(agent, saved)?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimePaths {
    pub cli: Option<String>,
    pub app: Option<String>,
}

#[tauri::command]
pub fn detect_agent_runtime(agent: String) -> Result<AgentRuntimePaths, String> {
    let agent = AgentKind::parse(&agent)?;
    let settings = load_settings()?;
    let saved = settings.agent_path(agent).map(PathBuf::as_path);
    let runtime = inspect_agent_runtime(agent, saved);
    Ok(AgentRuntimePaths {
        cli: runtime.cli.map(|path| path.to_string_lossy().into_owned()),
        app: runtime.app.map(|path| path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub fn get_app_preferences() -> Result<AppPreferences, String> {
    let settings = load_settings()?;
    Ok(preferences_from_settings(&settings))
}

fn validate_agent_extra_args(
    values: HashMap<String, Vec<String>>,
) -> Result<HashMap<AgentKind, Vec<String>>, String> {
    let mut validated = HashMap::new();
    for (name, args) in values {
        let agent = AgentKind::parse(&name)?;
        if args.len() > 32 {
            return Err(format!(
                "{} 추가 인자는 최대 32개까지 지정할 수 있습니다.",
                agent.display_name()
            ));
        }
        let mut clean = Vec::with_capacity(args.len());
        for arg in args {
            let arg = arg.trim().to_string();
            if arg.is_empty() {
                continue;
            }
            if arg.len() > 512 || arg.chars().any(|ch| matches!(ch, '\n' | '\r' | '\0')) {
                return Err(format!(
                    "{} 추가 인자 값이 너무 길거나 허용되지 않는 문자를 포함합니다.",
                    agent.display_name()
                ));
            }
            clean.push(arg);
        }
        if !clean.is_empty() {
            validated.insert(agent, clean);
        }
    }
    Ok(validated)
}

fn validate_model_value(agent: AgentKind, value: String) -> Result<Option<String>, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 128 || value.chars().any(|ch| matches!(ch, '\n' | '\r' | '\0')) {
        return Err(format!(
            "{} 모델 이름은 128자 이하여야 하고 줄바꿈/NUL 문자를 포함할 수 없습니다.",
            agent.display_name()
        ));
    }
    Ok(Some(value))
}

fn validate_agent_models(
    values: HashMap<String, String>,
) -> Result<HashMap<AgentKind, String>, String> {
    let mut validated = HashMap::new();
    for (name, model) in values {
        let agent = AgentKind::parse(&name)?;
        if let Some(model) = validate_model_value(agent, model)? {
            validated.insert(agent, model);
        }
    }
    Ok(validated)
}

fn validate_agent_model_presets(
    values: HashMap<String, Vec<String>>,
) -> Result<HashMap<AgentKind, Vec<String>>, String> {
    let mut validated = HashMap::new();
    for (name, presets) in values {
        let agent = AgentKind::parse(&name)?;
        if presets.len() > 16 {
            return Err(format!(
                "{} 모델 프리셋은 최대 16개까지 저장할 수 있습니다.",
                agent.display_name()
            ));
        }
        let mut clean = Vec::new();
        for value in presets {
            if let Some(model) = validate_model_value(agent, value)? {
                if !clean.contains(&model) {
                    clean.push(model);
                }
            }
        }
        if !clean.is_empty() {
            validated.insert(agent, clean);
        }
    }
    Ok(validated)
}

#[tauri::command]
pub fn set_app_preferences(
    default_agent: String,
    cradle_enabled: bool,
    auto_web_search: bool,
    gemini_api_enabled: bool,
    allow_paid_open_ai_api: bool,
    close_web_account_after_handoff: bool,
    close_web_account_when_cradle_done: bool,
    timeout_seconds: u64,
    warn_sensitive_files: bool,
    agent_extra_args: HashMap<String, Vec<String>>,
    agent_models: HashMap<String, String>,
    agent_model_presets: HashMap<String, Vec<String>>,
) -> Result<AppPreferences, String> {
    if !(10..=3600).contains(&timeout_seconds) {
        return Err("Timeout은 10초에서 3600초 사이여야 합니다.".to_string());
    }
    let mut settings = load_settings()?;
    settings.default_agent = AgentKind::parse(&default_agent)?;
    settings.cradle_enabled = cradle_enabled;
    settings.auto_web_search = auto_web_search;
    settings.gemini_api_enabled = gemini_api_enabled;
    settings.allow_paid_openai_api = allow_paid_open_ai_api;
    settings.close_web_account_after_handoff = close_web_account_after_handoff;
    settings.close_web_account_when_cradle_done = close_web_account_when_cradle_done;
    settings.timeout_seconds = timeout_seconds;
    settings.warn_sensitive_files = warn_sensitive_files;
    settings.agent_extra_args = validate_agent_extra_args(agent_extra_args)?;
    settings.agent_models = validate_agent_models(agent_models)?;
    settings.agent_model_presets = validate_agent_model_presets(agent_model_presets)?;
    save_settings(&settings)?;
    Ok(preferences_from_settings(&settings))
}


/// Partial update used by the web setup page; omitted fields keep their saved value.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BasicPreferencesPatch {
    pub default_agent: Option<String>,
    pub cradle_enabled: Option<bool>,
    pub auto_web_search: Option<bool>,
    pub gemini_api_enabled: Option<bool>,
    pub allow_paid_open_ai_api: Option<bool>,
    pub close_web_account_after_handoff: Option<bool>,
    pub close_web_account_when_cradle_done: Option<bool>,
    pub timeout_seconds: Option<u64>,
    pub warn_sensitive_files: Option<bool>,
}

pub(crate) fn apply_basic_preferences(patch: BasicPreferencesPatch) -> Result<AppPreferences, String> {
    let mut settings = load_settings()?;
    if let Some(agent) = patch.default_agent.as_deref() {
        settings.default_agent = AgentKind::parse(agent)?;
    }
    if let Some(seconds) = patch.timeout_seconds {
        if !(10..=3600).contains(&seconds) {
            return Err("Timeout은 10초에서 3600초 사이여야 합니다.".to_string());
        }
        settings.timeout_seconds = seconds;
    }
    for (target, value) in [
        (&mut settings.cradle_enabled, patch.cradle_enabled),
        (&mut settings.auto_web_search, patch.auto_web_search),
        (&mut settings.gemini_api_enabled, patch.gemini_api_enabled),
        (&mut settings.allow_paid_openai_api, patch.allow_paid_open_ai_api),
        (&mut settings.close_web_account_after_handoff, patch.close_web_account_after_handoff),
        (&mut settings.close_web_account_when_cradle_done, patch.close_web_account_when_cradle_done),
        (&mut settings.warn_sensitive_files, patch.warn_sensitive_files),
    ] {
        if let Some(value) = value {
            *target = value;
        }
    }
    save_settings(&settings)?;
    Ok(preferences_from_settings(&settings))
}

#[tauri::command]
pub fn get_cradle_environment_status(
    conversation_id: Option<String>,
) -> Result<CradleEnvironmentStatus, String> {
    let settings = load_settings()?;
    let workspace = match (
        settings.project_dir.as_deref(),
        conversation_id.as_deref().map(str::trim).filter(|value| !value.is_empty()),
    ) {
        (Some(project), Some(conversation_id)) => {
            let candidate = project
                .join(".ai-character")
                .join("conversations")
                .join(conversation_id)
                .join("project");
            candidate.is_dir().then_some(candidate)
        }
        _ => None,
    };
    Ok(git_status(workspace.as_deref()))
}

#[tauri::command]
pub fn prepare_cradle_environment(
    conversation_id: Option<String>,
) -> Result<CradleEnvironmentStatus, String> {
    let settings = load_settings()?;
    let workspace = match (
        settings.project_dir.as_deref(),
        conversation_id.as_deref().map(str::trim).filter(|value| !value.is_empty()),
    ) {
        (Some(project), Some(conversation_id)) => {
            let workspace = ensure_project_snapshot(project, conversation_id)?;
            prepare_workspace_git(&workspace)?;
            Some(workspace)
        }
        _ => None,
    };
    Ok(git_status(workspace.as_deref()))
}

#[tauri::command]
pub fn launch_git_installer(app: tauri::AppHandle) -> Result<(), String> {
    crate::window_stack::suppress_main_always_on_top(&app);
    launch_git_install_helper()
}

#[tauri::command]
pub fn get_automatic_provider_status() -> Result<Vec<AutomaticProviderStatus>, String> {
    let settings = load_settings()?;
    Ok(provider_router::provider_statuses(&settings))
}

#[tauri::command]
pub fn get_free_auto_readiness() -> Result<FreeAutoReadiness, String> {
    let settings = load_settings()?;
    let claude_cli_ready = resolve_agent_binary(
        AgentKind::Claude,
        settings.agent_path(AgentKind::Claude).map(PathBuf::as_path),
    )
    .is_ok();
    Ok(provider_router::free_auto_readiness(&settings, claude_cli_ready))
}

#[tauri::command]
pub fn ensure_keys_env_file() -> Result<String, String> {
    crate::local_env::ensure_keys_env_file().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_keys_env_file(app: tauri::AppHandle) -> Result<String, String> {
    crate::window_stack::suppress_main_always_on_top(&app);
    crate::local_env::open_keys_env_file()
}

#[tauri::command]
pub async fn run_automatic_provider(
    app: tauri::AppHandle,
    provider: String,
    prompt: String,
    session_id: Option<String>,
    task_id: Option<String>,
    role: Option<String>,
    cache_fingerprint: Option<String>,
    stream_id: Option<String>,
) -> Result<String, String> {
    let settings = load_settings()?;
    let stream = stream_id.filter(|id| !id.trim().is_empty()).map(|id| {
        let sink: provider_router::StreamSink = std::sync::Arc::new(move |event| {
            let (reset, text) = match event {
                provider_router::StreamEvent::Reset => (true, ""),
                provider_router::StreamEvent::Delta(text) => (false, text),
            };
            let _ = app.emit(
                "provider-stream",
                serde_json::json!({ "streamId": id, "reset": reset, "text": text }),
            );
        });
        sink
    });
    let context = provider_router::CallContext {
        session_id,
        task_id,
        role,
        cache_fingerprint,
        stream,
    };
    provider_router::run_provider_with_context(&provider, &prompt, &settings, &context).await
}

#[tauri::command]
pub fn open_web_agent(
    app: tauri::AppHandle,
    target: String,
) -> Result<crate::web_accounts::WebAccountSlot, String> {
    crate::web_accounts::open_preferred_for_target(&app, &target)
}

#[tauri::command]
pub fn list_web_accounts(
    app: tauri::AppHandle,
) -> Result<Vec<crate::web_accounts::WebAccountSlot>, String> {
    crate::web_accounts::list_accounts(&app)
}

#[tauri::command]
pub fn update_web_accounts(
    app: tauri::AppHandle,
    accounts: Vec<crate::web_accounts::WebAccountSlot>,
) -> Result<Vec<crate::web_accounts::WebAccountSlot>, String> {
    crate::web_accounts::update_accounts(&app, accounts)
}

#[tauri::command]
pub fn open_web_account(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<crate::web_accounts::WebAccountSlot, String> {
    crate::web_accounts::open_account(&app, &account_id)
}

#[tauri::command]
pub fn open_all_web_accounts(
    app: tauri::AppHandle,
) -> Result<Vec<crate::web_accounts::WebAccountSlot>, String> {
    crate::web_accounts::open_all_enabled(&app)
}

#[tauri::command]
pub fn open_alternate_web_agent(
    app: tauri::AppHandle,
    target: String,
    exclude_account_id: String,
) -> Result<crate::web_accounts::WebAccountSlot, String> {
    crate::web_accounts::open_alternate_for_target(&app, &target, &exclude_account_id)
}

#[tauri::command]
pub fn close_web_account(app: tauri::AppHandle, account_id: String) -> Result<(), String> {
    crate::web_accounts::close_account(&app, &account_id)
}

#[tauri::command]
pub fn close_web_accounts(app: tauri::AppHandle, account_ids: Vec<String>) -> Result<(), String> {
    crate::web_accounts::close_accounts(&app, &account_ids)
}

#[tauri::command]
pub fn get_sensitive_files() -> Result<Vec<String>, String> {
    let project_dir = configured_project_dir()?;
    sensitive_project_files(&project_dir, 20)
}

fn run_agent_blocking<F>(
    agent: AgentKind,
    prompt: String,
    explicit_working_dir: Option<String>,
    conversation_id: Option<String>,
    task_id: Option<String>,
    timeout_seconds: Option<u64>,
    sensitive_acknowledged: Option<bool>,
    mut on_chunk: F,
) -> Result<String, String>
where
    F: FnMut(AgentStreamChunk),
{
    let settings = load_settings()?;
    let model = settings.agent_model(agent).map(str::to_string).or_else(|| {
        (agent == AgentKind::Codex)
            .then(crate::codex_model::replacement_for_retired_model)
            .flatten()
    });
    let history_task_id = task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(run_history::make_history_task_id);

    if let Err(error) = run_history::record_run_start(
        &history_task_id,
        conversation_id.as_deref(),
        agent.as_str(),
        model.as_deref(),
    ) {
        eprintln!("Agent 실행 시작 기록 실패: {error}");
    }

    let started = std::time::Instant::now();
    let result = (|| {
        let configured_project = project_dir_for(&settings, conversation_id.as_deref()).ok_or_else(|| {
            "작업 폴더가 지정되지 않았습니다. 먼저 작업 폴더를 선택해주세요.".to_string()
        })?;
        let configured_project = canonical_existing_dir(&configured_project)?;

        // 임의 경로 / keys.env 요청 거절 (설정 프로젝트 밖 금지)
        if let Some(path) = explicit_working_dir.as_deref() {
            if !path.trim().is_empty() {
                assert_agent_path_allowed(&configured_project, PathBuf::from(path.trim()).as_path())?;
            }
        }

        if settings.warn_sensitive_files
            && conversation_id.is_none()
            && sensitive_acknowledged != Some(true)
        {
            let sensitive = sensitive_project_files(&configured_project, 20)?;
            if !sensitive.is_empty() {
                let preview = sensitive.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
                return Err(format!(
                    "민감 파일 경고: 프로젝트에 민감 파일 후보가 있습니다: {preview}. 확인 후 다시 실행해주세요."
                ));
            }
        }

        let working_dir = resolve_working_dir(
            configured_project.clone(),
            explicit_working_dir,
            conversation_id.as_deref(),
        )?;
        let saved_binary = settings.agent_path(agent).map(PathBuf::as_path);
        let binary_path = resolve_agent_binary(agent, saved_binary)?;
        let timeout = Duration::from_secs(
            timeout_seconds
                .unwrap_or(settings.timeout_seconds)
                .clamp(10, 3600),
        );

        let coder_worktree = crate::coder_worktree::is_conversation_worktree(&working_dir);
        let managed_workspace = is_conversation_workspace(&working_dir) || coder_worktree;
        if managed_workspace {
            if let Err(error) = write_agent_context_file(
                &working_dir,
                &crate::local_env::configured_account_summary(),
            ) {
                eprintln!("Agent workspace context 기록 경고: {error}");
            }
            if !coder_worktree {
                if let Err(error) = prepare_workspace_git(&working_dir) {
                    if agent == AgentKind::Codex {
                        return Err(error);
                    }
                    eprintln!("CRADLE workspace Git 준비 경고: {error}");
                }
            }
        }

        let mut extra_args = settings.agent_extra_args(agent).to_vec();
        if agent == AgentKind::Claude {
            extra_args = sanitize_claude_extra_args(&extra_args);
            if managed_workspace {
                seed_claude_project_settings(&configured_project, &working_dir);
            }
            extra_args = merge_plugin_dir_args(
                &extra_args,
                &claude_plugin_dir_args(&configured_project, &working_dir),
            );
            if managed_workspace {
                match crate::claude_integration::prepare_claude_workspace(&working_dir) {
                    Ok(integration_args) => {
                        let has_format = extra_args.iter().any(|arg| arg == "--output-format");
                        let mut iter = integration_args.into_iter();
                        while let Some(arg) = iter.next() {
                            let value = iter.next().unwrap_or_default();
                            if arg == "--output-format" && has_format {
                                continue;
                            }
                            extra_args.push(arg);
                            extra_args.push(value);
                        }
                    }
                    Err(error) => eprintln!("Claude 통합 준비 경고: {error}"),
                }
            }
        }
        let claude_json_mode = agent == AgentKind::Claude
            && extra_args.windows(2).any(|pair| pair[0] == "--output-format" && pair[1] == "json");
        if managed_workspace {
            extra_args = merge_extra_args(
                &extra_args,
                &managed_workspace_permission_args(agent),
            );
        }

        let mut request = AgentRequest {
            agent,
            prompt,
            working_dir,
            binary_path,
            extra_args,
            model: model.clone(),
            task_id: Some(history_task_id.clone()),
            timeout,
        };

        let first_result = run_request_streaming(&request, |chunk: AgentStreamChunk| {
            if !(claude_json_mode && chunk.kind == crate::agent_core::AgentStreamKind::Stdout) {
                on_chunk(chunk);
            }
        });
        if claude_json_mode {
            let raw = first_result?;
            let Some(parsed) = crate::claude_integration::parse_claude_json(&raw) else {
                on_chunk(AgentStreamChunk { kind: crate::agent_core::AgentStreamKind::Stdout, text: raw.clone() });
                return Ok(raw);
            };
            crate::claude_integration::record_claude_usage(&parsed, conversation_id.as_deref(), Some(&history_task_id));
            if parsed.is_error {
                return Err(format!("Claude 오류: {}", parsed.text));
            }
            on_chunk(AgentStreamChunk { kind: crate::agent_core::AgentStreamKind::Stdout, text: parsed.text.clone() });
            return Ok(parsed.text);
        }
        if agent == AgentKind::Codex
            && managed_workspace
            && first_result
                .as_ref()
                .err()
                .is_some_and(|error| is_codex_trust_error(error))
        {
            // This is an isolated AI-Character conversation workspace. If
            // Codex still rejects it after git init, retry once with the
            // documented repository check bypass. Never use this for the
            // original project or arbitrary directories.
            let retry_flag = "--skip-git-repo-check".to_string();
            if !request.extra_args.contains(&retry_flag) {
                request.extra_args.insert(0, retry_flag);
            }
            return run_request_streaming(&request, &mut on_chunk);
        }
        first_result
    })();

    let duration_ms = started.elapsed().as_millis();
    let (status, error_detail) = match &result {
        Ok(_) => (RunStatus::Completed, None),
        Err(error) if error.contains("취소") || error.to_lowercase().contains("cancel") => {
            (RunStatus::Cancelled, Some(error.as_str()))
        }
        Err(error) => (RunStatus::Failed, Some(error.as_str())),
    };
    if let Err(error) = run_history::record_run_finish(
        &history_task_id,
        status,
        duration_ms,
        error_detail,
    ) {
        eprintln!("Agent 실행 완료 기록 실패: {error}");
    }

    result
}

#[tauri::command]
pub async fn run_agent(
    app: tauri::AppHandle,
    agent: String,
    prompt: String,
    working_dir: Option<String>,
    conversation_id: Option<String>,
    task_id: Option<String>,
    timeout_seconds: Option<u64>,
    sensitive_acknowledged: Option<bool>,
) -> Result<String, String> {
    let agent = AgentKind::parse(&agent)?;
    let event_task_id = task_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        run_agent_blocking(
            agent,
            prompt,
            working_dir,
            conversation_id,
            task_id,
            timeout_seconds,
            sensitive_acknowledged,
            move |chunk| {
                let Some(task_id) = event_task_id.as_ref() else {
                    return;
                };

                let payload = AgentStreamPayload {
                    task_id: task_id.clone(),
                    stream: chunk.kind.as_str(),
                    text: chunk.text,
                };
                let _ = app.emit("agent-stream", payload);
            },
        )
    })
    .await
    .map_err(|error| format!("Agent 작업 실행 오류: {error}"))?
}

#[tauri::command]
pub fn list_agent_runs(limit: Option<u32>) -> Result<Vec<AgentRunRecord>, String> {
    run_history::list_agent_runs(limit)
}

#[tauri::command]
pub fn cancel_agent(task_id: String) -> Result<(), String> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err("취소할 task ID가 비어 있습니다.".to_string());
    }
    request_cancel(task_id);
    Ok(())
}

#[tauri::command]
pub fn get_workspace_changes(conversation_id: String) -> Result<Vec<WorkspaceChange>, String> {
    let project_dir = configured_project_dir_for(Some(&conversation_id))?;
    workspace_changes::list_workspace_changes(&project_dir, conversation_id.trim())
}

#[tauri::command]
pub fn get_workspace_diff(conversation_id: String, path: String) -> Result<String, String> {
    let project_dir = configured_project_dir_for(Some(&conversation_id))?;
    workspace_changes::workspace_file_diff(&project_dir, conversation_id.trim(), path.trim())
}

const BULK_DELETE_THRESHOLD: usize = 5;

#[tauri::command]
pub async fn apply_workspace_changes(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<ApplyWorkspaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project_dir = configured_project_dir_for(Some(&conversation_id))?;
        let conversation_id = conversation_id.trim();
        let deleted_paths = |project_dir: &std::path::Path| -> Result<Vec<String>, String> {
            Ok(workspace_changes::list_workspace_changes(project_dir, conversation_id)?
                .into_iter()
                .filter(|change| change.kind == workspace_changes::WorkspaceChangeKind::Deleted)
                .map(|change| change.path)
                .collect())
        };
        let deleted = deleted_paths(&project_dir)?;
        if deleted.len() >= BULK_DELETE_THRESHOLD {
            let preview = deleted.iter().take(8).cloned().collect::<Vec<_>>().join("\n");
            let detail = format!(
                "원본 프로젝트에서 파일 {}개를 삭제합니다.\n{preview}{}",
                deleted.len(),
                if deleted.len() > 8 { "\n…" } else { "" }
            );
            if !crate::policy_engine::ask_risky_approval_blocking(&app, "대량 삭제 적용", &detail) {
                return Err("대량 삭제가 포함된 변경 적용을 취소했습니다.".to_string());
            }
            if deleted_paths(&project_dir)? != deleted {
                return Err("승인하는 동안 삭제 목록이 바뀌어 적용을 멈췄습니다. 변경 검토 후 다시 적용하세요.".to_string());
            }
        }
        workspace_changes::apply_workspace_changes(&project_dir, conversation_id)
    })
    .await
    .map_err(|error| format!("변경 적용 작업 실행 실패: {error}"))?
}

#[tauri::command]
pub fn discard_workspace_changes(conversation_id: String) -> Result<(), String> {
    let project_dir = configured_project_dir_for(Some(&conversation_id))?;
    workspace_changes::discard_workspace_changes(&project_dir, conversation_id.trim())
}

#[tauri::command]
pub fn list_checkpoints(limit: Option<u32>) -> Result<Vec<CheckpointRecord>, String> {
    let project_dir = configured_project_dir()?;
    workspace_changes::list_checkpoints(&project_dir, limit.unwrap_or(30))
}

#[tauri::command]
pub fn restore_checkpoint(checkpoint_id: String) -> Result<RestoreCheckpointResult, String> {
    let project_dir = configured_project_dir()?;
    workspace_changes::restore_checkpoint(&project_dir, checkpoint_id.trim())
}

#[tauri::command]
pub async fn ask_claude(
    app: tauri::AppHandle,
    prompt: String,
) -> Result<String, String> {
    let project_dir = configured_project_dir()?;
    let project_dir = project_dir.to_string_lossy().into_owned();
    run_agent(
        app,
        "claude".to_string(),
        prompt,
        Some(project_dir),
        None,
        None,
        None,
        None,
    )
    .await
}
