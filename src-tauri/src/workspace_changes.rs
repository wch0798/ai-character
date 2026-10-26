use crate::workspace::{
    ensure_project_snapshot, load_project_baseline, reset_project_snapshot,
    validate_conversation_id, BaselineEntry,
};
use sha2::{Digest, Sha256};
use similar::TextDiff;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceChangeKind {
    Added,
    Modified,
    Deleted,
}

impl WorkspaceChangeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChange {
    pub path: String,
    pub kind: WorkspaceChangeKind,
    pub binary: bool,
    pub original_size: u64,
    pub workspace_size: u64,
    pub conflict: bool,
    pub conflict_reason: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyWorkspaceResult {
    pub checkpoint_id: String,
    pub applied_count: usize,
}

#[derive(Clone, Debug)]
struct FileEntry {
    absolute: PathBuf,
    size: u64,
}

fn should_exclude(name: &str) -> bool {
    PROJECT_EXCLUDES.iter().any(|excluded| *excluded == name)
}

fn validate_relative_path(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("변경 파일 경로가 비어 있습니다.".to_string());
    }

    let path = Path::new(value);
    if path.is_absolute() {
        return Err("절대 경로는 사용할 수 없습니다.".to_string());
    }

    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let name = part.to_string_lossy();
                if should_exclude(&name) {
                    return Err(format!("보호된 경로는 변경할 수 없습니다: {value}"));
                }
                clean.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("안전하지 않은 상대 경로입니다: {value}"));
            }
        }
    }

    if clean.as_os_str().is_empty() {
        return Err("변경 파일 경로가 비어 있습니다.".to_string());
    }
    Ok(clean)
}

fn relative_key(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|error| format!("상대 경로 계산 실패: {} ({error})", path.display()))?;
    let relative = relative
        .to_str()
        .ok_or_else(|| format!("UTF-8이 아닌 파일 경로는 변경 검토에서 제외할 수 없습니다: {}", path.display()))?;
    Ok(relative.replace('\\', "/"))
}

fn collect_files(root: &Path) -> Result<BTreeMap<String, FileEntry>, String> {
    let mut files = BTreeMap::new();
    collect_files_inner(root, root, &mut files)?;
    Ok(files)
}

