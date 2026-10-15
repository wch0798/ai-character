use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

const WORKSPACE_DIRS: &[&str] = &[
    "attachments",
    "normalized",
    "extracted",
    "outputs",
    "manifests",
    "project",
];

const PROJECT_EXCLUDES: &[&str] = &[
    ".git",
    ".ai-character",
    ".ai-character-backup",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    ".DS_Store",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BaselineEntry {
    pub size: u64,
    pub sha256: String,
    pub binary: bool,
}

pub fn validate_conversation_id(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("conversation ID가 비어 있습니다.".to_string());
    }
    if id == "." || id == ".." || id.contains("..") {
        return Err("conversation ID에 '..'를 사용할 수 없습니다.".to_string());
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("conversation ID에는 영문/숫자/-/_/.만 사용할 수 있습니다.".to_string());
    }
    Ok(())
}

pub fn ensure_conversation_workspace(
    project_root: &Path,
    conversation_id: &str,
) -> Result<PathBuf, String> {
    validate_conversation_id(conversation_id)?;
    if !project_root.is_dir() {
        return Err(format!("프로젝트 폴더가 없습니다: {}", project_root.display()));
    }

    let root = project_root
        .join(".ai-character")
        .join("conversations")
        .join(conversation_id);

    for dir in WORKSPACE_DIRS {
        fs::create_dir_all(root.join(dir)).map_err(|error| {
            format!("작업공간 생성 실패: {} ({error})", root.join(dir).display())
        })?;
    }

    Ok(root)
}

pub(crate) fn should_exclude(name: &str) -> bool {
    PROJECT_EXCLUDES.iter().any(|excluded| *excluded == name)
}

pub(crate) fn is_sensitive_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == ".env"
        || lower == "keys.env"
        || lower == ".netrc"
        || lower == "auth.json"
        || lower.ends_with(".secret")
        || (lower.starts_with(".env.")
            && !lower.ends_with(".example")
            && !lower.ends_with(".sample")
            && !lower.ends_with(".template"))
    {
        return true;
    }

    if matches!(
        lower.as_str(),
        "id_rsa"
            | "id_ed25519"
            | "id_ecdsa"
            | "id_dsa"
            | ".npmrc"
            | ".pypirc"
            | "credentials.json"
            | "service-account.json"
            | "service_account.json"
            | "secrets.json"
            | "token.json"
    ) {
        return true;
    }

    [".pem", ".key", ".p12", ".pfx", ".keystore"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
}

fn collect_sensitive_files(
    root: &Path,
    current: &Path,
    limit: usize,
    output: &mut Vec<String>,
) -> Result<(), String> {
    if output.len() >= limit || !current.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(current)
        .map_err(|error| format!("민감 파일 검사 폴더 읽기 실패: {} ({error})", current.display()))?
    {
        if output.len() >= limit {
            break;
        }
        let entry = entry.map_err(|error| format!("민감 파일 검사 항목 읽기 실패: {error}"))?;
        let name = entry.file_name();
        let display_name = name.to_string_lossy();
        if should_exclude(&display_name) {
            continue;
        }

        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!("민감 파일 검사 정보 읽기 실패: {} ({error})", path.display())
        })?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_sensitive_files(root, &path, limit, output)?;
            continue;
        }
        if !metadata.is_file() || !is_sensitive_file_name(&display_name) {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("민감 파일 상대 경로 계산 실패: {} ({error})", path.display()))?
            .to_str()
            .ok_or_else(|| format!("UTF-8이 아닌 민감 파일 경로입니다: {}", path.display()))?
            .replace('\\', "/");
        output.push(relative);
    }
    Ok(())
}

pub fn sensitive_project_files(project_root: &Path, limit: usize) -> Result<Vec<String>, String> {
    if !project_root.is_dir() {
        return Err(format!("프로젝트 폴더가 없습니다: {}", project_root.display()));
    }
    let mut output = Vec::new();
    collect_sensitive_files(project_root, project_root, limit.max(1), &mut output)?;
    output.sort();
    output.dedup();
    Ok(output)
}

