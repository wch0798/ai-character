//! Whether each subscription CLI (Claude, Codex, Cursor, Antigravity) is signed in, so the
//! setup page can say "로그인됨" instead of only "설치됨".

use crate::agent_core::{resolve_agent_binary, AgentKind};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogin {
    pub id: String,
    /// `None` when this CLI gives no reliable way to check.
    pub logged_in: Option<bool>,
    pub account: Option<String>,
    pub detail: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn login(id: &str, logged_in: Option<bool>, account: Option<String>, detail: &str) -> AgentLogin {
    AgentLogin { id: id.into(), logged_in, account, detail: detail.into() }
}

fn claude_login() -> AgentLogin {
    let file = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir).join(".claude.json"),
        None => match home_dir() {
            Some(home) => home.join(".claude.json"),
            None => return login("claude", None, None, "홈 폴더를 찾지 못했습니다."),
        },
    };
    claude_login_from(read_json(&file))
}

fn claude_login_from(config: Option<Value>) -> AgentLogin {
    let email = config
        .as_ref()
        .and_then(|value| value.pointer("/oauthAccount/emailAddress"))
        .and_then(Value::as_str)
        .map(str::to_string);
    match email {
        Some(email) => login("claude", Some(true), Some(email), "Claude 구독 계정으로 로그인되어 있습니다."),
        None => login("claude", Some(false), None, "로그인이 필요합니다."),
    }
}

fn codex_login() -> AgentLogin {
    let dir = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| home_dir().map(|home| home.join(".codex")));
    codex_login_from(dir.and_then(|dir| read_json(&dir.join("auth.json"))))
}

fn codex_login_from(auth: Option<Value>) -> AgentLogin {
    let Some(auth) = auth else {
        return login("codex", Some(false), None, "로그인이 필요합니다.");
    };
    if let Some(token) = auth.pointer("/tokens/id_token").and_then(Value::as_str) {
        let email = token
            .split('.')
            .nth(1)
            .and_then(|payload| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|claims| claims.get("email").and_then(Value::as_str).map(str::to_string));
        return login("codex", Some(true), email, "ChatGPT 계정으로 로그인되어 있습니다.");
    }
    if auth.get("OPENAI_API_KEY").and_then(Value::as_str).is_some_and(|key| !key.is_empty()) {
        return login("codex", Some(true), None, "OpenAI API 키로 연결되어 있습니다 (호출마다 요금이 나갈 수 있습니다).");
    }
    login("codex", Some(false), None, "로그인이 필요합니다.")
}

/// Cursor keeps its token outside plain files, so ask the CLI itself (`cursor-agent status`).
fn cursor_login() -> AgentLogin {
    let saved = crate::settings::load_settings().ok();
    let saved_path = saved.as_ref().and_then(|settings| settings.agent_path(AgentKind::Cursor).map(PathBuf::as_path));
    let Ok(binary) = resolve_agent_binary(AgentKind::Cursor, saved_path) else {
        return login("cursor", None, None, "Cursor 프로그램이 없어 확인할 수 없습니다.");
    };
    match run_with_timeout(&binary, &["status"], Duration::from_secs(15)) {
        Some(output) => cursor_login_from(&output),
        None => login("cursor", None, None, "로그인 상태를 확인하지 못했습니다 (응답 없음)."),
    }
}

fn cursor_login_from(output: &str) -> AgentLogin {
    let lower = output.to_lowercase();
    if lower.contains("not logged in") || lower.contains("not authenticated") {
        return login("cursor", Some(false), None, "로그인이 필요합니다.");
    }
    if lower.contains("logged in") || lower.contains("authenticated") {
        let account = output
            .split_whitespace()
            .find(|word| word.contains('@'))
            .map(|word| word.trim_matches(|c: char| !(c.is_alphanumeric() || "@._-+".contains(c))).to_string());
        return login("cursor", Some(true), account, "Cursor 계정으로 로그인되어 있습니다.");
    }
    login("cursor", None, None, "로그인 상태를 알 수 없습니다.")
}

