use crate::claude_plugins;
use crate::process_util::{find_tool, run_command, run_command_without_secrets};
use crate::provider_router;
use crate::settings::{load_settings, save_settings};
use crate::usage_ledger;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const UPDATE_NOTICE_EVENT: &str = "ai-character:update-notice";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(120);
const BUSY_RETRY_DELAY: Duration = Duration::from_secs(300);
const MODEL_REFRESH_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
/// A CRADLE session that never reported completion (e.g. the webview reloaded) stops blocking updates after this.
const CRADLE_STALE_MS: u64 = 3 * 60 * 60 * 1000;
const WINGET_NO_UPGRADE: i32 = 0x8A15002Bu32 as i32;
const RELEASE_ENDPOINT: &str =
    "https://github.com/wch0798/ai-character/releases/latest/download/latest.json";

static CRADLE_SESSIONS: AtomicUsize = AtomicUsize::new(0);
static CRADLE_TOUCHED_MS: AtomicU64 = AtomicU64::new(0);
static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);
static UPDATER_READY: AtomicBool = AtomicBool::new(false);
static PENDING_INSTALL: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>> = Mutex::new(None);
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
static CURRENT_STEP: Mutex<Option<String>> = Mutex::new(None);
static STEPS_DONE: AtomicUsize = AtomicUsize::new(0);
static RUN_STARTED_MS: AtomicU64 = AtomicU64::new(0);
static LAST_FINISHED_MS: AtomicU64 = AtomicU64::new(0);
static NEXT_CHECK_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRunStatus {
    pub running: bool,
    pub current: Option<String>,
    pub completed: usize,
    pub started_at: Option<u64>,
    pub cancel_requested: bool,
    pub last_finished_at: Option<u64>,
    pub next_check_at: Option<u64>,
    pub pending_restart: bool,
    pub cradle_active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub app: bool,
    pub clis: bool,
    pub plugins: bool,
    pub models: bool,
    pub interval_hours: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub category: String,
    pub target: String,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    /// updated | current | failed | rolled_back | skipped | pending_restart
    pub status: String,
    pub message: Option<String>,
}

impl UpdateOutcome {
    fn new(category: &str, target: &str, status: &str) -> Self {
        Self {
            category: category.to_string(),
            target: target.to_string(),
            from_version: None,
            to_version: None,
            status: status.to_string(),
            message: None,
        }
    }

    fn versions(mut self, from: Option<String>, to: Option<String>) -> Self {
        self.from_version = from;
        self.to_version = to;
        self
    }

    fn message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    fn is_noteworthy(&self) -> bool {
        matches!(
            self.status.as_str(),
            "updated" | "failed" | "rolled_back" | "pending_restart"
        )
    }
}

pub fn update_settings() -> UpdateSettings {
    let settings = load_settings().unwrap_or_default();
    UpdateSettings {
        app: settings.extra_bool("update.app", true),
        clis: settings.extra_bool("update.clis", true),
        plugins: settings.extra_bool("update.plugins", true),
        models: settings.extra_bool("update.models", true),
        interval_hours: settings.extra_u64("update.interval_hours", 6).clamp(1, 168),
    }
}

#[tauri::command]
pub fn get_update_settings() -> UpdateSettings {
    update_settings()
}

#[tauri::command]
pub fn set_update_settings(value: UpdateSettings) -> Result<UpdateSettings, String> {
    let mut settings = load_settings()?;
    for (key, enabled) in [
        ("update.app", value.app),
        ("update.clis", value.clis),
        ("update.plugins", value.plugins),
        ("update.models", value.models),
    ] {
        settings.set_extra(key, Some(enabled.to_string()));
    }
    settings.set_extra(
        "update.interval_hours",
        Some(value.interval_hours.clamp(1, 168).to_string()),
    );
    save_settings(&settings)?;
    Ok(update_settings())
}

pub fn cradle_active() -> bool {
    CRADLE_SESSIONS.load(Ordering::SeqCst) > 0
        && now_ms().saturating_sub(CRADLE_TOUCHED_MS.load(Ordering::SeqCst)) < CRADLE_STALE_MS
}