pub fn write_agent_context_file(snapshot: &Path, account_summary: &str) -> Result<(), String> {
    if !snapshot.is_dir() {
        return Err(format!(
            "Agent workspace가 없습니다: {}",
            snapshot.display()
        ));
    }

    let body = format!(
        "# AI-Character workspace\n\n\
This folder is a writable copy of the project folder selected in settings. You already have permission to read and write files here.\n\n\
- New files and folders added to the selected project are imported here automatically.\n\
- Do not ask for `/add-dir`, extra folder access, or approval dialogs.\n\
- Do not read API keys, keys.env, .env, tokens, or credential files. Secrets stay in the host app and are never copied here.\n\
- Do not leave this workspace copy or request access to parent folders.\n\
- Work only in this copy and start implementing immediately.\n\n\
## Connected accounts (no secrets)\n\n\
{account_summary}\n"
    );

    fs::write(snapshot.join(".ai-character-context.md"), body).map_err(|error| {
        format!(
            "Agent workspace context 저장 실패: {} ({error})",
            snapshot.display()
        )
    })
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| {
        format!("프로젝트 스냅샷 폴더 생성 실패: {} ({error})", destination.display())
    })?;

    let entries = fs::read_dir(source)
        .map_err(|error| format!("프로젝트 폴더 읽기 실패: {} ({error})", source.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("프로젝트 항목 읽기 실패: {error}"))?;
        let name = entry.file_name();
        let display_name = name.to_string_lossy();
        if should_exclude(&display_name) {
            continue;
        }

        let source_path = entry.path();
        let metadata = fs::symlink_metadata(&source_path).map_err(|error| {
            format!("프로젝트 항목 정보 읽기 실패: {} ({error})", source_path.display())
        })?;

        if metadata.file_type().is_symlink() {
            continue;
        }

        let destination_path = destination.join(&name);
        if metadata.is_dir() {
            copy_tree(&source_path, &destination_path)?;
        } else if metadata.is_file() {
            if is_sensitive_file_name(&display_name) {
                continue;
            }
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "프로젝트 파일 복사 실패: {} -> {} ({error})",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }

    Ok(())
}

fn hex_encode(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn hex_decode(value: &str) -> Result<String, String> {
    if value.len() % 2 != 0 {
        return Err("기준선 경로 인코딩 길이가 올바르지 않습니다.".to_string());
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let text = std::str::from_utf8(pair).map_err(|error| error.to_string())?;
        let byte = u8::from_str_radix(text, 16)
            .map_err(|error| format!("기준선 경로 디코딩 실패: {error}"))?;
        bytes.push(byte);
    }
    String::from_utf8(bytes).map_err(|error| format!("기준선 경로 UTF-8 디코딩 실패: {error}"))
}

fn hash_file(path: &Path) -> Result<String, String> {
    let file = File::open(path)
        .map_err(|error| format!("기준선 파일 열기 실패: {} ({error})", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("기준선 파일 읽기 실패: {} ({error})", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn file_is_binary(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("기준선 파일 열기 실패: {} ({error})", path.display()))?;
    let mut buffer = [0_u8; 8192];
    let count = file
        .read(&mut buffer)
        .map_err(|error| format!("기준선 파일 읽기 실패: {} ({error})", path.display()))?;
    let sample = &buffer[..count];
    Ok(sample.contains(&0) || std::str::from_utf8(sample).is_err())
}

fn collect_baseline_entries(
    root: &Path,
    current: &Path,
    entries: &mut BTreeMap<String, BaselineEntry>,
) -> Result<(), String> {
    if !current.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(current)
        .map_err(|error| format!("기준선 폴더 읽기 실패: {} ({error})", current.display()))?
    {
        let entry = entry.map_err(|error| format!("기준선 항목 읽기 실패: {error}"))?;
        let name = entry.file_name();
        let display_name = name.to_string_lossy();
        if should_exclude(&display_name) {
            continue;
        }

        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("기준선 항목 정보 읽기 실패: {} ({error})", path.display()))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_baseline_entries(root, &path, entries)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("기준선 상대 경로 계산 실패: {} ({error})", path.display()))?;
        let relative = relative
            .to_str()
            .ok_or_else(|| format!("UTF-8이 아닌 경로는 기준선에 저장할 수 없습니다: {}", path.display()))?
            .replace('\\', "/");
        entries.insert(
            relative,
            BaselineEntry {
                size: metadata.len(),
                sha256: hash_file(&path)?,
                binary: file_is_binary(&path)?,
            },
        );
    }
    Ok(())
}

fn write_baseline_entries(
    manifest: &Path,
    entries: &BTreeMap<String, BaselineEntry>,
) -> Result<(), String> {
    let mut body = String::from("v1\n");
    for (path, entry) in entries {
        body.push_str(&hex_encode(path));
        body.push('\t');
        body.push_str(&entry.size.to_string());
        body.push('\t');
        body.push_str(&entry.sha256);
        body.push('\t');
        body.push_str(if entry.binary { "1" } else { "0" });
        body.push('\n');
    }

    if let Some(parent) = manifest.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("기준선 manifest 폴더 생성 실패: {} ({error})", parent.display())
        })?;
    }
    fs::write(manifest, body)
        .map_err(|error| format!("기준선 manifest 저장 실패: {} ({error})", manifest.display()))
}

