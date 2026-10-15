use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const STATE_KEY: &str = "ui.local_storage.v1";

pub(crate) fn app_support_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or("HOME 환경 변수가 없습니다.")?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("AI-Character"));
    }

    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA").ok_or("APPDATA 환경 변수가 없습니다.")?;
        return Ok(PathBuf::from(appdata).join("AI-Character"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(config).join("ai-character"));
        }
        let home = std::env::var_os("HOME").ok_or("HOME 환경 변수가 없습니다.")?;
        Ok(PathBuf::from(home).join(".config").join("ai-character"))
    }
}

pub(crate) fn state_db_path() -> Result<PathBuf, String> {
    // UI 상태는 프로젝트(외장 디스크)가 아니라 앱 지원 폴더에 둡니다.
    // 외장 볼륨 TCC 권한 대화상자에 막혀 Live2D가 시작되지 않는 문제를 피합니다.
    Ok(app_support_dir()?.join("state.db"))
}

pub(crate) fn open_state_db() -> Result<Connection, String> {
    let path = state_db_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("SQLite 상태 폴더 생성 실패: {} ({error})", parent.display())
        })?;
    }

    let connection = Connection::open(&path)
        .map_err(|error| format!("SQLite 상태 DB 열기 실패: {} ({error})", path.display()))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;\n\
             PRAGMA synchronous=NORMAL;\n\
             CREATE TABLE IF NOT EXISTS app_state (\n\
               key TEXT PRIMARY KEY,\n\
               value TEXT NOT NULL,\n\
               updated_at INTEGER NOT NULL\n\
             );",
        )
        .map_err(|error| format!("SQLite 상태 DB 초기화 실패: {error}"))?;
    Ok(connection)
}

#[tauri::command]
pub fn load_ui_state() -> Result<Option<String>, String> {
    let connection = open_state_db()?;
    connection
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![STATE_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("SQLite UI 상태 읽기 실패: {error}"))
}

#[tauri::command]
pub fn save_ui_state(payload: String) -> Result<(), String> {
    let connection = open_state_db()?;
    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("시스템 시간 확인 실패: {error}"))?
        .as_secs() as i64;

    connection
        .execute(
            "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, ?3)\n\
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![STATE_KEY, payload, updated_at],
        )
        .map_err(|error| format!("SQLite UI 상태 저장 실패: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_state_db_path() -> Result<String, String> {
    Ok(state_db_path()?.to_string_lossy().into_owned())
}
