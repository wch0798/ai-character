//! "모든 데이터 지우기" and settings backup for the app settings screen.
//!
//! Wiping only touches the app's own data folders: never the user's project folders (their
//! conversation copies under `.ai-character` stay, as they are the user's files to delete).

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WipeResult {
    /// What was removed, in Korean, one item per line.
    pub removed: Vec<String>,
    /// What could not be removed (e.g. a file in use), in Korean.
    pub failed: Vec<String>,
}

fn remove_file(path: &std::path::Path, label: &str, result: &mut WipeResult) {
    if !path.exists() {
        return;
    }
    match std::fs::remove_file(path) {
        Ok(()) => result.removed.push(label.to_string()),
        Err(error) => result.failed.push(format!("{label}: {error}")),
    }
}

/// Removes saved keys, settings, usage records and UI state, and app logs. The frontend then
/// clears its own storage and restarts the app.
#[tauri::command]
pub fn wipe_all_data(app: AppHandle) -> Result<WipeResult, String> {
    let mut result = WipeResult { removed: Vec::new(), failed: Vec::new() };

    // Keys: the app's own keys file, and the copies already loaded in memory.
    if let Ok(dir) = crate::chat_state::app_support_dir() {
        remove_file(&dir.join("keys.env"), "저장된 API 키", &mut result);
    }
    for name in crate::policy_engine::SECRET_ENV_NAMES {
        crate::process_util::set_secret_value(name, None);
    }

    // Usage records, approvals, scheduled jobs and the UI state mirror share one database that
    // is open while the app runs, so its tables are emptied instead of deleting the file.
    match crate::chat_state::open_state_db() {
        Ok(connection) => {
            let tables: Vec<String> = connection
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
                .and_then(|mut statement| {
                    statement.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()
                })
                .unwrap_or_default();
            let mut ok = true;
            for table in &tables {
                if connection.execute(&format!("DELETE FROM \"{}\"", table.replace('"', "\"\"")), []).is_err() {
                    ok = false;
                }
            }
            let _ = connection.execute_batch("VACUUM;");
            if ok {
                result.removed.push("사용 기록·예약 작업·화면 상태".to_string());
            } else {
                result.failed.push("사용 기록 일부를 지우지 못했습니다".to_string());
            }
        }
        Err(error) => result.failed.push(format!("사용 기록: {error}")),
    }

    // Logs.
    if let Ok(dir) = app.path().app_local_data_dir() {
        let logs = dir.join("logs");
        if logs.exists() {
            match std::fs::remove_dir_all(&logs) {
                Ok(()) => result.removed.push("앱 기록(로그)".to_string()),
                Err(error) => result.failed.push(format!("앱 기록(로그): {error}")),
            }
        }
    }

    // Settings last: everything above may still read them.
    if let Ok(path) = crate::settings::settings_path() {
        remove_file(&path, "설정", &mut result);
    }

    Ok(result)
}

/// The same backup the setup web page exports: preferences, alerts, update settings and the
/// work folder. Never key values.
#[tauri::command]
pub fn export_settings_backup() -> Result<Value, String> {
    crate::setup_web::export_settings()
}

/// Restores a backup made by [`export_settings_backup`] or the setup web page. Returns
/// `{ applied: [..], warning: string|null }`.
#[tauri::command]
pub fn import_settings_backup(backup: Value) -> Result<Value, String> {
    crate::setup_web::import_settings(backup)
}