fn write_baseline_manifest(source_root: &Path, manifest: &Path) -> Result<(), String> {
    let mut entries = BTreeMap::new();
    collect_baseline_entries(source_root, source_root, &mut entries)?;
    write_baseline_entries(manifest, &entries)
}

fn relative_posix(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|error| format!("상대 경로 계산 실패: {} ({error})", path.display()))?
        .to_str()
        .ok_or_else(|| format!("UTF-8이 아닌 경로입니다: {}", path.display()))
        .map(|value| value.replace('\\', "/"))
}

fn sync_new_files_into_snapshot(
    source: &Path,
    destination: &Path,
) -> Result<Vec<String>, String> {
    let mut imported = Vec::new();
    sync_new_files_inner(source, source, destination, &mut imported)?;
    Ok(imported)
}

fn sync_new_files_inner(
    root: &Path,
    current: &Path,
    destination_root: &Path,
    imported: &mut Vec<String>,
) -> Result<(), String> {
    if !current.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(current).map_err(|error| {
        format!(
            "프로젝트 폴더 동기화 읽기 실패: {} ({error})",
            current.display()
        )
    })? {
        let entry = entry.map_err(|error| format!("프로젝트 동기화 항목 읽기 실패: {error}"))?;
        let name = entry.file_name();
        let display_name = name.to_string_lossy();
        if should_exclude(&display_name) {
            continue;
        }

        let source_path = entry.path();
        let metadata = fs::symlink_metadata(&source_path).map_err(|error| {
            format!(
                "프로젝트 동기화 정보 읽기 실패: {} ({error})",
                source_path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            continue;
        }

        let relative = relative_posix(root, &source_path)?;
        let destination_path = destination_root.join(&relative);
        if metadata.is_dir() {
            fs::create_dir_all(&destination_path).map_err(|error| {
                format!(
                    "프로젝트 폴더 동기화 생성 실패: {} ({error})",
                    destination_path.display()
                )
            })?;
            sync_new_files_inner(root, &source_path, destination_root, imported)?;
            continue;
        }
        if !metadata.is_file() || is_sensitive_file_name(&display_name) {
            continue;
        }
        if destination_path.exists() {
            continue;
        }
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "프로젝트 파일 동기화 폴더 생성 실패: {} ({error})",
                    parent.display()
                )
            })?;
        }
        fs::copy(&source_path, &destination_path).map_err(|error| {
            format!(
                "프로젝트 파일 동기화 실패: {} -> {} ({error})",
                source_path.display(),
                destination_path.display()
            )
        })?;
        imported.push(relative);
    }

    Ok(())
}