fn collect_files_inner(
    root: &Path,
    current: &Path,
    files: &mut BTreeMap<String, FileEntry>,
) -> Result<(), String> {
    if !current.is_dir() {
        return Ok(());
    }

    let entries = fs::read_dir(current)
        .map_err(|error| format!("변경 파일 목록 읽기 실패: {} ({error})", current.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("변경 파일 항목 읽기 실패: {error}"))?;
        let name = entry.file_name();
        let display_name = name.to_string_lossy();
        if should_exclude(&display_name) {
            continue;
        }

        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!("변경 파일 정보 읽기 실패: {} ({error})", path.display())
        })?;

        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_files_inner(root, &path, files)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }

        let key = relative_key(root, &path)?;
        files.insert(
            key,
            FileEntry {
                absolute: path,
                size: metadata.len(),
            },
        );
    }
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let file = File::open(path)
        .map_err(|error| format!("파일 열기 실패: {} ({error})", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("파일 읽기 실패: {} ({error})", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn workspace_entry_matches_baseline(
    workspace: &FileEntry,
    baseline: &BaselineEntry,
) -> Result<bool, String> {
    if workspace.size != baseline.size {
        return Ok(false);
    }
    Ok(file_sha256(&workspace.absolute)? == baseline.sha256)
}

fn baseline_entry_matches_path(
    baseline: &BTreeMap<String, BaselineEntry>,
    relative_path: &str,
    current: &Path,
) -> Result<bool, String> {
    if let Some(expected) = baseline.get(relative_path) {
        let metadata = match fs::symlink_metadata(current) {
            Ok(metadata) => metadata,
            Err(_error) if !current.exists() => return Ok(false),
            Err(error) => {
                return Err(format!("원본 파일 정보 읽기 실패: {} ({error})", current.display()))
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != expected.size {
            return Ok(false);
        }
        return Ok(file_sha256(current)? == expected.sha256);
    }

    // An exact baseline file did not exist. If descendants did exist, this path
    // represented a directory in the baseline. A real directory is therefore
    // expected here (file<->directory replacements are handled by child changes).
    let prefix = format!("{}/", relative_path.trim_end_matches('/'));
    let baseline_directory = baseline.keys().any(|path| path.starts_with(&prefix));
    if baseline_directory {
        return match fs::symlink_metadata(current) {
            Ok(metadata) => Ok(metadata.is_dir() && !metadata.file_type().is_symlink()),
            Err(_error) if !current.exists() => Ok(false),
            Err(error) => Err(format!("원본 폴더 정보 읽기 실패: {} ({error})", current.display())),
        };
    }

    match fs::symlink_metadata(current) {
        Ok(_) => Ok(false),
        Err(_) if !current.exists() => Ok(true),
        Err(error) => Err(format!("원본 경로 확인 실패: {} ({error})", current.display())),
    }
}

fn is_binary(path: &Path) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }
    let mut file = File::open(path)
        .map_err(|error| format!("파일 열기 실패: {} ({error})", path.display()))?;
    let mut buffer = vec![0_u8; 8192];
    let count = file
        .read(&mut buffer)
        .map_err(|error| format!("파일 읽기 실패: {} ({error})", path.display()))?;
    let sample = &buffer[..count];
    Ok(sample.contains(&0) || std::str::from_utf8(sample).is_err())
}

/// Both are regular files with the same bytes.
fn same_file_content(a: &Path, b: &Path) -> bool {
    let (Ok(meta_a), Ok(meta_b)) = (fs::symlink_metadata(a), fs::symlink_metadata(b)) else { return false };
    if !meta_a.is_file() || !meta_b.is_file() || meta_a.len() != meta_b.len() {
        return false;
    }
    matches!((fs::read(a), fs::read(b)), (Ok(x), Ok(y)) if x == y)
}

fn workspace_project_dir(project_root: &Path, conversation_id: &str) -> Result<PathBuf, String> {
    validate_conversation_id(conversation_id)?;
    ensure_project_snapshot(project_root, conversation_id)
}

pub fn list_workspace_changes(
    project_root: &Path,
    conversation_id: &str,
) -> Result<Vec<WorkspaceChange>, String> {
    let snapshot = workspace_project_dir(project_root, conversation_id)?;
    let baseline = load_project_baseline(project_root, conversation_id)?;
    let workspace_files = collect_files(&snapshot)?;

    // Agent changes are derived from baseline <-> workspace, not original <->
    // workspace. This keeps unrelated external edits out of the Agent change set.
    let mut paths = BTreeSet::new();
    paths.extend(baseline.keys().cloned());
    paths.extend(workspace_files.keys().cloned());

    let mut changes = Vec::new();
    for path in paths {
        let baseline_entry = baseline.get(&path);
        let workspace = workspace_files.get(&path);
        let (kind, binary, original_size, workspace_size) = match (baseline_entry, workspace) {
            (None, Some(workspace)) => (
                WorkspaceChangeKind::Added,
                is_binary(&workspace.absolute)?,
                0,
                workspace.size,
            ),
            (Some(baseline_entry), None) => (
                WorkspaceChangeKind::Deleted,
                baseline_entry.binary,
                baseline_entry.size,
                0,
            ),
            (Some(baseline_entry), Some(workspace)) => {
                if workspace_entry_matches_baseline(workspace, baseline_entry)? {
                    continue;
                }
                (
                    WorkspaceChangeKind::Modified,
                    baseline_entry.binary || is_binary(&workspace.absolute)?,
                    baseline_entry.size,
                    workspace.size,
                )
            }
            (None, None) => continue,
        };

        let current_original = project_root.join(validate_relative_path(&path)?);
        // The original already looks like the work copy (the same edit was made there, or an
        // earlier apply got this far): nothing to apply, and not a conflict either.
        let already_there = match workspace {
            Some(workspace) => same_file_content(&workspace.absolute, &current_original),
            None => !current_original.exists(),
        };
        if already_there {
            continue;
        }
        let conflict = !baseline_entry_matches_path(&baseline, &path, &current_original)?;
        let conflict_reason = conflict.then(|| {
            "원본이 작업 시작 후 변경되었습니다. 최신 원본을 확인한 뒤 작업을 다시 실행해주세요."
                .to_string()
        });

        changes.push(WorkspaceChange {
            path,
            kind,
            binary,
            original_size,
            workspace_size,
            conflict,
            conflict_reason,
        });
    }

    Ok(changes)
}

pub fn workspace_file_diff(
    project_root: &Path,
    conversation_id: &str,
    relative_path: &str,
) -> Result<String, String> {
    let relative_path = relative_path.trim();
    let change = list_workspace_changes(project_root, conversation_id)?
        .into_iter()
        .find(|change| change.path == relative_path)
        .ok_or_else(|| format!("Agent 변경 파일을 찾을 수 없습니다: {relative_path}"))?;
    let relative = validate_relative_path(relative_path)?;
    let snapshot = workspace_project_dir(project_root, conversation_id)?;
    let original = project_root.join(&relative);
    let workspace = snapshot.join(&relative);

    if change.binary {
        let prefix = change
            .conflict_reason
            .as_deref()
            .map(|reason| format!("CONFLICT: {reason}\n\n"))
            .unwrap_or_default();
        return Ok(format!("{prefix}Binary file changed: {relative_path}"));
    }

    let original_text = if original.is_file() {
        fs::read_to_string(&original)
            .map_err(|error| format!("원본 파일 읽기 실패: {} ({error})", original.display()))?
    } else {
        String::new()
    };
    let workspace_text = if workspace.is_file() {
        fs::read_to_string(&workspace)
            .map_err(|error| format!("작업 파일 읽기 실패: {} ({error})", workspace.display()))?
    } else {
        String::new()
    };

    let from = if original.is_file() {
        format!("a/{relative_path}")
    } else {
        "/dev/null".to_string()
    };
    let to = if workspace.is_file() {
        format!("b/{relative_path}")
    } else {
        "/dev/null".to_string()
    };
    let diff = TextDiff::from_lines(&original_text, &workspace_text)
        .unified_diff()
        .context_radius(3)
        .header(&from, &to)
        .to_string();

    if let Some(reason) = change.conflict_reason {
        Ok(format!("CONFLICT: {reason}\n\n{diff}"))
    } else {
        Ok(diff)
    }
}

fn copy_file(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("파일 정보 읽기 실패: {} ({error})", source.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("일반 파일만 적용할 수 있습니다: {}", source.display()));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("대상 폴더 생성 실패: {} ({error})", parent.display())
        })?;
    }
    if destination.exists() {
        let destination_meta = fs::symlink_metadata(destination).map_err(|error| {
            format!("대상 파일 정보 읽기 실패: {} ({error})", destination.display())
        })?;
        if destination_meta.file_type().is_symlink() {
            return Err(format!("심볼릭 링크 대상에는 적용하지 않습니다: {}", destination.display()));
        }
        if destination_meta.is_dir() {
            let mut entries = fs::read_dir(destination).map_err(|error| {
                format!("대상 폴더 읽기 실패: {} ({error})", destination.display())
            })?;
            if entries.next().is_some() {
                return Err(format!("비어 있지 않은 폴더를 파일로 덮어쓰지 않습니다: {}", destination.display()));
            }
            fs::remove_dir(destination).map_err(|error| {
                format!("빈 대상 폴더 정리 실패: {} ({error})", destination.display())
            })?;
        }
    }
    fs::copy(source, destination).map_err(|error| {
        format!("파일 적용 실패: {} -> {} ({error})", source.display(), destination.display())
    })?;
    Ok(())
}

