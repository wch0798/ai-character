use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_TEXT_FILE_BYTES: usize = 20 * 1024 * 1024;

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("폴더를 만들 수 없습니다: {}", error)
            })?;
        }
    }
    Ok(())
}

fn assert_text_file_path(path: &Path, for_write: bool) -> Result<PathBuf, String> {
    // A network path makes Windows contact that server (and send the user's login hash) just
    // by looking; `..` would let a path walk past the system-folder check below.
    if crate::workspace_guard::is_network_path(&path.to_string_lossy()) {
        return Err("네트워크 경로는 사용할 수 없습니다. 이 PC의 폴더를 골라 주세요.".to_string());
    }
    if path.components().any(|part| part == std::path::Component::ParentDir) {
        return Err("경로에 '..'을 쓸 수 없습니다. 폴더를 직접 골라 주세요.".to_string());
    }
    if !path.is_absolute() {
        return Err("전체 경로가 필요합니다. 저장 위치를 직접 골라 주세요.".to_string());
    }
    let target = crate::path_guard::assert_inspectable_path(path)?;
    if target.is_dir() {
        return Err("폴더 경로는 사용할 수 없습니다.".to_string());
    }
    if for_write {
        if let Some(parent) = target.parent() {
            if parent.as_os_str().is_empty() || crate::path_guard::is_blocked_system_path(parent) {
                return Err("이 경로는 저장할 수 없습니다.".to_string());
            }
        }
    }
    Ok(target)
}

#[derive(Debug, Serialize)]
pub struct TextFileResult {
    pub path: String,
    pub bytes: usize,
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<TextFileResult, String> {
    if contents.len() > MAX_TEXT_FILE_BYTES {
        return Err("파일이 너무 큽니다.".to_string());
    }
    let target = assert_text_file_path(Path::new(&path), true)?;
    ensure_parent(&target)?;
    let bytes = contents.as_bytes().len();
    // Through a temp file and a rename, so a crash mid-write never leaves the file cut short.
    let temp = target.with_extension(format!(
        "{}ai-character-tmp",
        target.extension().map(|ext| format!("{}.", ext.to_string_lossy())).unwrap_or_default()
    ));
    fs::write(&temp, contents.as_bytes()).map_err(|error| format!("파일 저장 실패: {}", error))?;
    if let Err(error) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(format!("파일 저장 실패: {}", error));
    }

    Ok(TextFileResult {
        path: target.display().to_string(),
        bytes,
    })
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let target = assert_text_file_path(Path::new(&path), false)?;
    if !target.is_file() {
        return Err("파일을 찾을 수 없습니다.".to_string());
    }

    let metadata = fs::metadata(&target).map_err(|error| format!("파일 읽기 실패: {}", error))?;
    if metadata.len() > MAX_TEXT_FILE_BYTES as u64 {
        return Err("파일이 너무 큽니다.".to_string());
    }

    fs::read_to_string(&target).map_err(|error| format!("파일 읽기 실패: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_system_paths() {
        let err = write_text_file(
            r"C:\Windows\System32\drivers\etc\hosts".to_string(),
            "x".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("경로"));
    }

    #[test]
    fn rejects_network_relative_and_parent_paths() {
        for path in [r"\\server\share\a.txt", "//server/share/a.txt", r"C:\Users\..\Windows\Temp\x.txt", "notes.txt"] {
            assert!(write_text_file(path.to_string(), "x".to_string()).is_err(), "{path}");
        }
    }
}