/// Antigravity has no status command, but `agy models` refuses with "Please sign in" when
/// signed out and lists models when signed in.
fn antigravity_login() -> AgentLogin {
    let saved = crate::settings::load_settings().ok();
    let saved_path = saved.as_ref().and_then(|settings| settings.agent_path(AgentKind::Antigravity).map(PathBuf::as_path));
    let Ok(binary) = resolve_agent_binary(AgentKind::Antigravity, saved_path) else {
        return login("antigravity", None, None, "Antigravity 프로그램이 없어 확인할 수 없습니다.");
    };
    match run_with_timeout(&binary, &["models"], Duration::from_secs(30)) {
        Some(output) => antigravity_login_from(&output),
        None => login("antigravity", None, None, "로그인 상태를 확인하지 못했습니다 (응답 없음)."),
    }
}

fn antigravity_login_from(output: &str) -> AgentLogin {
    let lower = output.to_lowercase();
    if lower.contains("sign in") || lower.contains("signed in") || lower.contains("log in") {
        return login("antigravity", Some(false), None, "로그인이 필요합니다.");
    }
    let listed = output.lines().filter(|line| !line.trim().is_empty() && !line.to_lowercase().starts_with("fetching")).count();
    if listed > 0 && !lower.contains("error") {
        return login("antigravity", Some(true), antigravity_account(), "Google 계정으로 로그인되어 있습니다.");
    }
    login("antigravity", None, None, "로그인 상태를 확인하지 못했습니다. 인터넷 연결을 확인하세요.")
}

/// The CLI prints no account, but each run logs "authenticated successfully as <email>" under
/// ~/.gemini/antigravity-cli; the newest log that has it names the signed-in account.
fn antigravity_account() -> Option<String> {
    let dir = home_dir()?.join(".gemini").join("antigravity-cli");
    let mut logs: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir.join("log"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .chain(std::iter::once(dir.join("cli.log")))
        .filter_map(|path| Some((std::fs::metadata(&path).ok()?.modified().ok()?, path)))
        .collect();
    logs.sort_by(|a, b| b.0.cmp(&a.0));
    logs.iter().take(20).find_map(|(_, path)| antigravity_account_from_log(&std::fs::read_to_string(path).ok()?))
}

fn antigravity_account_from_log(text: &str) -> Option<String> {
    const MARKER: &str = "authenticated successfully as ";
    let line = text.lines().rev().find(|line| line.contains(MARKER))?;
    let account = line.split(MARKER).nth(1)?.split_whitespace().next()?.trim_end_matches(|c: char| ",.;".contains(c));
    account.contains('@').then(|| account.to_string())
}

fn run_with_timeout(binary: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut command = crate::windows_process::command_with_args(binary, args);
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    Some(format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
}

/// Asking the Cursor and Antigravity CLIs takes seconds (Antigravity up to 30), and the settings
/// screen asks on every open and every window focus, so a recent answer is reused.
const FRESH_FOR: Duration = Duration::from_secs(60);
/// After a login window opens, every check asks again until the user has had time to finish.
const LOGIN_WINDOW: Duration = Duration::from_secs(180);

static LAST: Mutex<Option<(Instant, Vec<AgentLogin>)>> = Mutex::new(None);
static CHECKING: Mutex<()> = Mutex::new(());
static LOGIN_STARTED: Mutex<Option<Instant>> = Mutex::new(None);

pub fn note_login_started() {
    *LOGIN_STARTED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
}

/// The last answer, however old, so a screen can show something before a new check finishes.
pub fn last_agent_logins() -> Option<Vec<AgentLogin>> {
    LAST.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(_, logins)| logins.clone())
}

/// An answer no older than `FRESH_FOR` (none while a login is in progress), else a new check.
pub fn agent_logins() -> Vec<AgentLogin> {
    let logging_in = LOGIN_STARTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some_and(|started| started.elapsed() < LOGIN_WINDOW);
    agent_logins_within(if logging_in { Duration::ZERO } else { FRESH_FOR })
}

pub fn fresh_agent_logins() -> Vec<AgentLogin> {
    agent_logins_within(Duration::ZERO)
}

fn agent_logins_within(max_age: Duration) -> Vec<AgentLogin> {
    // `None` this early after boot means any answer is recent enough.
    let since = Instant::now().checked_sub(max_age);
    let recent = || {
        LAST.lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|(at, _)| since.is_none_or(|since| *at >= since))
            .map(|(_, logins)| logins.clone())
    };
    if let Some(logins) = recent() {
        return logins;
    }
    // One check at a time: a caller that waited here takes the answer the other one just got.
    let _checking = CHECKING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(logins) = recent() {
        return logins;
    }
    let logins = check_agent_logins();
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), logins.clone()));
    logins
}