#[tauri::command]
pub fn set_cradle_activity(active: bool) {
    if active {
        if !cradle_active() {
            CRADLE_SESSIONS.store(0, Ordering::SeqCst);
        }
        CRADLE_SESSIONS.fetch_add(1, Ordering::SeqCst);
        CRADLE_TOUCHED_MS.store(now_ms(), Ordering::SeqCst);
    } else {
        let _ = CRADLE_SESSIONS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
            Some(count.saturating_sub(1))
        });
    }
}

pub fn mark_updater_ready() {
    UPDATER_READY.store(true, Ordering::SeqCst);
}

/// Holds the shared "update in progress" flag so manual plugin updates never race the scheduled cycle.
pub struct RunningGuard(());

impl Drop for RunningGuard {
    fn drop(&mut self) {
        set_current_step(None);
        CANCEL_REQUESTED.store(false, Ordering::SeqCst);
        LAST_FINISHED_MS.store(now_ms(), Ordering::SeqCst);
        UPDATE_RUNNING.store(false, Ordering::SeqCst);
    }
}

pub fn try_begin_update() -> Option<RunningGuard> {
    if UPDATE_RUNNING.swap(true, Ordering::SeqCst) {
        return None;
    }
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    STEPS_DONE.store(0, Ordering::SeqCst);
    RUN_STARTED_MS.store(now_ms(), Ordering::SeqCst);
    set_current_step(None);
    Some(RunningGuard(()))
}

fn deferred(category: &str, target: &str) -> UpdateOutcome {
    UpdateOutcome::new(category, target, "skipped").message("CRADLE 작업 중이라 다음 확인으로 미룹니다.")
}

fn cancelled(category: &str, target: &str) -> UpdateOutcome {
    UpdateOutcome::new(category, target, "skipped").message("사용자가 업데이트를 중지했습니다.")
}

/// Why the next step must not start, if anything: a stop request or a running CRADLE session.
fn held(category: &str, target: &str) -> Option<UpdateOutcome> {
    if CANCEL_REQUESTED.load(Ordering::SeqCst) {
        return Some(cancelled(category, target));
    }
    cradle_active().then(|| deferred(category, target))
}

/// Runs one update step unless held; a running step always finishes so nothing is left half-installed.
fn step(category: &str, target: &str, work: impl FnOnce() -> UpdateOutcome) -> UpdateOutcome {
    if let Some(outcome) = held(category, target) {
        return outcome;
    }
    set_current_step(Some(format!("{category}:{target}")));
    let outcome = work();
    STEPS_DONE.fetch_add(1, Ordering::SeqCst);
    outcome
}

fn set_current_step(value: Option<String>) {
    if let Ok(mut slot) = CURRENT_STEP.lock() {
        *slot = value;
    }
}

