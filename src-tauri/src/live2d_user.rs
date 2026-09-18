use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::copy;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;
use zip::ZipArchive;

const USER_MODELS_DIR: &str = "live2d-models";
const META_FILE: &str = ".ai-character.json";
const MAX_ZIP_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB

/// 알려진 표시 이름 ↔ ASCII 폴더 (기존 모델 마이그레이션용)
const KNOWN_DISPLAY_BY_FOLDER: &[(&str, &str)] = &[
    ("witch", "魔女"),
    ("moose", "ムースちゃん"),
    ("Mus", "ムースちゃん"),
    ("IceGIrl-Live2D", "Ice Girl"),
    ("ice-girl", "Ice Girl"),
    ("toki20220227", "toki"),
    ("usahime", "兎姫"),
];

const KNOWN_FOLDER_BY_DISPLAY: &[(&str, &str)] = &[
    ("魔女", "witch"),
    ("ムースちゃん", "moose"),
    ("ムース", "moose"),
    ("兎姫", "usahime"),
    ("Ice Girl", "ice-girl"),
    ("IceGirl", "ice-girl"),
];

fn app_support_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("App Support 경로 실패: {error}"))
}

pub fn user_live2d_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let root = app_support_dir(app)?.join(USER_MODELS_DIR);
    fs::create_dir_all(&root).map_err(|error| {
        format!("사용자 Live2D 폴더 생성 실패: {error}")
    })?;
    Ok(root)
}

fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else if ch.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').trim_matches('_');
    if trimmed.is_empty() {
        "model".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| format!("폴더 생성 실패: {error}"))?;
    for entry in fs::read_dir(src).map_err(|error| format!("폴더 읽기 실패: {error}"))? {
        let entry = entry.map_err(|error| format!("항목 읽기 실패: {error}"))?;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" || name_str == "__MACOSX" || name_str.starts_with('.') {
            continue;
        }
        let target = dest.join(&name);
        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else {
            fs::copy(&path, &target).map_err(|error| {
                format!("파일 복사 실패 ({}): {error}", path.display())
            })?;
        }
    }
    Ok(())
}

fn is_archive_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            lower == "zip" || lower == "rar" || lower == "7z"
        })
        .unwrap_or(false)
}

fn extract_with_bsdtar(archive_path: &Path, dest_root: &Path) -> Result<(), String> {
    let status = Command::new("bsdtar")
        .arg("-xf")
        .arg(archive_path)
        .arg("-C")
        .arg(dest_root)
        .status()
        .map_err(|error| format!("압축 해제 도구(bsdtar) 실행 실패: {error}"))?;
    if !status.success() {
        return Err(format!(
            "압축 해제 실패 (종료 코드: {:?})",
            status.code()
        ));
    }
    Ok(())
}

fn extract_zip_rust(zip_path: &Path, dest_root: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|error| format!("ZIP 열기 실패: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("ZIP 파싱 실패: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("ZIP 항목 읽기 실패: {error}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        if enclosed.components().any(|c| matches!(c, Component::ParentDir)) {
            continue;
        }
        let name = enclosed.to_string_lossy();
        if name.contains("__MACOSX") || name.split('/').any(|part| part.starts_with('.')) {
            continue;
        }

        let out_path = dest_root.join(enclosed.as_path());
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|error| {
                format!("ZIP 폴더 생성 실패: {error}")
            })?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("ZIP 폴더 생성 실패: {error}")
            })?;
        }
        let mut out = fs::File::create(&out_path).map_err(|error| {
            format!("ZIP 파일 쓰기 실패: {error}")
        })?;
        copy(&mut entry, &mut out).map_err(|error| format!("ZIP 해제 실패: {error}"))?;
    }
    Ok(())
}

fn extract_archive_to_temp(archive_path: &Path) -> Result<tempfile::TempDir, String> {
    let meta =
        fs::metadata(archive_path).map_err(|error| format!("압축 파일 읽기 실패: {error}"))?;
    if meta.len() > MAX_ZIP_BYTES {
        return Err("압축 파일이 너무 큽니다 (최대 512MB).".to_string());
    }

    let temp = tempfile::tempdir().map_err(|error| format!("임시 폴더 생성 실패: {error}"))?;
    let dest_root = temp.path();

    // macOS bsdtar: Shift-JIS ZIP / RAR 파일명 깨짐 방지
    match extract_with_bsdtar(archive_path, dest_root) {
        Ok(()) => {
            scrub_escaped_extracts(dest_root)?;
            Ok(temp)
        }
        Err(bsdtar_error) => {
            if is_zip_path(archive_path) {
                extract_zip_rust(archive_path, dest_root).map_err(|zip_error| {
                    format!("{bsdtar_error} / ZIP 폴백도 실패: {zip_error}")
                })?;
                scrub_escaped_extracts(dest_root)?;
                Ok(temp)
            } else {
                Err(format!(
                    "{bsdtar_error}. RAR/7z은 bsdtar가 필요합니다."
                ))
            }
        }
    }
}