#[tauri::command]
pub async fn get_agent_logins(force: Option<bool>) -> Result<Vec<AgentLogin>, String> {
    let check = if force == Some(true) { fresh_agent_logins } else { agent_logins };
    tauri::async_runtime::spawn_blocking(check)
        .await
        .map_err(|error| format!("로그인 상태 확인 실패: {error}"))
}

#[tauri::command]
pub fn get_last_agent_logins() -> Option<Vec<AgentLogin>> {
    last_agent_logins()
}

/// Checks run in parallel; the Cursor CLI can take a few seconds.
fn check_agent_logins() -> Vec<AgentLogin> {
    let cursor = std::thread::spawn(cursor_login);
    let antigravity = std::thread::spawn(antigravity_login);
    let mut logins = vec![claude_login(), codex_login()];
    logins.push(cursor.join().unwrap_or_else(|_| login("cursor", None, None, "로그인 상태를 확인하지 못했습니다.")));
    logins.push(antigravity.join().unwrap_or_else(|_| login("antigravity", None, None, "로그인 상태를 확인하지 못했습니다.")));
    logins
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_is_signed_in_only_with_an_oauth_email() {
        let signed = claude_login_from(Some(json!({ "oauthAccount": { "emailAddress": "me@example.com" } })));
        assert_eq!((signed.logged_in, signed.account.as_deref()), (Some(true), Some("me@example.com")));
        assert_eq!(claude_login_from(Some(json!({}))).logged_in, Some(false));
        assert_eq!(claude_login_from(None).logged_in, Some(false));
    }

    #[test]
    fn codex_reads_the_email_from_the_id_token() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"email":"me@example.com"}"#);
        let signed = codex_login_from(Some(json!({ "tokens": { "id_token": format!("h.{payload}.s") } })));
        assert_eq!((signed.logged_in, signed.account.as_deref()), (Some(true), Some("me@example.com")));
        assert_eq!(codex_login_from(Some(json!({ "OPENAI_API_KEY": null }))).logged_in, Some(false));
        assert_eq!(codex_login_from(None).logged_in, Some(false));
    }

    #[test]
    fn cursor_status_text_is_parsed() {
        assert_eq!(cursor_login_from("Not logged in").logged_in, Some(false));
        let signed = cursor_login_from("✓ Logged in as me@example.com");
        assert_eq!((signed.logged_in, signed.account.as_deref()), (Some(true), Some("me@example.com")));
        assert_eq!(cursor_login_from("something else").logged_in, None);
    }

    #[test]
    fn antigravity_models_output_is_parsed() {
        let signed_out = "Fetching available models...
Error: Please sign in to view available models. Launch the CLI without arguments to sign in.";
        assert_eq!(antigravity_login_from(signed_out).logged_in, Some(false));
        assert_eq!(antigravity_login_from("Fetching available models...
gemini-4-argon
gemini-3-flash").logged_in, Some(true));
        assert_eq!(antigravity_login_from("Fetching available models...
Error: network unreachable").logged_in, None);
    }

    #[test]
    fn antigravity_account_comes_from_the_newest_log_line() {
        let log = "I1022 server_oauth.go:229] OAuth: authenticated successfully as old@example.com
I1022 server_oauth.go:229] OAuth: authenticated successfully as me@example.com
I1022 experiment_manager.go:66] Starting experiment refresh after login";
        assert_eq!(antigravity_account_from_log(log).as_deref(), Some("me@example.com"));
        assert_eq!(antigravity_account_from_log("Auth mode is unspecified"), None);
    }
}