fn parse_baseline_manifest(manifest: &Path) -> Result<BTreeMap<String, BaselineEntry>, String> {
    let text = fs::read_to_string(manifest)
        .map_err(|error| format!("기준선 manifest 읽기 실패: {} ({error})", manifest.display()))?;
    let mut lines = text.lines();
    if lines.next() != Some("v1") {
        return Err("지원하지 않는 프로젝트 기준선 manifest 형식입니다.".to_string());
    }

    let mut entries = BTreeMap::new();
    for (index, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() != 4 {
            return Err(format!("기준선 manifest {}행 형식이 올바르지 않습니다.", index + 2));
        }
        let path = hex_decode(parts[0])?;
        let size = parts[1]
            .parse::<u64>()
            .map_err(|error| format!("기준선 파일 크기 해석 실패: {error}"))?;
        let binary = match parts[3] {
            "0" => false,
            "1" => true,
            _ => return Err(format!("기준선 binary 값이 올바르지 않습니다: {}", parts[3])),
        };
        entries.insert(
            path,
            BaselineEntry {
                size,
                sha256: parts[2].to_string(),
                binary,
            },
        );
    }
    Ok(entries)
}

fn merge_imported_into_baseline(
    snapshot: &Path,
    manifest: &Path,
    imported: &[String],
) -> Result<(), String> {
    if imported.is_empty() || !manifest.is_file() {
        return Ok(());
    }
    let mut entries = parse_baseline_manifest(manifest)?;
    for relative in imported {
        let path = snapshot.join(relative);
        let metadata = fs::metadata(&path).map_err(|error| {
            format!("가져온 파일 정보 읽기 실패: {} ({error})", path.display())
        })?;
        entries.insert(
            relative.clone(),
            BaselineEntry {
                size: metadata.len(),
                sha256: hash_file(&path)?,
                binary: file_is_binary(&path)?,
            },
        );
    }
    write_baseline_entries(manifest, &entries)
}

fn baseline_manifest_path(project_root: &Path, conversation_id: &str) -> Result<PathBuf, String> {
    let workspace = ensure_conversation_workspace(project_root, conversation_id)?;
    Ok(workspace.join("manifests").join("project-baseline.tsv"))
}

pub fn refresh_project_baseline(
    project_root: &Path,
    conversation_id: &str,
) -> Result<PathBuf, String> {
    validate_conversation_id(conversation_id)?;
    let manifest = baseline_manifest_path(project_root, conversation_id)?;
    write_baseline_manifest(project_root, &manifest)?;
    Ok(manifest)
}

pub fn load_project_baseline(
    project_root: &Path,
    conversation_id: &str,
) -> Result<BTreeMap<String, BaselineEntry>, String> {
    ensure_project_snapshot(project_root, conversation_id)?;
    let manifest = baseline_manifest_path(project_root, conversation_id)?;
    parse_baseline_manifest(&manifest)
}

pub fn ensure_project_snapshot(
    project_root: &Path,
    conversation_id: &str,
) -> Result<PathBuf, String> {
    let workspace = ensure_conversation_workspace(project_root, conversation_id)?;
    let snapshot = workspace.join("project");
    let marker = workspace.join("manifests").join("project-snapshot.ready");
    let baseline = workspace.join("manifests").join("project-baseline.tsv");

    if marker.is_file() {
        // v12 and earlier conversations did not have a baseline manifest. Start
        // conflict tracking from the current original tree without discarding
        // any pending workspace edits.
        if !baseline.is_file() {
            refresh_project_baseline(project_root, conversation_id)?;
        }
        match sync_new_files_into_snapshot(project_root, &snapshot) {
            Ok(imported) => {
                if let Err(error) = merge_imported_into_baseline(&snapshot, &baseline, &imported) {
                    eprintln!("가져온 파일 기준선 반영 경고: {error}");
                }
            }
            Err(error) => {
                eprintln!("프로젝트 폴더 동기화 경고: {error}");
            }
        }
        let _ = write_agent_context_file(&snapshot, &crate::local_env::configured_account_summary());
        return Ok(snapshot);
    }

    if snapshot.exists() {
        fs::remove_dir_all(&snapshot).map_err(|error| {
            format!("기존 스냅샷 정리 실패: {} ({error})", snapshot.display())
        })?;
    }

    copy_tree(project_root, &snapshot)?;
    let _ = write_agent_context_file(&snapshot, &crate::local_env::configured_account_summary());
    write_baseline_manifest(&snapshot, &baseline)?;
    fs::write(&marker, project_root.to_string_lossy().as_bytes()).map_err(|error| {
        format!("스냅샷 상태 저장 실패: {} ({error})", marker.display())
    })?;

    Ok(snapshot)
}

