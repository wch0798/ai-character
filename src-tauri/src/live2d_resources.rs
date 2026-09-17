use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

fn live2d_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resource_dir 실패: {error}"))?;
    let nested = resource.join("resources").join("live2d");
    if nested.is_dir() {
        return Ok(nested);
    }
    let flat = resource.join("live2d");
    if flat.is_dir() {
        return Ok(flat);
    }
    Err(format!(
        "Live2D Resources를 찾지 못했습니다: {} 또는 {}",
        nested.display(),
        flat.display()
    ))
}

fn sanitize_relative(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return Err("빈 Live2D 경로".to_string());
    }
    if trimmed.split('/').any(|part| part == "..") {
        return Err("Live2D 경로에 '..'를 사용할 수 없습니다.".to_string());
    }
    let normalized = trimmed
        .strip_prefix("live2d/")
        .unwrap_or(trimmed)
        .to_string();
    Ok(PathBuf::from(normalized))
}

pub fn resolve_bundled_live2d_file<R: Runtime>(
    app: &AppHandle<R>,
    relative: &str,
) -> Result<PathBuf, String> {
    let root = live2d_root(app)?;
    let rel = sanitize_relative(relative)?;
    let absolute = root.join(&rel);
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Live2D root canonicalize 실패: {error}"))?;
    let canonical = absolute
        .canonicalize()
        .map_err(|error| format!("Live2D 파일 없음: {} ({error})", absolute.display()))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Live2D Resources 밖으로 나가는 경로는 허용되지 않습니다.".to_string());
    }
    if !canonical.is_file() {
        return Err(format!("Live2D 파일이 아닙니다: {}", canonical.display()));
    }
    Ok(canonical)
}

#[tauri::command]
pub fn read_live2d_bytes<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<String, String> {
    let file = crate::live2d_user::resolve_any_live2d_file(&app, &path)?;
    let bytes = fs::read(&file)
        .map_err(|error| format!("Live2D 읽기 실패: {} ({error})", file.display()))?;
    Ok(STANDARD.encode(&bytes))
}

#[tauri::command]
pub fn read_live2d_text<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<String, String> {
    let file = crate::live2d_user::resolve_any_live2d_file(&app, &path)?;
    fs::read_to_string(&file)
        .map_err(|error| format!("Live2D 텍스트 읽기 실패: {} ({error})", file.display()))
}