fn scrub_escaped_extracts(dest_root: &Path) -> Result<(), String> {
    let root = dest_root
        .canonicalize()
        .map_err(|error| format!("압축 폴더 확인 실패: {error}"))?;
    fn walk(dir: &Path, root: &Path) -> Result<bool, String> {
        let mut escaped = false;
        let entries = match fs::read_dir(dir) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        for entry in entries {
            let entry = entry.map_err(|error| format!("압축 검사 실패: {error}"))?;
            let path = entry.path();
            match path.canonicalize() {
                Ok(canonical) if crate::path_guard::is_path_within(root, &canonical) => {
                    if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                        escaped = walk(&path, root)? || escaped;
                    }
                }
                _ => {
                    escaped = true;
                    if path.is_dir() {
                        let _ = fs::remove_dir_all(&path);
                    } else {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
        Ok(escaped)
    }
    if walk(dest_root, &root)? {
        return Err("압축 파일이 폴더 밖으로 풀리려 해서 가져오기를 중단했습니다.".to_string());
    }
    Ok(())
}

fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
}

fn find_model3_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut found = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|error| format!("탐색 실패: {error}"))? {
            let entry = entry.map_err(|error| format!("탐색 실패: {error}"))?;
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == ".git" || name == "__MACOSX" {
                    continue;
                }
                walk(&path, out)?;
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with(".model3.json"))
                .unwrap_or(false)
            {
                out.push(path);
            }
        }
        Ok(())
    }
    walk(root, &mut found)?;
    Ok(found)
}

