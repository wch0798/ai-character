//! Native Windows notifications under the app's own name and icon.
//!
//! The notification plugin borrows PowerShell's identity whenever the exe runs from a build
//! folder, so popups said "Windows PowerShell". Registering the app id under
//! `HKCU\Software\Classes\AppUserModelId` (what installer-less desktop apps do) lets Windows
//! show "AI Character" with the app icon whether or not the app was installed.

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tauri_winrt_notification::{Duration, Sound, Toast};

const DISPLAY_NAME: &str = "AI Character";
const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");

static APP_ID: OnceLock<String> = OnceLock::new();

fn icon_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("notification-icon.png");
    if std::fs::read(&path).ok().as_deref() != Some(ICON) {
        std::fs::write(&path, ICON).ok()?;
    }
    Some(path)
}

/// Registers the app as a notification sender. Safe to call on every start.
pub fn register(app: &AppHandle) -> Result<(), String> {
    let app_id = app.config().identifier.clone();
    let key = windows_registry::CURRENT_USER
        .create(format!(r"Software\Classes\AppUserModelId\{app_id}"))
        .map_err(|error| format!("알림 등록 실패: {error}"))?;
    key.set_string("DisplayName", DISPLAY_NAME).map_err(|error| format!("알림 등록 실패: {error}"))?;
    if let Some(icon) = icon_path(app) {
        key.set_string("IconUri", icon.to_string_lossy()).map_err(|error| format!("알림 등록 실패: {error}"))?;
    }
    let _ = APP_ID.set(app_id);
    Ok(())
}

/// Shows a toast as "AI Character"; `false` when not registered or Windows refused it.
pub fn show(title: &str, body: &str) -> bool {
    let Some(app_id) = APP_ID.get() else { return false };
    Toast::new(app_id)
        .title(title)
        .text1(body)
        .sound(Some(Sound::Default))
        .duration(Duration::Short)
        .show()
        .is_ok()
}