fn checkpoint_id(conversation_id: &str) -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("시스템 시간 확인 실패: {error}"))?
        .as_millis();
    Ok(format!("{millis}-{conversation_id}"))
}

fn remove_empty_parents(mut current: Option<&Path>, project_root: &Path) {
    while let Some(path) = current {
        if path == project_root || !path.starts_with(project_root) {
            break;
        }
        let empty = fs::read_dir(path)
            .ok()
            .and_then(|mut entries| entries.next().transpose().ok())
            .flatten()
            .is_none();
        if !empty || fs::remove_dir(path).is_err() {
            break;
        }
        current = path.parent();
    }
}

fn rollback_from_checkpoint(
    project_root: &Path,
    checkpoint_project: &Path,
    changes: &[WorkspaceChange],
) -> Result<(), String> {
    for change in changes {
        if change.kind != WorkspaceChangeKind::Added {
            continue;
        }
        let relative = validate_relative_path(&change.path)?;
        let destination = project_root.join(&relative);
        if destination.exists() {
            let metadata = fs::symlink_metadata(&destination).map_err(|error| {
                format!("롤백 파일 정보 읽기 실패: {} ({error})", destination.display())
            })?;
            if metadata.is_file() && !metadata.file_type().is_symlink() {
                fs::remove_file(&destination).map_err(|error| {
                    format!("롤백 추가 파일 삭제 실패: {} ({error})", destination.display())
                })?;
                remove_empty_parents(destination.parent(), project_root);
            }
        }
    }

    for change in changes {
        if change.kind == WorkspaceChangeKind::Added {
            continue;
        }
        let relative = validate_relative_path(&change.path)?;
        let destination = project_root.join(&relative);
        let backup = checkpoint_project.join(&relative);
        if backup.is_file() {
            copy_file(&backup, &destination)?;
        }
    }
    Ok(())
}

