use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkLogSnapshot {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub technical: String,
    #[serde(default)]
    pub updated_at: u64,
}

static CURRENT: Mutex<WorkLogSnapshot> = Mutex::new(WorkLogSnapshot {
    title: String::new(),
    status: String::new(),
    output: String::new(),
    technical: String::new(),
    updated_at: 0,
});

fn store(snapshot: WorkLogSnapshot) {
    if let Ok(mut current) = CURRENT.lock() {
        *current = snapshot;
    }
}

fn current_snapshot() -> WorkLogSnapshot {
    CURRENT.lock().map(|guard| guard.clone()).unwrap_or_default()
}

fn format_work_log(snapshot: &WorkLogSnapshot) -> String {
    let mut parts = Vec::new();
    if !snapshot.status.trim().is_empty() {
        parts.push(format!("상태: {}", snapshot.status.trim()));
    }
    if !snapshot.output.trim().is_empty() {
        parts.push(format!("진행 로그:\n{}", snapshot.output.trim()));
    }
    if !snapshot.technical.trim().is_empty() {
        parts.push(format!("기술 상세:\n{}", snapshot.technical.trim()));
    }
    if parts.is_empty() {
        "아직 기록된 로그가 없습니다.".to_string()
    } else {
        parts.join("\n\n")
    }
}

fn close_log_window(app: &AppHandle) {
    if let Some(existing) = app.get_webview_window("work-log") {
        let _ = existing.close();
    }
    crate::window_stack::restore_main_always_on_top(app);
}

#[tauri::command]
pub fn get_work_log() -> WorkLogSnapshot {
    current_snapshot()
}

#[tauri::command]
pub fn set_work_log(snapshot: WorkLogSnapshot) -> Result<(), String> {
    store(snapshot);
    Ok(())
}

#[tauri::command]
pub fn close_work_log(app: AppHandle) -> Result<(), String> {
    close_log_window(&app);
    Ok(())
}

#[tauri::command]
pub fn open_work_log(app: AppHandle, snapshot: WorkLogSnapshot) -> Result<(), String> {
    store(snapshot);
    close_log_window(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_technical_details() {
        let snapshot = WorkLogSnapshot {
            title: "기술 로그".into(),
            status: "다시 시도해 주세요".into(),
            output: "stderr: failed".into(),
            technical: "ENOENT claude.exe".into(),
            updated_at: 1,
        };
        let text = format_work_log(&snapshot);
        assert!(text.contains("ENOENT claude.exe"));
        assert!(text.contains("stderr: failed"));
        assert!(!text.contains("응답 없음"));
        assert!(!text.contains("localhost:1420"));
    }
}