fn optional_ms(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

#[tauri::command]
pub fn get_update_status() -> UpdateRunStatus {
    let running = UPDATE_RUNNING.load(Ordering::SeqCst);
    UpdateRunStatus {
        running,
        current: if running { CURRENT_STEP.lock().ok().and_then(|slot| slot.clone()) } else { None },
        completed: if running { STEPS_DONE.load(Ordering::SeqCst) } else { 0 },
        started_at: if running { optional_ms(RUN_STARTED_MS.load(Ordering::SeqCst)) } else { None },
        cancel_requested: running && CANCEL_REQUESTED.load(Ordering::SeqCst),
        last_finished_at: optional_ms(LAST_FINISHED_MS.load(Ordering::SeqCst)),
        next_check_at: optional_ms(NEXT_CHECK_MS.load(Ordering::SeqCst)),
        pending_restart: has_pending_app_update(),
        cradle_active: cradle_active(),
    }
}

/// Stops the running cycle after the current step; returns false when nothing is running.
#[tauri::command]
pub fn cancel_updates() -> bool {
    if !UPDATE_RUNNING.load(Ordering::SeqCst) {
        return false;
    }
    CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    true
}

#[tauri::command]
pub fn has_pending_app_update() -> bool {
    PENDING_INSTALL.lock().map(|pending| pending.is_some()).unwrap_or(false)
}

/// Installs a downloaded app update (Windows exits into the installer) or simply restarts.
#[tauri::command]
pub fn restart_to_apply_update(app: AppHandle) -> Result<(), String> {
    let pending = PENDING_INSTALL.lock().ok().and_then(|mut slot| slot.take());
    if let Some((update, bytes)) = pending {
        update
            .install(&bytes)
            .map_err(|error| format!("업데이트 설치 실패: {error}"))?;
    }
    app.restart();
}

#[tauri::command]
pub async fn run_updates_now(
    app: AppHandle,
    categories: Option<Vec<String>>,
) -> Result<Vec<UpdateOutcome>, String> {
    if cradle_active() {
        return Err("CRADLE 작업이 진행 중이라 업데이트를 미룹니다.".to_string());
    }
    let selected = categories.unwrap_or_else(|| {
        ["app", "clis", "plugins", "models"]
            .iter()
            .map(|value| value.to_string())
            .collect()
    });
    tauri::async_runtime::spawn_blocking(move || run_cycle(&app, &selected, true))
        .await
        .map_err(|error| format!("업데이트 작업 실행 실패: {error}"))?
}

pub fn start(app: AppHandle) {
    NEXT_CHECK_MS.store(now_ms() + FIRST_CHECK_DELAY.as_millis() as u64, Ordering::SeqCst);
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK_DELAY);
        loop {
            if cradle_active() {
                NEXT_CHECK_MS.store(now_ms() + BUSY_RETRY_DELAY.as_millis() as u64, Ordering::SeqCst);
                thread::sleep(BUSY_RETRY_DELAY);
                continue;
            }
            let settings = update_settings();
            let mut selected = Vec::new();
            if settings.app {
                selected.push("app".to_string());
            }
            if settings.clis {
                selected.push("clis".to_string());
            }
            if settings.plugins {
                selected.push("plugins".to_string());
            }
            if settings.models {
                selected.push("models".to_string());
            }
            if !selected.is_empty() {
                let _ = run_cycle(&app, &selected, false);
            }
            let wait = Duration::from_secs(settings.interval_hours * 60 * 60);
            NEXT_CHECK_MS.store(now_ms() + wait.as_millis() as u64, Ordering::SeqCst);
            thread::sleep(wait);
        }
    });
}

fn run_cycle(app: &AppHandle, selected: &[String], manual: bool) -> Result<Vec<UpdateOutcome>, String> {
    let Some(_guard) = try_begin_update() else {
        return Err("이미 업데이트를 확인하는 중입니다.".to_string());
    };
    let wants = |name: &str| selected.iter().any(|value| value == name);
    let mut outcomes = Vec::new();

    if wants("clis") {
        outcomes.extend(update_clis(manual));
    }
    if wants("plugins") {
        if let Some(outcome) = held("plugin", "claude-plugins") {
            outcomes.push(outcome);
        } else {
            set_current_step(Some("plugin:claude-plugins".to_string()));
            outcomes.extend(update_plugins());
            STEPS_DONE.fetch_add(1, Ordering::SeqCst);
        }
    }
    if wants("models") {
        if let Some(outcome) = held("models", "models") {
            outcomes.push(outcome);
        } else {
            set_current_step(Some("models:models".to_string()));
            outcomes.extend(refresh_models(manual));
            STEPS_DONE.fetch_add(1, Ordering::SeqCst);
        }
    }
    if wants("app") {
        outcomes.push(step("app", "app", || update_app(app)));
    }

    record_outcomes(&outcomes);
    notify(app, &outcomes);
    Ok(outcomes)
}

fn record_outcomes(outcomes: &[UpdateOutcome]) {
    let Ok(connection) = usage_ledger::open_ledger() else {
        return;
    };
    for outcome in outcomes.iter().filter(|outcome| outcome.is_noteworthy()) {
        let _ = usage_ledger::insert_update(
            &connection,
            &outcome.category,
            &outcome.target,
            outcome.from_version.as_deref(),
            outcome.to_version.as_deref(),
            &outcome.status,
            outcome.message.as_deref(),
        );
    }
}