pub fn apply_workspace_changes(
    project_root: &Path,
    conversation_id: &str,
) -> Result<ApplyWorkspaceResult, String> {
    validate_conversation_id(conversation_id)?;
    let snapshot = workspace_project_dir(project_root, conversation_id)?;
    let changes = list_workspace_changes(project_root, conversation_id)?;
    if changes.is_empty() {
        return Err("적용할 변경 파일이 없습니다.".to_string());
    }

    let conflicts: Vec<&str> = changes
        .iter()
        .filter(|change| change.conflict)
        .map(|change| change.path.as_str())
        .collect();
    if !conflicts.is_empty() {
        return Err(format!(
            "충돌이 있는 변경은 원본에 적용할 수 없습니다: {}",
            conflicts.join(", ")
        ));
    }

    for change in &changes {
        let relative = validate_relative_path(&change.path)?;
        let source = snapshot.join(&relative);
        if matches!(change.kind, WorkspaceChangeKind::Added | WorkspaceChangeKind::Modified) {
            let metadata = fs::symlink_metadata(&source).map_err(|error| {
                format!("작업 파일 정보 읽기 실패: {} ({error})", source.display())
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!("일반 작업 파일만 적용할 수 있습니다: {}", source.display()));
            }
        }
    }

    let checkpoint_id = checkpoint_id(conversation_id)?;
    let checkpoint_root = ensure_checkpoints_root(project_root)?.join(&checkpoint_id);
    let checkpoint_project = checkpoint_root.join("project");
    fs::create_dir_all(&checkpoint_project).map_err(|error| {
        format!("체크포인트 폴더 생성 실패: {} ({error})", checkpoint_project.display())
    })?;

    let mut manifest = String::new();
    for change in &changes {
        let relative = validate_relative_path(&change.path)?;
        let original = project_root.join(&relative);
        if original.is_file() {
            copy_file(&original, &checkpoint_project.join(&relative))?;
        }
        manifest.push_str(change.kind.as_str());
        manifest.push('\t');
        manifest.push_str(&change.path);
        manifest.push('\n');
    }
    fs::write(checkpoint_root.join("manifest.tsv"), manifest)
        .map_err(|error| format!("체크포인트 manifest 저장 실패: {error}"))?;

    let apply_result: Result<(), String> = (|| {
        for change in &changes {
            if change.kind != WorkspaceChangeKind::Deleted {
                continue;
            }
            let relative = validate_relative_path(&change.path)?;
            let original = project_root.join(&relative);
            if original.exists() {
                let metadata = fs::symlink_metadata(&original).map_err(|error| {
                    format!("삭제 대상 정보 읽기 실패: {} ({error})", original.display())
                })?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!("일반 파일만 삭제 적용할 수 있습니다: {}", original.display()));
                }
                fs::remove_file(&original).map_err(|error| {
                    format!("원본 파일 삭제 실패: {} ({error})", original.display())
                })?;
                remove_empty_parents(original.parent(), project_root);
            }
        }

        for change in &changes {
            if change.kind == WorkspaceChangeKind::Deleted {
                continue;
            }
            let relative = validate_relative_path(&change.path)?;
            let original = project_root.join(&relative);
            let workspace = snapshot.join(&relative);
            copy_file(&workspace, &original)?;
        }
        Ok(())
    })();

    if let Err(error) = apply_result {
        match rollback_from_checkpoint(project_root, &checkpoint_project, &changes) {
            Ok(()) => return Err(format!("변경 적용 실패 후 원본을 롤백했습니다: {error}")),
            Err(rollback_error) => {
                return Err(format!(
                    "변경 적용 실패: {error}; 자동 롤백도 실패했습니다: {rollback_error}; 체크포인트: {}",
                    checkpoint_root.display()
                ))
            }
        }
    }

    // Re-snapshot after a successful apply. This incorporates both our applied
    // files and any unrelated external edits, making the next baseline clean.
    reset_project_snapshot(project_root, conversation_id).map_err(|error| {
        format!("원본 적용은 완료했지만 작업공간 재동기화에 실패했습니다: {error}")
    })?;

    Ok(ApplyWorkspaceResult {
        checkpoint_id,
        applied_count: changes.len(),
    })
}

