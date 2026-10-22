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

#[tauri::command]
pub fn save_pasted_image(bytes: Vec<u8>, mime: String) -> Result<String, String> {
    let extension = extension_for(&mime).ok_or_else(|| "붙여넣은 내용이 그림 파일 형식이 아닙니다.".to_string())?;
    if bytes.is_empty() {
        return Err("붙여넣은 그림이 비어 있습니다.".to_string());
    }
    if bytes.len() > MAX_BYTES {
        return Err("붙여넣은 그림이 너무 큽니다 (25MB까지).".to_string());
    }
    let dir = std::env::temp_dir().join("ai-character-paste");
    std::fs::create_dir_all(&dir).map_err(|error| format!("임시 폴더를 만들지 못했습니다: {error}"))?;
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