#[derive(Debug, Clone, Serialize)]
pub struct UserLive2DModel {
    pub id: String,
    pub name: String,
    pub gender: String,
    pub source: String,
    pub model: String,
    pub folder: String,
    pub motions: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelMeta {
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(default)]
    fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status")]
pub enum ImportOutcome {
    #[serde(rename = "ok")]
    Ok { model: UserLive2DModel },
    #[serde(rename = "conflict")]
    Conflict {
        existing: UserLive2DModel,
        #[serde(rename = "proposedName")]
        proposed_name: String,
        fingerprint: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct DedupeResult {
    pub removed: Vec<String>,
    pub kept: usize,
}

fn meta_path(folder_dir: &Path) -> PathBuf {
    folder_dir.join(META_FILE)
}

fn read_meta(folder_dir: &Path) -> Option<ModelMeta> {
    let path = meta_path(folder_dir);
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_meta(folder_dir: &Path, meta: &ModelMeta) -> Result<(), String> {
    let path = meta_path(folder_dir);
    let text = serde_json::to_string_pretty(meta)
        .map_err(|error| format!("meta 직렬화 실패: {error}"))?;
    fs::write(&path, text).map_err(|error| format!("meta 저장 실패: {error}"))?;
    Ok(())
}

fn looks_temp_name(name: &str) -> bool {
    name.starts_with("tmp")
        || name.starts_with('.')
        || name.eq_ignore_ascii_case("model")
        || name.eq_ignore_ascii_case("__MACOSX")
}

fn known_display_for_folder(folder: &str) -> Option<&'static str> {
    KNOWN_DISPLAY_BY_FOLDER
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(folder))
        .map(|(_, name)| *name)
}

fn known_folder_for_display(display: &str) -> Option<&'static str> {
    for (name, slug) in KNOWN_FOLDER_BY_DISPLAY {
        if display == *name || display.contains(name) {
            return Some(*slug);
        }
    }
    None
}

fn preferred_display_name(suggested: &str, stem: &str) -> String {
    if !looks_temp_name(suggested) && suggested.chars().any(|ch| !ch.is_ascii()) {
        return suggested.to_string();
    }
    if !stem.eq_ignore_ascii_case("model") && stem.chars().any(|ch| !ch.is_ascii()) {
        return stem.to_string();
    }
    if !stem.eq_ignore_ascii_case("model") && !looks_temp_name(stem) {
        return stem.to_string();
    }
    if !looks_temp_name(suggested) {
        return suggested.to_string();
    }
    stem.to_string()
}

fn preferred_folder_slug(
    display: &str,
    suggested: &str,
    archive_stem: Option<&str>,
) -> String {
    if let Some(slug) = known_folder_for_display(display) {
        return slug.to_string();
    }
    if let Some(stem) = archive_stem {
        let cleaned = sanitize_folder_name(stem);
        if cleaned != "model" && !cleaned.starts_with("tmp") {
            return cleaned;
        }
    }
    if !looks_temp_name(suggested) {
        let cleaned = sanitize_folder_name(suggested);
        if cleaned != "model" && !cleaned.starts_with("tmp") {
            return cleaned;
        }
    }
    let from_display = sanitize_folder_name(display);
    if from_display != "model" && !from_display.starts_with("tmp") {
        return from_display;
    }
    let mut hasher = Sha256::new();
    hasher.update(display.as_bytes());
    let digest = hasher.finalize();
    format!("model-{:x}", digest.iter().take(4).fold(0u32, |acc, b| (acc << 8) | u32::from(*b)))
}

fn fingerprint_model_dir(model_dir: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut moc_files: Vec<PathBuf> = Vec::new();
    let mut model3_files: Vec<PathBuf> = Vec::new();
    for path in walkdir_files(model_dir)? {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name.ends_with(".moc3") {
            moc_files.push(path);
        } else if name.ends_with(".model3.json") {
            model3_files.push(path);
        }
    }
    moc_files.sort();
    model3_files.sort_by_key(|p| p.components().count());
    if let Some(moc) = moc_files.first() {
        let bytes = fs::read(moc).map_err(|error| format!("moc3 읽기 실패: {error}"))?;
        hasher.update(&bytes);
    } else if let Some(model3) = model3_files.first() {
        let bytes = fs::read(model3).map_err(|error| format!("model3 읽기 실패: {error}"))?;
        hasher.update(&bytes);
    } else {
        return Err("지문 계산용 moc3/model3 없음".to_string());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn pick_shallowest_model3(files: &[PathBuf]) -> Option<&PathBuf> {
    files.iter().min_by_key(|p| p.components().count())
}

fn model_entry_from_folder(root: &Path, folder_dir: &Path) -> Result<Option<UserLive2DModel>, String> {
    let folder = folder_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    if folder.is_empty() || folder.starts_with('.') {
        return Ok(None);
    }
    let model3_files = find_model3_files(folder_dir)?;
    let Some(model3) = pick_shallowest_model3(&model3_files) else {
        return Ok(None);
    };
    let rel = model3
        .strip_prefix(root)
        .map_err(|_| "상대 경로 계산 실패".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let stem = model3
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&folder)
        .trim_end_matches(".model3")
        .to_string();

    let mut meta = read_meta(folder_dir);
    if meta.as_ref().map(|m| m.display_name.is_empty()).unwrap_or(true) {
        let inferred = known_display_for_folder(&folder)
            .map(str::to_string)
            .unwrap_or_else(|| {
                if stem.eq_ignore_ascii_case("model") {
                    folder.clone()
                } else {
                    stem.clone()
                }
            });
        let fingerprint = meta
            .as_ref()
            .map(|m| m.fingerprint.clone())
            .filter(|fp| !fp.is_empty())
            .or_else(|| fingerprint_model_dir(folder_dir).ok())
            .unwrap_or_default();
        let fresh = ModelMeta {
            display_name: inferred,
            fingerprint,
        };
        let _ = write_meta(folder_dir, &fresh);
        meta = Some(fresh);
    } else if meta
        .as_ref()
        .map(|m| m.fingerprint.is_empty())
        .unwrap_or(false)
    {
        if let Ok(fp) = fingerprint_model_dir(folder_dir) {
            if let Some(m) = meta.as_mut() {
                m.fingerprint = fp;
                let _ = write_meta(folder_dir, m);
            }
        }
    }

    let name = meta
        .as_ref()
        .map(|m| m.display_name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| {
            if stem.eq_ignore_ascii_case("model") {
                folder.clone()
            } else {
                stem
            }
        });

    Ok(Some(UserLive2DModel {
        id: format!("user-{folder}"),
        name,
        gender: "female".to_string(),
        source: "user".to_string(),
        model: format!("/live2d/user/{rel}"),
        folder,
        motions: motions_from_model3(model3),
    }))
}

fn find_existing_by_fingerprint(
    root: &Path,
    fingerprint: &str,
) -> Result<Option<UserLive2DModel>, String> {
    if fingerprint.is_empty() {
        return Ok(None);
    }
    for entry in fs::read_dir(root).map_err(|error| format!("목록 읽기 실패: {error}"))? {
        let entry = entry.map_err(|error| format!("목록 읽기 실패: {error}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_fp = read_meta(&path)
            .map(|m| m.fingerprint)
            .filter(|fp| !fp.is_empty())
            .or_else(|| fingerprint_model_dir(&path).ok());
        if meta_fp.as_deref() == Some(fingerprint) {
            return model_entry_from_folder(root, &path);
        }
    }
    Ok(None)
}

fn motions_from_model3(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    if let Ok(text) = fs::read_to_string(path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(motions) = value
                .pointer("/FileReferences/Motions")
                .and_then(|v| v.as_object())
            {
                for (group, items) in motions {
                    let key = if group.is_empty() {
                        "Idle".to_string()
                    } else {
                        group.clone()
                    };
                    let count = items.as_array().map(|a| a.len()).unwrap_or(1);
                    map.insert(key, serde_json::json!(count.max(1)));
                }
            }
        }
    }

    if let Some(dir) = path.parent() {
        let motions_dir = dir.join("motions");
        if motions_dir.is_dir() {
            let mut counts: HashMap<String, usize> = HashMap::new();
            if let Ok(files) = walkdir_files(&motions_dir) {
                for file in files {
                    let name = file
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if !name.ends_with(".motion3.json") {
                        continue;
                    }
                    let group = file
                        .parent()
                        .and_then(|parent| {
                            if parent == motions_dir {
                                None
                            } else {
                                parent.file_name().and_then(|n| n.to_str()).map(str::to_string)
                            }
                        })
                        .filter(|g| !g.is_empty())
                        .unwrap_or_else(|| {
                            let stem = file
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("Idle")
                                .trim_end_matches(".motion3");
                            let prefix = stem.split(['_', '-']).next().unwrap_or(stem);
                            if prefix.is_empty() {
                                "Idle".to_string()
                            } else {
                                // idle01 -> Idle
                                let lower = prefix.to_ascii_lowercase();
                                if lower.starts_with("idle") {
                                    "Idle".to_string()
                                } else if lower.starts_with("tap") {
                                    "Tap".to_string()
                                } else {
                                    let mut chars = prefix.chars();
                                    match chars.next() {
                                        Some(first) => {
                                            first.to_uppercase().collect::<String>()
                                                + chars.as_str()
                                        }
                                        None => "Idle".to_string(),
                                    }
                                }
                            }
                        });
                    *counts.entry(group).or_insert(0) += 1;
                }
            }
            for (group, count) in counts {
                let existing = map
                    .get(&group)
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                if count > existing {
                    map.insert(group, serde_json::json!(count));
                }
            }
        }
    }

    if map.is_empty() {
        map.insert("Idle".into(), serde_json::json!(1));
    }
    map
}

fn platform_app_support_dir(app_name: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or_else(|| "HOME 없음".to_string())?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(app_name));
    }
    #[cfg(windows)]
    {
        let appdata = std::env::var_os("APPDATA").ok_or_else(|| "APPDATA 없음".to_string())?;
        return Ok(PathBuf::from(appdata).join(app_name));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(config).join(app_name));
        }
        let home = std::env::var_os("HOME").ok_or_else(|| "HOME 없음".to_string())?;
        Ok(PathBuf::from(home).join(".config").join(app_name))
    }
}