pub fn discard_workspace_changes(project_root: &Path, conversation_id: &str) -> Result<(), String> {
    validate_conversation_id(conversation_id)?;
    reset_project_snapshot(project_root, conversation_id)?;
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRecord {
    pub id: String,
    pub created_at: u64,
    pub conversation_id: Option<String>,
    pub changed_count: usize,
    pub purpose: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCheckpointResult {
    pub restored_checkpoint_id: String,
    pub safety_checkpoint_id: String,
    pub restored_count: usize,
}

#[derive(Clone, Debug)]
struct CheckpointManifestEntry {
    kind: WorkspaceChangeKind,
    path: String,
}

fn validate_checkpoint_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 200 {
        return Err("체크포인트 ID가 올바르지 않습니다.".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("체크포인트 ID에 허용되지 않는 문자가 있습니다.".to_string());
    }
    Ok(value.to_string())
}

fn checkpoints_root(project_root: &Path) -> PathBuf {
    project_root.join(".ai-character").join("checkpoints")
}

fn ensure_checkpoints_root(project_root: &Path) -> Result<PathBuf, String> {
    let ai_root = project_root.join(".ai-character");
    if ai_root.exists() {
        let metadata = fs::symlink_metadata(&ai_root).map_err(|error| {
            format!("AI-Character 상태 폴더 확인 실패: {} ({error})", ai_root.display())
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(".ai-character 경로가 안전한 폴더가 아닙니다.".to_string());
        }
    } else {
        fs::create_dir(&ai_root).map_err(|error| {
            format!("AI-Character 상태 폴더 생성 실패: {} ({error})", ai_root.display())
        })?;
    }

    let root = checkpoints_root(project_root);
    if root.exists() {
        let metadata = fs::symlink_metadata(&root).map_err(|error| {
            format!("체크포인트 폴더 확인 실패: {} ({error})", root.display())
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("체크포인트 저장 경로가 안전한 폴더가 아닙니다.".to_string());
        }
    } else {
        fs::create_dir(&root).map_err(|error| {
            format!("체크포인트 폴더 생성 실패: {} ({error})", root.display())
        })?;
    }
    Ok(root)
}

fn checked_checkpoint_root(project_root: &Path, checkpoint_id: &str) -> Result<PathBuf, String> {
    let checkpoint_id = validate_checkpoint_id(checkpoint_id)?;
    let root = ensure_checkpoints_root(project_root)?.join(checkpoint_id);
    let metadata = fs::symlink_metadata(&root)
        .map_err(|error| format!("체크포인트를 찾을 수 없습니다: {} ({error})", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("체크포인트 경로가 안전한 폴더가 아닙니다.".to_string());
    }
    Ok(root)
}

fn parse_checkpoint_manifest(checkpoint_root: &Path) -> Result<Vec<CheckpointManifestEntry>, String> {
    let manifest_path = checkpoint_root.join("manifest.tsv");
    let metadata = fs::symlink_metadata(&manifest_path).map_err(|error| {
        format!("체크포인트 manifest를 읽을 수 없습니다: {} ({error})", manifest_path.display())
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("체크포인트 manifest가 일반 파일이 아닙니다.".to_string());
    }
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("체크포인트 manifest 읽기 실패: {error}"))?;
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    for (index, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim_end();
        if line.is_empty() {
            continue;
        }
        let (kind, path) = line.split_once('\t').ok_or_else(|| {
            format!("체크포인트 manifest {}행 형식이 올바르지 않습니다.", index + 1)
        })?;
        let kind = match kind {
            "added" => WorkspaceChangeKind::Added,
            "modified" => WorkspaceChangeKind::Modified,
            "deleted" => WorkspaceChangeKind::Deleted,
            _ => return Err(format!("알 수 없는 체크포인트 변경 종류입니다: {kind}")),
        };
        let relative = validate_relative_path(path)?;
        let normalized = relative.to_string_lossy().replace('\\', "/");
        if !seen.insert(normalized.clone()) {
            return Err(format!("체크포인트 manifest에 중복 경로가 있습니다: {normalized}"));
        }
        entries.push(CheckpointManifestEntry {
            kind,
            path: normalized,
        });
    }
    if entries.is_empty() {
        return Err("체크포인트 manifest에 복원할 파일이 없습니다.".to_string());
    }
    Ok(entries)
}

fn checkpoint_created_at(checkpoint_id: &str, checkpoint_root: &Path) -> u64 {
    checkpoint_id
        .split('-')
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| {
            fs::metadata(checkpoint_root)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
        })
        .unwrap_or(0)
}

fn checkpoint_conversation_id(checkpoint_id: &str) -> Option<String> {
    let (_, suffix) = checkpoint_id.split_once('-')?;
    if suffix == "restore" || suffix.starts_with("restore-") {
        return None;
    }
    Some(suffix.to_string())
}

pub fn list_checkpoints(project_root: &Path, limit: u32) -> Result<Vec<CheckpointRecord>, String> {
    let root = ensure_checkpoints_root(project_root)?;

    let mut records = Vec::new();
    for entry in fs::read_dir(&root)
        .map_err(|error| format!("체크포인트 목록 읽기 실패: {error}"))?
    {
        let entry = entry.map_err(|error| format!("체크포인트 항목 읽기 실패: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("체크포인트 정보 읽기 실패: {} ({error})", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if validate_checkpoint_id(&id).is_err() {
            continue;
        }
        let Ok(entries) = parse_checkpoint_manifest(&path) else {
            continue;
        };
        records.push(CheckpointRecord {
            created_at: checkpoint_created_at(&id, &path),
            conversation_id: checkpoint_conversation_id(&id),
            changed_count: entries.len(),
            purpose: if id.contains("-restore") {
                "restore_safety".to_string()
            } else {
                "apply".to_string()
            },
            id,
        });
    }
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    records.truncate(limit.clamp(1, 100) as usize);
    Ok(records)
}

fn next_safety_checkpoint_id(project_root: &Path) -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("시스템 시간 확인 실패: {error}"))?
        .as_millis();
    let root = ensure_checkpoints_root(project_root)?;
    for suffix in 0_u16..1000 {
        let id = if suffix == 0 {
            format!("{millis}-restore")
        } else {
            format!("{millis}-restore-{suffix}")
        };
        if !root.join(&id).exists() {
            return Ok(id);
        }
    }
    Err("안전 체크포인트 ID를 생성하지 못했습니다.".to_string())
}

fn create_safety_checkpoint(
    project_root: &Path,
    entries: &[CheckpointManifestEntry],
) -> Result<String, String> {
    let safety_checkpoint_id = next_safety_checkpoint_id(project_root)?;
    let checkpoint_root = ensure_checkpoints_root(project_root)?.join(&safety_checkpoint_id);
    let checkpoint_project = checkpoint_root.join("project");
    fs::create_dir_all(&checkpoint_project).map_err(|error| {
        format!("복원 안전 체크포인트 생성 실패: {} ({error})", checkpoint_project.display())
    })?;

    let mut manifest = String::new();
    for entry in entries {
        let relative = validate_relative_path(&entry.path)?;
        let current = project_root.join(&relative);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!(
                        "복원 전 상태를 안전하게 저장할 수 없는 경로입니다: {}",
                        current.display()
                    ));
                }
                copy_file(&current, &checkpoint_project.join(&relative))?;
                manifest.push_str("modified\t");
            }
            Err(_error) if !current.exists() => {
                manifest.push_str("added\t");
            }
            Err(error) => {
                return Err(format!("복원 전 원본 상태 확인 실패: {} ({error})", current.display()));
            }
        }
        manifest.push_str(&entry.path);
        manifest.push('\n');
    }

    fs::write(checkpoint_root.join("manifest.tsv"), manifest)
        .map_err(|error| format!("복원 안전 체크포인트 manifest 저장 실패: {error}"))?;
    Ok(safety_checkpoint_id)
}