pub fn notice_lines(outcomes: &[UpdateOutcome]) -> Vec<String> {
    outcomes
        .iter()
        .filter(|outcome| outcome.is_noteworthy())
        .map(|outcome| {
            let versions = match (&outcome.from_version, &outcome.to_version) {
                (Some(from), Some(to)) if from != to => format!(" {from} → {to}"),
                (_, Some(to)) => format!(" {to}"),
                _ => String::new(),
            };
            let status = match outcome.status.as_str() {
                "updated" => "업데이트 완료",
                "pending_restart" => "설치됨, 재시작하면 적용",
                "rolled_back" => "실패하여 이전 버전 유지",
                _ => "실패",
            };
            match &outcome.message {
                Some(message) if outcome.status != "updated" => {
                    format!("{}{versions}: {status} ({})", outcome.target, first_line(message))
                }
                _ => format!("{}{versions}: {status}", outcome.target),
            }
        })
        .collect()
}

fn notify(app: &AppHandle, outcomes: &[UpdateOutcome]) {
    let lines = notice_lines(outcomes);
    if lines.is_empty() {
        return;
    }
    let _ = app.emit(
        UPDATE_NOTICE_EVENT,
        serde_json::json!({ "title": "자동 업데이트", "lines": lines }),
    );
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(format!("AI Character — 업데이트 {}건", lines.len())));
    }
    if outcomes.iter().any(|outcome| outcome.status == "pending_restart") {
        crate::alerts::notify("새 버전 준비됨", "앱을 재시작하면 새 버전이 적용됩니다.");
    } else if outcomes.iter().any(|outcome| matches!(outcome.status.as_str(), "failed" | "rolled_back")) {
        crate::alerts::notify("자동 업데이트 실패", &lines.join("\n"));
    }
}