#[tauri::command]
pub fn read_force_live2d_model() -> Result<Option<String>, String> {
    let path = platform_app_support_dir("local.ai.character")?.join("force-model.txt");
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|error| format!("force-model 읽기 실패: {error}"))?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

#[tauri::command]
pub fn clear_force_live2d_model() -> Result<(), String> {
    let path = platform_app_support_dir("local.ai.character")?.join("force-model.txt");
    if path.is_file() {
        fs::remove_file(&path).map_err(|error| format!("force-model 삭제 실패: {error}"))?;
    }
    Ok(())
}

const MAX_DEBUG_LOG_BYTES: u64 = 1_048_576;
const MAX_DEBUG_LOG_MESSAGE: usize = 2048;

fn sanitize_debug_message(message: &str) -> String {
    let mut out: String = message
        .chars()
        .filter(|ch| *ch == '\t' || !ch.is_control())
        .take(MAX_DEBUG_LOG_MESSAGE)
        .collect();
    for pat in ["sk-", "AIza", "Bearer ", "ghp_", "xox", "keys.env="] {
        if let Some(idx) = out.find(pat) {
            out.replace_range(idx.., "[redacted]");
            break;
        }
    }
    out
}

#[tauri::command]
pub fn append_debug_log(message: String) -> Result<(), String> {
    let dir = platform_app_support_dir("local.ai.character")?;
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("live2d-load.log");
    if path.is_file() {
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > MAX_DEBUG_LOG_BYTES {
                let _ = fs::write(&path, b"[log truncated]\n");
            }
        }
    }
    let clean = sanitize_debug_message(&message);
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("로그 열기 실패: {error}"))?;
    let _ = writeln!(file, "{clean}");
    Ok(())
}