fn restore_entries_from_checkpoint(
    project_root: &Path,
    checkpoint_root: &Path,
    entries: &[CheckpointManifestEntry],
) -> Result<(), String> {
    let checkpoint_project = checkpoint_root.join("project");
    if checkpoint_project.exists() {
        let metadata = fs::symlink_metadata(&checkpoint_project).map_err(|error| {
            format!("체크포인트 project 폴더 확인 실패: {} ({error})", checkpoint_project.display())
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("체크포인트 project 경로가 안전한 폴더가 아닙니다.".to_string());
        }
    }

    // Paths that were newly added by the original apply did not exist before it.
    // Restoring that checkpoint therefore removes those files first.
    for entry in entries.iter().filter(|entry| entry.kind == WorkspaceChangeKind::Added) {
        let relative = validate_relative_path(&entry.path)?;
        let destination = project_root.join(&relative);
        match fs::symlink_metadata(&destination) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!("일반 파일만 체크포인트 삭제 복원할 수 있습니다: {}", destination.display()));
                }
                fs::remove_file(&destination).map_err(|error| {
                    format!("체크포인트 복원 중 파일 삭제 실패: {} ({error})", destination.display())
                })?;
                remove_empty_parents(destination.parent(), project_root);
            }
            Err(_error) if !destination.exists() => {}
            Err(error) => {
                return Err(format!("체크포인트 삭제 대상 확인 실패: {} ({error})", destination.display()));
            }
        }
    }

    for entry in entries.iter().filter(|entry| entry.kind != WorkspaceChangeKind::Added) {
        let relative = validate_relative_path(&entry.path)?;
        let backup = checkpoint_project.join(&relative);
        let metadata = fs::symlink_metadata(&backup).map_err(|error| {
            format!("체크포인트 백업 파일이 없습니다: {} ({error})", backup.display())
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!("체크포인트 백업이 일반 파일이 아닙니다: {}", backup.display()));
        }
        copy_file(&backup, &project_root.join(&relative))?;
    }
    Ok(())
}

