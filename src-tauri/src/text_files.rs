use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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

#[derive(Debug, Serialize)]
pub struct TextFileResult {
    pub path: String,
    pub bytes: usize,
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<TextFileResult, String> {
    let target = PathBuf::from(&path);
    if target.as_os_str().is_empty() {
        return Err("저장 경로가 비어 있습니다.".to_string());
    }

    ensure_parent(&target)?;
    let bytes = contents.as_bytes().len();
    fs::write(&target, contents.as_bytes())
        .map_err(|error| format!("파일 저장 실패: {}", error))?;

    Ok(TextFileResult {
        path: target.display().to_string(),
        bytes,
    })
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err("파일을 찾을 수 없습니다.".to_string());
    }

    fs::read_to_string(&target).map_err(|error| format!("파일 읽기 실패: {}", error))
}