#[tauri::command]
pub fn resolve_live2d_abs_path<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<String, String> {
    let file = resolve_any_live2d_file(&app, &path)?;
    Ok(file.display().to_string())
}

#[tauri::command]
pub fn get_user_live2d_dir<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    Ok(user_live2d_root(&app)?.display().to_string())
}

#[tauri::command]
pub fn open_user_live2d_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let root = user_live2d_root(&app)?;
    app.opener()
        .open_path(root.display().to_string(), None::<String>)
        .map_err(|error| format!("폴더 열기 실패: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_user_live2d_models<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<UserLive2DModel>, String> {
    let root = user_live2d_root(&app)?;
    let mut models = Vec::new();

    for entry in fs::read_dir(&root).map_err(|error| format!("목록 읽기 실패: {error}"))? {
        let entry = entry.map_err(|error| format!("목록 읽기 실패: {error}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(model) = model_entry_from_folder(&root, &path)? {
            models.push(model);
        }
    }

    models.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(models)
}

fn path_has_non_ascii(path: &Path) -> bool {
    path.to_string_lossy().chars().any(|ch| !ch.is_ascii())
}

fn ascii_ext(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "bin".to_string())
}

/// 일본어/비ASCII 파일명을 ASCII로 바꾸고 model3.json 참조를 고칩니다.
fn normalize_model_dir_ascii(dest: &Path, model3: &Path) -> Result<PathBuf, String> {
    if !path_has_non_ascii(dest) && !path_has_non_ascii(model3) {
        // 내부 파일만 검사
        let mut any = false;
        for entry in walkdir_files(dest)? {
            if path_has_non_ascii(&entry) {
                any = true;
                break;
            }
        }
        if !any {
            return Ok(model3.to_path_buf());
        }
    }

    let text = fs::read_to_string(model3).map_err(|e| format!("model3 읽기 실패: {e}"))?;
    let mut value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("model3 JSON 실패: {e}"))?;

    let staging = dest.join("__ascii_staging");
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| format!("staging 정리 실패: {e}"))?;
    }
    fs::create_dir_all(&staging).map_err(|e| format!("staging 생성 실패: {e}"))?;

    let mut renamed: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut tex_index = 0u32;
    let mut misc_index = 0u32;

    let rewrite_rel = |rel: &str,
                       renamed: &mut std::collections::HashMap<String, String>,
                       staging: &Path,
                       dest: &Path,
                       model3: &Path,
                       tex_index: &mut u32,
                       misc_index: &mut u32|
     -> Result<String, String> {
        let normalized = rel.replace('\\', "/");
        if let Some(existing) = renamed.get(&normalized) {
            return Ok(existing.clone());
        }
        let src = model3
            .parent()
            .unwrap_or(dest)
            .join(normalized.split('/').collect::<PathBuf>());
        if !src.is_file() {
            // keep original if missing
            return Ok(normalized);
        }
        let lower = normalized.to_ascii_lowercase();
        let new_rel = if lower.ends_with(".moc3") {
            "model.moc3".to_string()
        } else if lower.ends_with(".physics3.json") {
            "model.physics3.json".to_string()
        } else if lower.ends_with(".pose3.json") {
            "model.pose3.json".to_string()
        } else if lower.ends_with(".cdi3.json") {
            "model.cdi3.json".to_string()
        } else if lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
            *tex_index += 1;
            format!("textures/texture_{:02}.{}", *tex_index - 1, ascii_ext(&src))
        } else if lower.ends_with(".motion3.json") {
            *misc_index += 1;
            format!("motions/motion_{:02}.motion3.json", *misc_index)
        } else if lower.ends_with(".exp3.json") {
            *misc_index += 1;
            format!("expressions/exp_{:02}.exp3.json", *misc_index)
        } else {
            *misc_index += 1;
            format!("extra/file_{:02}.{}", *misc_index, ascii_ext(&src))
        };

        let out = staging.join(PathBuf::from(&new_rel));
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("폴더 생성 실패: {e}"))?;
        }
        fs::copy(&src, &out).map_err(|e| format!("ASCII 복사 실패 ({}): {e}", src.display()))?;
        renamed.insert(normalized, new_rel.clone());
        Ok(new_rel)
    };

    if let Some(refs) = value.get_mut("FileReferences").and_then(|v| v.as_object_mut()) {
        for key in ["Moc", "Physics", "Pose", "DisplayInfo"] {
            if let Some(serde_json::Value::String(path)) = refs.get(key).cloned() {
                let next = rewrite_rel(
                    &path,
                    &mut renamed,
                    &staging,
                    dest,
                    model3,
                    &mut tex_index,
                    &mut misc_index,
                )?;
                refs.insert(key.to_string(), serde_json::Value::String(next));
            }
        }
        if let Some(serde_json::Value::Array(textures)) = refs.get_mut("Textures") {
            for item in textures.iter_mut() {
                if let serde_json::Value::String(path) = item {
                    *path = rewrite_rel(
                        path,
                        &mut renamed,
                        &staging,
                        dest,
                        model3,
                        &mut tex_index,
                        &mut misc_index,
                    )?;
                }
            }
        }
        if let Some(serde_json::Value::Array(expressions)) = refs.get_mut("Expressions") {
            for item in expressions.iter_mut() {
                if let Some(obj) = item.as_object_mut() {
                    if let Some(serde_json::Value::String(path)) = obj.get("File").cloned() {
                        let next = rewrite_rel(
                            &path,
                            &mut renamed,
                            &staging,
                            dest,
                            model3,
                            &mut tex_index,
                            &mut misc_index,
                        )?;
                        obj.insert("File".into(), serde_json::Value::String(next));
                    }
                }
            }
        }
        if let Some(serde_json::Value::Object(motions)) = refs.get_mut("Motions") {
            for (_group, items) in motions.iter_mut() {
                if let serde_json::Value::Array(arr) = items {
                    for item in arr.iter_mut() {
                        if let Some(obj) = item.as_object_mut() {
                            for key in ["File", "Sound"] {
                                if let Some(serde_json::Value::String(path)) = obj.get(key).cloned()
                                {
                                    let next = rewrite_rel(
                                        &path,
                                        &mut renamed,
                                        &staging,
                                        dest,
                                        model3,
                                        &mut tex_index,
                                        &mut misc_index,
                                    )?;
                                    obj.insert(key.into(), serde_json::Value::String(next));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let new_model3 = staging.join("model.model3.json");
    fs::write(
        &new_model3,
        serde_json::to_string_pretty(&value).map_err(|e| format!("model3 직렬화 실패: {e}"))?,
    )
    .map_err(|e| format!("model3 쓰기 실패: {e}"))?;

    // Replace dest contents with staging
    for entry in fs::read_dir(dest).map_err(|e| format!("dest 읽기 실패: {e}"))? {
        let entry = entry.map_err(|e| format!("dest 읽기 실패: {e}"))?;
        let path = entry.path();
        if path.file_name().and_then(|n| n.to_str()) == Some("__ascii_staging") {
            continue;
        }
        if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| format!("정리 실패: {e}"))?;
        } else {
            fs::remove_file(&path).map_err(|e| format!("정리 실패: {e}"))?;
        }
    }
    for entry in fs::read_dir(&staging).map_err(|e| format!("staging 읽기 실패: {e}"))? {
        let entry = entry.map_err(|e| format!("staging 읽기 실패: {e}"))?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        fs::rename(&from, &to).map_err(|e| format!("staging 이동 실패: {e}"))?;
    }
    let _ = fs::remove_dir_all(&staging);

    Ok(dest.join("model.model3.json"))
}

fn walkdir_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| format!("탐색 실패: {e}"))? {
            let entry = entry.map_err(|e| format!("탐색 실패: {e}"))?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out)?;
            } else {
                out.push(path);
            }
        }
        Ok(())
    }
    walk(root, &mut out)?;
    Ok(out)
}