pub fn reset_project_snapshot(
    project_root: &Path,
    conversation_id: &str,
) -> Result<PathBuf, String> {
    let workspace = ensure_conversation_workspace(project_root, conversation_id)?;
    let snapshot = workspace.join("project");
    let marker = workspace.join("manifests").join("project-snapshot.ready");
    let baseline = workspace.join("manifests").join("project-baseline.tsv");

    if snapshot.exists() {
        fs::remove_dir_all(&snapshot).map_err(|error| {
            format!("작업 스냅샷 초기화 실패: {} ({error})", snapshot.display())
        })?;
    }
    if marker.exists() {
        fs::remove_file(&marker).map_err(|error| {
            format!("스냅샷 상태 초기화 실패: {} ({error})", marker.display())
        })?;
    }
    if baseline.exists() {
        fs::remove_file(&baseline).map_err(|error| {
            format!("프로젝트 기준선 초기화 실패: {} ({error})", baseline.display())
        })?;
    }

    ensure_project_snapshot(project_root, conversation_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ai-character-workspace-{}-{}",
            name,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn app_keys_env_is_not_treated_as_project_sensitive_file() {
        let root = temp_project("keys-exclude");
        fs::create_dir_all(root.join(".ai-character")).unwrap();
        fs::write(root.join(".ai-character").join("keys.env"), "GEMINI_API_KEY=secret\n").unwrap();
        fs::write(root.join("readme.txt"), "ok\n").unwrap();

        let sensitive = sensitive_project_files(&root, 20).unwrap();
        assert!(sensitive.is_empty(), "{sensitive:?}");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_skips_secret_files_and_writes_context() {
        let root = temp_project("snapshot-secrets");
        fs::create_dir_all(root.join(".ai-character")).unwrap();
        fs::write(root.join(".ai-character").join("keys.env"), "GEMINI_API_KEY=secret\n").unwrap();
        fs::write(root.join("keys.env"), "OPENAI_API_KEY=secret\n").unwrap();
        fs::write(root.join("app.txt"), "hello\n").unwrap();

        let snapshot = ensure_project_snapshot(&root, "conv-1").unwrap();
        assert!(snapshot.join("app.txt").is_file());
        assert!(!snapshot.join("keys.env").exists());
        assert!(!snapshot.join(".ai-character").exists());
        let context = fs::read_to_string(snapshot.join(".ai-character-context.md")).unwrap();
        assert!(context.contains("already have permission"));
        assert!(!context.contains("GEMINI_API_KEY=secret"));
        assert!(!context.contains("OPENAI_API_KEY=secret"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn later_new_folders_are_imported_without_clobbering_edits() {
        let root = temp_project("sync-new-folder");
        fs::write(root.join("a.txt"), "a\n").unwrap();
        let snapshot = ensure_project_snapshot(&root, "conv-2").unwrap();
        fs::write(snapshot.join("a.txt"), "edited\n").unwrap();

        fs::create_dir_all(root.join("new-app")).unwrap();
        fs::write(root.join("new-app").join("index.html"), "<h1>ok</h1>\n").unwrap();
        fs::write(root.join("keys.env"), "OPENAI_API_KEY=secret\n").unwrap();
        fs::write(root.join("a.txt"), "original-changed\n").unwrap();

        let snapshot2 = ensure_project_snapshot(&root, "conv-2").unwrap();
        assert_eq!(
            fs::read_to_string(snapshot2.join("new-app").join("index.html")).unwrap(),
            "<h1>ok</h1>\n"
        );
        assert_eq!(fs::read_to_string(snapshot2.join("a.txt")).unwrap(), "edited\n");
        assert!(!snapshot2.join("keys.env").exists());

        let _ = fs::remove_dir_all(root);
    }
}
