//! Screenshots pasted into the chat (Ctrl+V) arrive as bytes, not files. They are saved to a
//! temp file so they go through the same attachment path as a dropped file.

use std::time::{SystemTime, UNIX_EPOCH};

/// Pasted images larger than this are refused (a full-screen 4K PNG is ~10 MB).
const MAX_BYTES: usize = 25 * 1024 * 1024;

fn extension_for(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}

/// Attachments are copied into the project's staging folder when added, so a pasted file is
/// only needed for a moment; anything older than a day is left over.
fn remove_old_pastes(dir: &std::path::Path) {
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > day);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The image comes as the raw request body (not a JSON number array, which is about four times
/// larger) with its type in the `x-mime` header.
#[tauri::command]
pub fn save_pasted_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("붙여넣은 그림을 받지 못했습니다.".to_string());
    };
    let mime = request.headers().get("x-mime").and_then(|value| value.to_str().ok()).unwrap_or_default();
    let extension = extension_for(mime).ok_or_else(|| "붙여넣은 내용이 그림 파일 형식이 아닙니다.".to_string())?;
    if bytes.is_empty() {
        return Err("붙여넣은 그림이 비어 있습니다.".to_string());
    }
    if bytes.len() > MAX_BYTES {
        return Err("붙여넣은 그림이 너무 큽니다 (25MB까지).".to_string());
    }
    let dir = std::env::temp_dir().join("ai-character-paste");
    std::fs::create_dir_all(&dir).map_err(|error| format!("임시 폴더를 만들지 못했습니다: {error}"))?;
    remove_old_pastes(&dir);
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("붙여넣은-그림-{stamp}.{extension}"));
    std::fs::write(&path, bytes).map_err(|error| format!("붙여넣은 그림을 저장하지 못했습니다: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_image_types_are_accepted() {
        assert_eq!(extension_for("image/png"), Some("png"));
        assert_eq!(extension_for("IMAGE/JPEG"), Some("jpg"));
        assert_eq!(extension_for("text/plain"), None);
    }
}