fn import_from_search_root<R: Runtime>(
    app: &AppHandle<R>,
    search_root: &Path,
    empty_message: &str,
    archive_stem: Option<&str>,
    mode: &str,
) -> Result<ImportOutcome, String> {
    let model3_files = find_model3_files(search_root)?;
    if model3_files.is_empty() {
        return Err(empty_message.to_string());
    }

    let mut ranked = model3_files;
    ranked.sort_by_key(|p| p.components().count());
    let model3 = &ranked[0];
    let model_dir = model3
        .parent()
        .ok_or_else(|| "모델 디렉터리를 찾을 수 없습니다.".to_string())?;

    let suggested = model_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("model");
    let stem = model3
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(suggested)
        .trim_end_matches(".model3")
        .to_string();
    let display_name = preferred_display_name(suggested, &stem);
    let fingerprint = fingerprint_model_dir(model_dir)?;
    let root = user_live2d_root(app)?;

    if let Some(existing) = find_existing_by_fingerprint(&root, &fingerprint)? {
        if mode == "skip" {
            return Ok(ImportOutcome::Ok { model: existing });
        }
        if mode != "overwrite" && mode != "copy" {
            return Ok(ImportOutcome::Conflict {
                existing,
                proposed_name: display_name,
                fingerprint,
            });
        }
        if mode == "overwrite" {
            let target = root.join(&existing.folder);
            if target.exists() {
                fs::remove_dir_all(&target)
                    .map_err(|error| format!("기존 모델 삭제 실패: {error}"))?;
            }
            return finish_import(
                &root,
                model_dir,
                model3,
                &existing.folder,
                &display_name,
                &fingerprint,
            );
        }
        // mode == copy: fall through and create -2 folder
    }

    let mut folder = preferred_folder_slug(&display_name, suggested, archive_stem);
    let mut dest = root.join(&folder);
    if mode != "overwrite" {
        let base = folder.clone();
        let mut suffix = 2u32;
        while dest.exists() {
            folder = format!("{base}-{suffix}");
            dest = root.join(&folder);
            suffix += 1;
        }
    } else if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|error| format!("기존 모델 삭제 실패: {error}"))?;
    }

    finish_import(
        &root,
        model_dir,
        model3,
        &folder,
        &display_name,
        &fingerprint,
    )
}

