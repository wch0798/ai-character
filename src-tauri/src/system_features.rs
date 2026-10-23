//! App-level preferences that live outside the chat: the show/hide shortcut, starting with
//! Windows, diagnostics (log file, panic log, copyable summary) and Windows voice typing.

use crate::settings::{load_settings, save_settings};
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

pub const DEFAULT_TOGGLE_SHORTCUT: &str = "ctrl+shift+space";
const TOGGLE_SHORTCUT_KEY: &str = "app.toggle_shortcut";
const LOG_LIMIT_BYTES: u64 = 1024 * 1024;

// ---------- show/hide shortcut ----------

/// `"Ctrl + Shift + K"` → `"ctrl+shift+k"`; rejects a key without a modifier, which would
/// steal that key from every other program.
pub fn normalize_shortcut(raw: &str) -> Result<String, String> {
    let parts: Vec<String> = raw
        .split('+')
        .map(|part| part.trim().to_lowercase())
        .filter(|part| !part.is_empty())
        .collect();
    let modifiers = ["ctrl", "control", "shift", "alt", "super", "cmd", "command", "meta"];
    let (mods, keys): (Vec<_>, Vec<_>) = parts.iter().partition(|part| modifiers.contains(&part.as_str()));
    if keys.len() != 1 {
        return Err("단축키는 Ctrl·Alt·Shift 같은 조합키와 다른 키 하나로 정해 주세요.".to_string());
    }
    if mods.is_empty() {
        return Err("다른 프로그램의 입력을 가로채지 않도록 Ctrl·Alt·Shift 중 하나 이상을 함께 눌러 주세요.".to_string());
    }
    let mut ordered: Vec<&str> = Vec::new();
    for (wanted, aliases) in [("ctrl", &["ctrl", "control"][..]), ("alt", &["alt"][..]), ("shift", &["shift"][..]), ("super", &["super", "cmd", "command", "meta"][..])] {
        if mods.iter().any(|part| aliases.contains(&part.as_str())) {
            ordered.push(wanted);
        }
    }
    let mut text = ordered.join("+");
    text.push('+');
    text.push_str(keys[0]);
    Ok(text)
}

pub fn configured_toggle_shortcut() -> String {
    load_settings()
        .ok()
        .and_then(|settings| settings.extra(TOGGLE_SHORTCUT_KEY).map(str::to_string))
        .and_then(|value| normalize_shortcut(&value).ok())
        .unwrap_or_else(|| DEFAULT_TOGGLE_SHORTCUT.to_string())
}

#[cfg(desktop)]
fn parse_shortcut(text: &str) -> Result<tauri_plugin_global_shortcut::Shortcut, String> {
    text.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|_| format!("‘{text}’은(는) 단축키로 쓸 수 없는 조합입니다."))
}

/// Registers the saved shortcut at start-up; falls back to the default when it can't.
#[cfg(desktop)]
pub fn register_toggle_shortcut(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let wanted = configured_toggle_shortcut();
    for candidate in [wanted.as_str(), DEFAULT_TOGGLE_SHORTCUT] {
        if let Ok(shortcut) = parse_shortcut(candidate) {
            match app.global_shortcut().register(shortcut) {
                Ok(()) => return,
                Err(error) => eprintln!("전역 단축키 {candidate} 등록 실패: {error}"),
            }
        }
    }
}

#[tauri::command]
pub fn get_toggle_shortcut() -> String {
    configured_toggle_shortcut()
}

/// Swaps the show/hide shortcut. If the new one can't be registered (another program owns it)
/// the old one stays and the reason comes back in Korean.
#[cfg(desktop)]
#[tauri::command]
pub fn set_toggle_shortcut(app: AppHandle, shortcut: Option<String>) -> Result<String, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let next = match shortcut {
        Some(raw) if !raw.trim().is_empty() => normalize_shortcut(&raw)?,
        _ => DEFAULT_TOGGLE_SHORTCUT.to_string(),
    };
    let previous = configured_toggle_shortcut();
    if next == previous {
        return Ok(next);
    }
    let next_shortcut = parse_shortcut(&next)?;
    let global = app.global_shortcut();
    if let Ok(old) = parse_shortcut(&previous) {
        let _ = global.unregister(old);
    }
    if let Err(error) = global.register(next_shortcut) {
        if let Ok(old) = parse_shortcut(&previous) {
            let _ = global.register(old);
        }
        return Err(format!(
            "{next}은(는) 다른 프로그램이 이미 쓰고 있어 등록하지 못했습니다. 다른 조합을 골라 주세요. ({error})"
        ));
    }
    let mut settings = load_settings()?;
    settings.set_extra(
        TOGGLE_SHORTCUT_KEY,
        (next != DEFAULT_TOGGLE_SHORTCUT).then(|| next.clone()),
    );
    save_settings(&settings)?;
    Ok(next)
}

// ---------- start with Windows ----------

#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "AI Character";

#[tauri::command]
pub fn get_autostart() -> bool {
    #[cfg(windows)]
    {
        windows_registry::CURRENT_USER
            .open(RUN_KEY)
            .and_then(|key| key.get_string(RUN_VALUE))
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let key = windows_registry::CURRENT_USER
            .create(RUN_KEY)
            .map_err(|error| format!("시작 프로그램 설정을 열지 못했습니다: {error}"))?;
        if enabled {
            let exe = std::env::current_exe().map_err(|error| format!("앱 위치를 찾지 못했습니다: {error}"))?;
            key.set_string(RUN_VALUE, format!("\"{}\"", exe.display()))
                .map_err(|error| format!("시작 프로그램에 등록하지 못했습니다: {error}"))?;
        } else {
            let _ = key.remove_value(RUN_VALUE);
        }
        Ok(get_autostart())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Windows에서만 지원합니다.".to_string())
    }
}