fn first_line(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    line.chars().take(160).collect()
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn tool_version(binary: &Path) -> Option<String> {
    let output = run_command(binary, &args(&["--version"]), None, &[], Duration::from_secs(30));
    if !output.success {
        return None;
    }
    let line = first_line(&output.output);
    (!line.is_empty()).then_some(line)
}

const SELF_UPDATING_CLIS: &[(&str, &[&str])] = &[
    ("claude", &["update"]),
    ("cursor-agent", &["update"]),
    ("agy", &["update"]),
];

const NPM_CLIS: &[(&str, &str)] = &[("codex", "@openai/codex"), ("gemini", "@google/gemini-cli")];

fn update_clis(manual: bool) -> Vec<UpdateOutcome> {
    let mut outcomes = Vec::new();
    for (name, update_args) in SELF_UPDATING_CLIS {
        if let Some(binary) = find_tool(name) {
            outcomes.push(step("cli", name, || update_self_updating_cli(name, &binary, update_args)));
        }
    }
    for (name, package) in NPM_CLIS {
        if let Some(binary) = find_tool(name) {
            outcomes.push(step("cli", name, || update_npm_cli(name, &binary, package)));
        }
    }
    if cfg!(windows) {
        if let Some(winget) = find_tool("winget") {
            for (name, id, machine_scope) in WINGET_TOOLS {
                let Some(binary) = find_tool(name) else {
                    continue;
                };
                outcomes.push(if *machine_scope && !manual {
                    UpdateOutcome::new("cli", name, "skipped")
                        .message("관리자 권한 창이 뜰 수 있어 '지금 업데이트'에서만 확인합니다.")
                } else {
                    step("cli", name, || update_winget_tool(&winget, name, &binary, id))
                });
            }
        }
    }
    outcomes
}

/// (binary, winget id, installs machine-wide and may raise a UAC prompt)
const WINGET_TOOLS: &[(&str, &str, bool)] = &[("git", "Git.Git", true), ("gh", "GitHub.cli", false)];

fn update_winget_tool(winget: &Path, name: &str, binary: &Path, id: &str) -> UpdateOutcome {
    let before = tool_version(binary);
    let output = run_command(
        winget,
        &args(&[
            "upgrade", "--id", id, "--exact", "--silent",
            "--accept-source-agreements", "--accept-package-agreements",
        ]),
        None,
        &[],
        Duration::from_secs(900),
    );
    let after = tool_version(binary);
    let nothing_to_do = output.code == Some(WINGET_NO_UPGRADE);
    if !output.success && !nothing_to_do {
        return UpdateOutcome::new("cli", name, "failed")
            .versions(before, after)
            .message(crate::policy_engine::mask_secrets(&output.output));
    }
    let status = if before != after { "updated" } else { "current" };
    UpdateOutcome::new("cli", name, status).versions(before, after)
}

fn update_self_updating_cli(name: &str, binary: &Path, update_args: &[&str]) -> UpdateOutcome {
    let before = tool_version(binary);
    let output = run_command(binary, &args(update_args), None, &[], Duration::from_secs(900));
    let after = tool_version(binary);
    if !output.success {
        return UpdateOutcome::new("cli", name, "failed")
            .versions(before, after)
            .message(crate::policy_engine::mask_secrets(&output.output));
    }
    if after.is_none() {
        return UpdateOutcome::new("cli", name, "failed")
            .versions(before, None)
            .message("업데이트 후 실행 확인에 실패했습니다.");
    }
    let status = if before != after { "updated" } else { "current" };
    UpdateOutcome::new("cli", name, status).versions(before, after)
}

pub fn parse_npm_global_version(json: &str, package: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value
        .get("dependencies")?
        .get(package)?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

fn update_npm_cli(name: &str, binary: &Path, package: &str) -> UpdateOutcome {
    let Some(npm) = find_tool("npm") else {
        return UpdateOutcome::new("cli", name, "skipped").message("npm을 찾지 못했습니다.");
    };
    let listed = run_command(
        &npm,
        &args(&["ls", "-g", package, "--json", "--depth=0"]),
        None,
        &[],
        Duration::from_secs(60),
    );
    let Some(installed) = parse_npm_global_version(&listed.output, package) else {
        return UpdateOutcome::new("cli", name, "skipped")
            .message("npm 전역 설치본이 아니라 자동 업데이트를 건너뜁니다.");
    };
    let latest_output = run_command(
        &npm,
        &args(&["view", package, "version"]),
        None,
        &[],
        Duration::from_secs(60),
    );
    let latest = first_line(&latest_output.output);
    if !latest_output.success || latest.is_empty() {
        return UpdateOutcome::new("cli", name, "failed")
            .versions(Some(installed), None)
            .message("최신 버전 정보를 가져오지 못했습니다.");
    }
    if latest == installed {
        return UpdateOutcome::new("cli", name, "current").versions(Some(installed), Some(latest));
    }

    let install = run_command(
        &npm,
        &args(&["install", "-g", &format!("{package}@{latest}")]),
        None,
        &[],
        Duration::from_secs(900),
    );
    if install.success && tool_version(binary).is_some() {
        return UpdateOutcome::new("cli", name, "updated").versions(Some(installed), Some(latest));
    }

    let rollback = run_command(
        &npm,
        &args(&["install", "-g", &format!("{package}@{installed}")]),
        None,
        &[],
        Duration::from_secs(900),
    );
    let reason = crate::policy_engine::mask_secrets(&install.output);
    if rollback.success {
        UpdateOutcome::new("cli", name, "rolled_back")
            .versions(Some(installed), Some(latest))
            .message(reason)
    } else {
        UpdateOutcome::new("cli", name, "failed")
            .versions(Some(installed), Some(latest))
            .message(format!("업데이트와 되돌리기 모두 실패: {}", first_line(&reason)))
    }
}

fn update_plugins() -> Vec<UpdateOutcome> {
    if find_tool("claude").is_none() {
        return Vec::new();
    }
    match claude_plugins::update_all_plugins() {
        Ok(report) => {
            let mut outcomes: Vec<UpdateOutcome> = report
                .updated
                .iter()
                .map(|id| UpdateOutcome::new("plugin", id, "updated"))
                .collect();
            outcomes.extend(report.failed.iter().map(|(id, reason)| {
                UpdateOutcome::new("plugin", id, "failed").message(reason.clone())
            }));
            if outcomes.is_empty() {
                outcomes.push(UpdateOutcome::new("plugin", "claude-plugins", "current"));
            }
            outcomes
        }
        Err(error) => vec![UpdateOutcome::new("plugin", "claude-plugins", "failed").message(error)],
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn refresh_models(force: bool) -> Vec<UpdateOutcome> {
    let Ok(settings) = load_settings() else {
        return Vec::new();
    };
    let last = settings.extra_u64("update.models_last_ms", 0);
    if !force && now_ms().saturating_sub(last) < MODEL_REFRESH_INTERVAL_MS {
        return Vec::new();
    }
    let mut outcomes = Vec::new();
    for (target, result) in [
        (
            "openrouter-free-models",
            tauri::async_runtime::block_on(provider_router::refresh_openrouter_models(true)),
        ),
        (
            "gemini-models",
            tauri::async_runtime::block_on(provider_router::refresh_gemini_models()),
        ),
    ] {
        outcomes.push(match result {
            Ok(0) => UpdateOutcome::new("models", target, "skipped").message("API 키가 없거나 목록이 비어 있습니다."),
            Ok(count) => UpdateOutcome::new("models", target, "current")
                .message(format!("모델 {count}개 갱신")),
            Err(error) => UpdateOutcome::new("models", target, "failed").message(error),
        });
    }
    if let Ok(mut settings) = load_settings() {
        settings.set_extra("update.models_last_ms", Some(now_ms().to_string()));
        let _ = save_settings(&settings);
    }
    outcomes
}

fn update_app(app: &AppHandle) -> UpdateOutcome {
    if cradle_active() {
        return deferred("app", "app");
    }
    if let Some(repo) = source_repo_root() {
        return update_from_source(&repo);
    }
    update_installed_app(app)
}

fn source_repo_root() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?.to_path_buf();
    repo.join(".git").exists().then_some(repo)
}

fn git(repo: &Path, git_args: &[&str], timeout: Duration) -> Result<String, String> {
    let binary = crate::environment_preflight::git_binary().ok_or("git을 찾지 못했습니다.")?;
    let output = run_command(&binary, &args(git_args), Some(repo), &[], timeout);
    if output.success {
        Ok(output.output.trim().to_string())
    } else {
        Err(first_line(&output.output))
    }
}

/// Source-mode updates used to install and test each new upstream commit automatically. Off:
/// that runs unreviewed code (npm install scripts, tests). The path stays for an explicit opt-in.
const SOURCE_AUTO_VERIFY: bool = false;

fn update_from_source(repo: &Path) -> UpdateOutcome {
    let target = "app-source";
    let short = Duration::from_secs(60);
    let head = git(repo, &["rev-parse", "--short", "HEAD"], short).ok();
    let outcome = |status: &str| UpdateOutcome::new("app", target, status);

    match git(repo, &["status", "--porcelain", "--untracked-files=no"], short) {
        Ok(status) if !status.is_empty() => {
            return outcome("skipped").message("커밋되지 않은 변경이 있어 소스 업데이트를 건너뜁니다.")
        }
        Err(error) => return outcome("failed").message(error),
        _ => {}
    }
    if git(repo, &["rev-parse", "--abbrev-ref", "@{u}"], short).is_err() {
        return outcome("skipped").message("추적 중인 원격 브랜치가 없습니다.");
    }
    if let Err(error) = git(repo, &["fetch", "--quiet"], Duration::from_secs(180)) {
        return outcome("failed").message(format!("git fetch 실패: {error}"));
    }
    let behind = git(repo, &["rev-list", "--count", "HEAD..@{u}"], short)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    if behind == 0 {
        return outcome("current").versions(head.clone(), head);
    }
    let Ok(upstream) = git(repo, &["rev-parse", "@{u}"], short) else {
        return outcome("failed").message("원격 커밋을 확인하지 못했습니다.");
    };
    let upstream_short: String = upstream.chars().take(7).collect();
    if !SOURCE_AUTO_VERIFY {
        // Checking a new commit means running its npm install scripts and tests, i.e. code
        // nobody has reviewed yet, on this computer. Only say it is there.
        return outcome("skipped")
            .versions(head, Some(upstream_short))
            .message(format!(
                "원격 저장소에 새 커밋 {behind}개가 있습니다. 개발 모드에서는 검토하지 않은 코드를 자동으로 실행하지 않으니, 내용을 확인한 뒤 직접 git pull 하세요."
            ));
    }

    let worktree = std::env::temp_dir().join("ai-character-update-check");
    let _ = git(repo, &["worktree", "remove", "--force", &worktree.to_string_lossy()], short);
    let _ = std::fs::remove_dir_all(&worktree);
    if let Err(error) = git(
        repo,
        &["worktree", "add", "--detach", &worktree.to_string_lossy(), &upstream],
        Duration::from_secs(120),
    ) {
        return outcome("failed").message(format!("검증용 작업 트리 생성 실패: {error}"));
    }

    let verification = verify_source_tree(&worktree);
    let _ = git(repo, &["worktree", "remove", "--force", &worktree.to_string_lossy()], short);

    if let Err(error) = verification {
        return outcome("failed")
            .versions(head, Some(upstream_short))
            .message(format!("새 버전 테스트 실패로 현재 버전을 유지합니다: {error}"));
    }
    if let Some(outcome) = held("app", target) {
        return outcome.versions(head, Some(upstream_short));
    }
    match git(repo, &["merge", "--ff-only", &upstream], Duration::from_secs(120)) {
        Ok(_) => outcome("updated")
            .versions(head, Some(upstream_short))
            .message("개발 모드는 자동으로 다시 빌드됩니다."),
        Err(error) => outcome("failed")
            .versions(head, Some(upstream_short))
            .message(format!("fast-forward 병합 실패: {error}")),
    }
}

fn verify_source_tree(worktree: &Path) -> Result<(), String> {
    let npm = find_tool("npm").ok_or("npm을 찾지 못했습니다.")?;
    let cargo = find_tool("cargo").ok_or("cargo를 찾지 못했습니다.")?;
    let cargo_target = std::env::temp_dir().join("ai-character-update-target");
    let ci = ("CI", OsString::from("1"));
    let steps: Vec<(&Path, Vec<String>, Vec<(&str, OsString)>, u64)> = vec![
        (npm.as_path(), args(&["ci", "--no-audit", "--no-fund"]), vec![ci.clone()], 1200),
        (npm.as_path(), args(&["test"]), vec![ci.clone()], 900),
        (
            cargo.as_path(),
            args(&["test", "--manifest-path", "src-tauri/Cargo.toml"]),
            vec![ci, ("CARGO_TARGET_DIR", cargo_target.into_os_string())],
            3600,
        ),
    ];
    for (program, step_args, envs, timeout) in steps {
        let label = format!("{} {}", program.file_name().unwrap_or_default().to_string_lossy(), step_args.join(" "));
        let output = run_command_without_secrets(program, &step_args, Some(worktree), &envs, Duration::from_secs(timeout));
        if !output.success {
            let tail: String = output
                .output
                .lines()
                .rev()
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" / ");
            return Err(format!("{label}: {tail}"));
        }
    }
    Ok(())
}

pub fn updater_pubkey() -> Option<&'static str> {
    option_env!("AI_CHARACTER_UPDATER_PUBKEY").filter(|value| !value.trim().is_empty())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterBuildStatus {
    pub signed: bool,
    pub updater_ready: bool,
    pub source_run: bool,
    pub version: String,
}

/// Whether this binary can verify signed releases; the setup guide uses it to show what is left to do.
#[tauri::command]
pub fn get_updater_build_status() -> UpdaterBuildStatus {
    UpdaterBuildStatus {
        signed: updater_pubkey().is_some(),
        updater_ready: UPDATER_READY.load(Ordering::SeqCst),
        source_run: source_repo_root().is_some(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

pub fn updater_build_status_value() -> serde_json::Value {
    serde_json::to_value(get_updater_build_status()).unwrap_or(serde_json::Value::Null)
}

fn update_installed_app(app: &AppHandle) -> UpdateOutcome {
    let current = app.package_info().version.to_string();
    let outcome = |status: &str| {
        UpdateOutcome::new("app", "app-release", status).versions(Some(current.clone()), None)
    };
    let Some(pubkey) = updater_pubkey() else {
        return outcome("skipped").message("서명 공개키 없이 빌드되어 앱 자동 업데이트가 꺼져 있습니다.");
    };
    if !UPDATER_READY.load(Ordering::SeqCst) {
        return outcome("skipped").message("앱 업데이터를 초기화하지 못했습니다.");
    }
    if has_pending_app_update() {
        return outcome("pending_restart").message("내려받은 새 버전이 재시작을 기다리고 있습니다.");
    }
    use tauri_plugin_updater::UpdaterExt;
    let endpoint = match url::Url::parse(RELEASE_ENDPOINT) {
        Ok(url) => url,
        Err(error) => return outcome("failed").message(error.to_string()),
    };
    let updater = match app
        .updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.build())
    {
        Ok(updater) => updater,
        Err(error) => return outcome("failed").message(error.to_string()),
    };
    let checked = tauri::async_runtime::block_on(updater.check());
    let update = match checked {
        Ok(Some(update)) => update,
        Ok(None) => return outcome("current").versions(Some(current.clone()), Some(current.clone())),
        Err(error) => return outcome("failed").message(format!("업데이트 확인 실패: {error}")),
    };
    let next = update.version.clone();
    let downloaded = tauri::async_runtime::block_on(update.download(|_, _| {}, || {}));
    let result = downloaded.and_then(|bytes| {
        // Windows install exits the process into the installer, so it waits for an explicit restart.
        if cfg!(windows) || CANCEL_REQUESTED.load(Ordering::SeqCst) {
            if let Ok(mut slot) = PENDING_INSTALL.lock() {
                *slot = Some((update.clone(), bytes));
            }
            Ok(())
        } else {
            update.install(&bytes)
        }
    });
    match result {
        Ok(()) => UpdateOutcome::new("app", "app-release", "pending_restart")
            .versions(Some(current), Some(next))
            .message("설정의 '지금 재시작' 또는 트레이의 재시작을 누르면 새 버전이 적용됩니다."),
        Err(error) => UpdateOutcome::new("app", "app-release", "failed")
            .versions(Some(current), Some(next))
            .message(format!("서명 확인 또는 설치 실패로 현재 버전을 유지합니다: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_npm_global_listing() {
        let json = r#"{"dependencies":{"@openai/codex":{"version":"0.46.0"}}}"#;
        assert_eq!(
            parse_npm_global_version(json, "@openai/codex").as_deref(),
            Some("0.46.0")
        );
        assert_eq!(parse_npm_global_version(json, "@google/gemini-cli"), None);
        assert_eq!(parse_npm_global_version("not json", "@openai/codex"), None);
    }

    #[test]
    fn notice_lines_only_include_noteworthy_outcomes() {
        let outcomes = vec![
            UpdateOutcome::new("cli", "claude", "updated")
                .versions(Some("1.0.0".into()), Some("1.1.0".into())),
            UpdateOutcome::new("cli", "codex", "current"),
            UpdateOutcome::new("cli", "gemini", "rolled_back").message("boom\nmore"),
            UpdateOutcome::new("models", "gemini-models", "skipped"),
        ];
        let lines = notice_lines(&outcomes);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "claude 1.0.0 → 1.1.0: 업데이트 완료");
        assert_eq!(lines[1], "gemini: 실패하여 이전 버전 유지 (boom)");
    }

    #[test]
    fn cradle_activity_counts_overlapping_sessions() {
        set_cradle_activity(true);
        set_cradle_activity(true);
        set_cradle_activity(false);
        assert!(cradle_active());
        set_cradle_activity(false);
        assert!(!cradle_active());
        set_cradle_activity(false);
        assert!(!cradle_active());
        set_cradle_activity(true);
        CRADLE_TOUCHED_MS.store(now_ms() - CRADLE_STALE_MS - 1, Ordering::SeqCst);
        assert!(!cradle_active());
        set_cradle_activity(true);
        assert_eq!(CRADLE_SESSIONS.load(Ordering::SeqCst), 1);
        set_cradle_activity(false);
    }

    #[test]
    fn plugin_updates_share_the_cycle_guard() {
        assert!(!cancel_updates());
        let guard = try_begin_update().expect("first guard");
        assert!(try_begin_update().is_none());
        let first = step("cli", "a", || UpdateOutcome::new("cli", "a", "current"));
        assert_eq!(first.status, "current");
        assert!(get_update_status().running);
        assert_eq!(get_update_status().completed, 1);
        assert!(cancel_updates());
        let second = step("cli", "b", || panic!("held steps must not run"));
        assert_eq!(second.message.as_deref(), Some("사용자가 업데이트를 중지했습니다."));
        drop(guard);
        let status = get_update_status();
        assert!(!status.running && !status.cancel_requested && status.last_finished_at.is_some());
        assert!(try_begin_update().is_some());
    }

    #[test]
    fn first_line_skips_blank_lines_and_truncates() {
        assert_eq!(first_line("\n  \n hello \nworld"), "hello");
        assert_eq!(first_line(&"x".repeat(300)).len(), 160);
    }
}