fn finish_import(
    root: &Path,
    model_dir: &Path,
    model3: &Path,
    folder: &str,
    display_name: &str,
    fingerprint: &str,
) -> Result<ImportOutcome, String> {
    let dest = root.join(folder);
    copy_dir_recursive(model_dir, &dest)?;

    let imported_model3 = dest.join(
        model3
            .file_name()
            .ok_or_else(|| "모델 파일 이름 오류".to_string())?,
    );
    if !imported_model3.is_file() {
        return Err("복사 후 모델 파일을 찾지 못했습니다.".to_string());
    }

    let normalized_model3 = normalize_model_dir_ascii(&dest, &imported_model3)?;
    write_meta(
        &dest,
        &ModelMeta {
            display_name: display_name.to_string(),
            fingerprint: fingerprint.to_string(),
        },
    )?;

    let rel = normalized_model3
        .strip_prefix(root)
        .map_err(|_| "상대 경로 계산 실패".to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(ImportOutcome::Ok {
        model: UserLive2DModel {
            id: format!("user-{folder}"),
            name: display_name.to_string(),
            gender: "female".to_string(),
            source: "user".to_string(),
            model: format!("/live2d/user/{rel}"),
            folder: folder.to_string(),
            motions: motions_from_model3(&normalized_model3),
        },
    })
}

#[tauri::command]
pub fn import_user_live2d_model<R: Runtime>(
    app: AppHandle<R>,
    source_path: String,
    mode: Option<String>,
) -> Result<ImportOutcome, String> {
    let mode = mode.unwrap_or_else(|| "ask".to_string());
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err("선택한 경로가 없습니다.".to_string());
    }

    if source.is_file() && is_archive_path(&source) {
        let archive_stem = source
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());
        let extracted = extract_archive_to_temp(&source)?;
        return import_from_search_root(
            &app,
            extracted.path(),
            "압축 파일 안에 .model3.json 이 없습니다. Live2D 모델 ZIP/RAR인지 확인하세요.",
            archive_stem.as_deref(),
            &mode,
        );
    }

    let search_root = if source.is_file() {
        source
            .parent()
            .ok_or_else(|| "모델 폴더를 찾을 수 없습니다.".to_string())?
            .to_path_buf()
    } else {
        source.clone()
    };
    let folder_stem = search_root
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    import_from_search_root(
        &app,
        &search_root,
        "선택한 폴더에 .model3.json 이 없습니다. nizima/Booth에서 받은 runtime 폴더를 선택하세요.",
        folder_stem.as_deref(),
        &mode,
    )
}