// ---------- diagnostics ----------

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn log_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join("logs"))
}

/// Appends one line (secrets masked) to logs/app.log, moving a full log to app.old.log.
pub fn append_log(level: &str, message: &str) {
    let Some(path) = LOG_PATH.get() else { return };
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if std::fs::metadata(path).map(|meta| meta.len() > LOG_LIMIT_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_file_name("app.old.log"));
    }
    let masked = crate::policy_engine::mask_secrets(message);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{stamp}] {level} {}", masked.replace('\n', "\n    "));
    }
}

/// Starts the log file and records panics into it (the release build aborts on panic, so this
/// is the only trace a crash leaves).
pub fn init_diagnostics(app: &AppHandle) {
    let Some(dir) = log_dir(app) else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = LOG_PATH.set(dir.join("app.log"));
    append_log("INFO", &format!("앱 시작 v{}", env!("CARGO_PKG_VERSION")));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        append_log("PANIC", &info.to_string());
        previous(info);
    }));
}

/// Errors the page could not handle (window.onerror, unhandled promise rejections).
#[tauri::command]
pub fn log_frontend_error(message: String) {
    let message: String = message.chars().take(4000).collect();
    append_log("UI", &message);
}

#[tauri::command]
pub fn open_log_folder(app: AppHandle) -> Result<String, String> {
    let dir = log_dir(&app).ok_or("로그 폴더를 찾지 못했습니다.")?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("로그 폴더를 만들지 못했습니다: {error}"))?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("로그 폴더를 열지 못했습니다: {error}"))?;
    Ok(dir.display().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub text: String,
}

fn windows_version() -> String {
    #[cfg(windows)]
    {
        let read = || -> Option<String> {
            let key = windows_registry::LOCAL_MACHINE.open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion").ok()?;
            let name = key.get_string("ProductName").unwrap_or_default();
            let display = key.get_string("DisplayVersion").unwrap_or_default();
            let build = key.get_string("CurrentBuild").unwrap_or_default();
            Some(format!("{name} {display} (build {build})"))
        };
        read().unwrap_or_else(|| "Windows".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::consts::OS.to_string()
    }
}

/// A summary a beginner can paste to whoever helps them. No keys: it goes through mask_secrets
/// and lists keys only by whether they are set.
#[tauri::command]
pub fn get_diagnostics(app: AppHandle) -> Diagnostics {
    let mut lines = vec![
        "AI Character 진단 정보".to_string(),
        format!("버전: {}", env!("CARGO_PKG_VERSION")),
        format!("운영체제: {} / {}", windows_version(), std::env::consts::ARCH),
        format!("단축키: {}", configured_toggle_shortcut()),
        format!("Windows 시작 시 실행: {}", if get_autostart() { "켜짐" } else { "꺼짐" }),
    ];
    match crate::login_status::last_agent_logins() {
        Some(logins) => {
            for login in logins {
                let state = match login.logged_in {
                    Some(true) => "로그인됨",
                    Some(false) => "로그인 필요",
                    None => "확인 불가",
                };
                lines.push(format!("{}: {state}", login.id));
            }
        }
        None => lines.push("AI 프로그램 로그인: 아직 확인 전".to_string()),
    }
    if let Ok(settings) = load_settings() {
        lines.push(format!("기본 AI: {}", settings.default_agent.display_name()));
        lines.push(format!("설정 완료: {}", if settings.extra_bool("setup.completed", false) { "예" } else { "아니요" }));
    }
    let keys: Vec<&str> = crate::policy_engine::SECRET_ENV_NAMES
        .iter()
        .copied()
        .filter(|name| crate::process_util::secret_value(name).is_some())
        .collect();
    lines.push(format!("저장된 키 종류: {}", if keys.is_empty() { "없음".to_string() } else { keys.join(", ") }));
    if let Some(dir) = log_dir(&app) {
        let tail = std::fs::read_to_string(dir.join("app.log")).unwrap_or_default();
        let recent: Vec<&str> = tail.lines().rev().take(30).collect();
        if !recent.is_empty() {
            lines.push(String::new());
            lines.push("최근 기록:".to_string());
            lines.extend(recent.into_iter().rev().map(str::to_string));
        }
    }
    Diagnostics { text: crate::policy_engine::mask_secrets(&lines.join("\n")) }
}

// ---------- voice typing ----------

/// Opens Windows voice typing (Win+H) for whatever input has focus. WebView2 has no speech
/// recognition of its own; Windows' built-in one also handles Korean.
#[tauri::command]
pub fn start_voice_typing() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN,
        };
        const VK_H: VIRTUAL_KEY = 0x48;
        let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 },
            },
        };
        let inputs = [key(VK_LWIN, false), key(VK_H, false), key(VK_H, true), key(VK_LWIN, true)];
        let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err("Windows 음성 입력을 열지 못했습니다. Win+H를 직접 눌러 보세요.".to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Windows에서만 지원합니다.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_are_normalized_and_need_a_modifier() {
        assert_eq!(normalize_shortcut("Shift + Ctrl + K").as_deref(), Ok("ctrl+shift+k"));
        assert_eq!(normalize_shortcut("control+alt+space").as_deref(), Ok("ctrl+alt+space"));
        assert!(normalize_shortcut("k").is_err());
        assert!(normalize_shortcut("ctrl+shift").is_err());
        assert!(normalize_shortcut("ctrl+a+b").is_err());
    }
}