pub fn restore_checkpoint(
    project_root: &Path,
    checkpoint_id: &str,
) -> Result<RestoreCheckpointResult, String> {
    let checkpoint_id = validate_checkpoint_id(checkpoint_id)?;
    let checkpoint_root = checked_checkpoint_root(project_root, &checkpoint_id)?;
    let entries = parse_checkpoint_manifest(&checkpoint_root)?;
    let safety_checkpoint_id = create_safety_checkpoint(project_root, &entries)?;
    let safety_root = checked_checkpoint_root(project_root, &safety_checkpoint_id)?;
    let safety_entries = parse_checkpoint_manifest(&safety_root)?;

    if let Err(error) = restore_entries_from_checkpoint(project_root, &checkpoint_root, &entries) {
        match restore_entries_from_checkpoint(project_root, &safety_root, &safety_entries) {
            Ok(()) => {
                return Err(format!("체크포인트 복원에 실패해 원본 상태를 자동 복구했습니다: {error}"));
            }
            Err(rollback_error) => {
                return Err(format!(
                    "체크포인트 복원 실패: {error}; 안전 체크포인트 롤백도 실패했습니다: {rollback_error}; 안전 체크포인트: {safety_checkpoint_id}"
                ));
            }
        }
    }

    Ok(RestoreCheckpointResult {
        restored_checkpoint_id: checkpoint_id,
        safety_checkpoint_id,
        restored_count: entries.len(),
    })
}