#[tauri::command]
pub fn dedupe_user_live2d_models<R: Runtime>(
    app: AppHandle<R>,
) -> Result<DedupeResult, String> {
    let root = user_live2d_root(&app)?;
    let mut by_fp: HashMap<String, Vec<PathBuf>> = HashMap::new();

    for entry in fs::read_dir(&root).map_err(|error| format!("목록 읽기 실패: {error}"))? {
        let entry = entry.map_err(|error| format!("목록 읽기 실패: {error}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let model3_files = find_model3_files(&path)?;
        if pick_shallowest_model3(&model3_files).is_none() {
            continue;
        }
        let fp = read_meta(&path)
            .map(|m| m.fingerprint)
            .filter(|f| !f.is_empty())
            .or_else(|| fingerprint_model_dir(&path).ok())
            .unwrap_or_else(|| format!("unique:{}", path.display()));
        by_fp.entry(fp).or_default().push(path);
    }

    let mut removed = Vec::new();
    let mut kept = 0usize;
    for (_fp, mut folders) in by_fp {
        if folders.len() <= 1 {
            kept += folders.len();
            continue;
        }
        folders.sort_by(|a, b| {
            let a_name = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let b_name = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let a_suffix = a_name.contains('-')
                && a_name
                    .rsplit('-')
                    .next()
                    .map(|s| s.chars().all(|c| c.is_ascii_digit()))
                    .unwrap_or(false);
            let b_suffix = b_name.contains('-')
                && b_name
                    .rsplit('-')
                    .next()
                    .map(|s| s.chars().all(|c| c.is_ascii_digit()))
                    .unwrap_or(false);
            match (a_suffix, b_suffix) {
                (false, true) => std::cmp::Ordering::Less,
                (true, false) => std::cmp::Ordering::Greater,
                _ => a_name.cmp(b_name),
            }
        });
        let mut iter = folders.into_iter();
        if let Some(keep) = iter.next() {
            kept += 1;
            let _ = keep;
        }
        for dup in iter {
            let name = dup
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_string();
            fs::remove_dir_all(&dup).map_err(|error| format!("중복 삭제 실패 ({name}): {error}"))?;
            removed.push(name);
        }
    }

    Ok(DedupeResult { removed, kept })
}

#[tauri::command]
pub fn remove_user_live2d_model<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
) -> Result<(), String> {
    let folder = folder.trim().trim_matches(['/', '\\']);
    if folder.is_empty()
        || folder.contains("..")
        || folder.contains('/')
        || folder.contains('\\')
    {
        return Err("잘못된 폴더 이름입니다.".to_string());
    }
    let root = user_live2d_root(&app)?;
    let target = root.join(folder);
    if !target.exists() {
        return Err(format!("모델 폴더 없음: {folder}"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize 실패: {error}"))?;
    let canonical = target
        .canonicalize()
        .map_err(|error| format!("모델 폴더 없음: {error}"))?;
    if !canonical.starts_with(&canonical_root) || canonical == canonical_root {
        return Err("삭제할 수 없는 경로입니다.".to_string());
    }
    fs::remove_dir_all(&canonical).map_err(|error| format!("삭제 실패: {error}"))?;
    Ok(())
}

/// Resolve a Live2D file from bundled resources OR user App Support models.
pub fn resolve_any_live2d_file<R: Runtime>(
    app: &AppHandle<R>,
    relative: &str,
) -> Result<PathBuf, String> {
    let decoded = percent_decode_path(relative.trim());
    let trimmed = decoded.trim_start_matches('/');
    let normalized = trimmed
        .strip_prefix("live2d/")
        .unwrap_or(trimmed);

    if let Some(user_rel) = normalized.strip_prefix("user/") {
        if user_rel.is_empty() || user_rel.split('/').any(|p| p == "..") {
            return Err("잘못된 사용자 Live2D 경로".to_string());
        }
        let root = user_live2d_root(app)?;
        let absolute = root.join(user_rel);
        let canonical_root = root
            .canonicalize()
            .map_err(|error| format!("user Live2D root 실패: {error}"))?;
        let canonical = absolute.canonicalize().map_err(|error| {
            format!("사용자 Live2D 파일 없음: {} ({error})", absolute.display())
        })?;
        if !canonical.starts_with(&canonical_root) {
            return Err("사용자 Live2D 폴더 밖 경로".to_string());
        }
        if !canonical.is_file() {
            return Err(format!("파일이 아닙니다: {}", canonical.display()));
        }
        return Ok(canonical);
    }

    crate::live2d_resources::resolve_bundled_live2d_file(app, relative)
}

fn percent_decode_path(input: &str) -> String {
    if !input.as_bytes().contains(&b'%') {
        return input.to_string();
    }
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            let hex = &input[i + 1..i + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
