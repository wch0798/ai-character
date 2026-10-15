use crate::environment_preflight::{git_binary, prepare_workspace_git, run_git};
use crate::settings::load_settings;
use crate::workspace::{ensure_conversation_workspace, ensure_project_snapshot};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Merges into the shared snapshot repository must never interleave.
static SNAPSHOT_GIT_LOCK: Mutex<()> = Mutex::new(());

const EXCLUDE_MARKER: &str = "# ai-character managed excludes";
const LOCAL_EXCLUDES: &[&str] = &[
    "node_modules",
    "target/",
    "dist/",
    "build/",
    ".venv/",
    "venv/",
    ".env",
    ".env.*",
    "!.env.example",
    "keys.env",
    ".netrc",
    "auth.json",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.keystore",
    "*.secret",
    "id_rsa",
    "id_ed25519",
    "credentials.json",
    "service-account.json",
    "secrets.json",
    "token.json",
    ".npmrc",
    ".pypirc",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoderWorktree {
    pub path: String,
    pub branch: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMergeOutcome {
    pub merged: bool,
    pub changed_files: Vec<String>,
    pub conflict_files: Vec<String>,
    pub message: String,
}

pub fn is_conversation_worktree(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let Some(parent) = path.parent() else { return false };
    normalized.contains("/.ai-character/conversations/")
        && parent.file_name().and_then(|name| name.to_str()) == Some("worktrees")
}

fn validate_task_id(task_id: &str) -> Result<&str, String> {
    let task_id = task_id.trim();
    if task_id.is_empty()
        || task_id.len() > 60
        || !task_id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(format!("worktree 작업 ID가 올바르지 않습니다: {task_id}"));
    }
    Ok(task_id)
}

fn branch_name(task_id: &str) -> String {
    format!("cradle/{task_id}")
}

fn git(binary: &Path, dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut full = vec![
        "-c",
        "user.name=AI-Character CRADLE",
        "-c",
        "user.email=cradle@local.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
    ];
    full.extend_from_slice(args);
    run_git(binary, dir, &full)
}

fn ensure_local_excludes(snapshot: &Path) -> Result<(), String> {
    let info = snapshot.join(".git").join("info");
    fs::create_dir_all(&info).map_err(|error| format!("git exclude 폴더 생성 실패: {error}"))?;
    let exclude = info.join("exclude");
    let current = fs::read_to_string(&exclude).unwrap_or_default();
    if current.contains(EXCLUDE_MARKER) {
        return Ok(());
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(EXCLUDE_MARKER);
    next.push('\n');
    for pattern in LOCAL_EXCLUDES {
        next.push_str(pattern);
        next.push('\n');
    }
    fs::write(&exclude, next).map_err(|error| format!("git exclude 기록 실패: {error}"))
}

/// Commits every non-excluded change; returns false when there was nothing to commit.
fn commit_all(binary: &Path, dir: &Path, message: &str) -> Result<bool, String> {
    git(binary, dir, &["add", "-A"])?;
    if git(binary, dir, &["status", "--porcelain"])?.trim().is_empty() {
        return Ok(false);
    }
    git(binary, dir, &["commit", "--no-verify", "-m", message])?;
    Ok(true)
}

fn lines(text: String) -> Vec<String> {
    text.lines().map(str::trim).filter(|line| !line.is_empty()).map(str::to_string).collect()
}

fn remove_worktree(binary: &Path, snapshot: &Path, path: &Path, branch: &str) {
    if path.exists() {
        let _ = git(binary, snapshot, &["worktree", "remove", "--force", &path.to_string_lossy()]);
        let _ = fs::remove_dir_all(path);
    }
    let _ = git(binary, snapshot, &["worktree", "prune"]);
    let _ = git(binary, snapshot, &["branch", "-D", branch]);
}

struct Paths {
    snapshot: PathBuf,
    worktree: PathBuf,
}

fn paths(project_root: &Path, conversation_id: &str, task_id: &str) -> Result<Paths, String> {
    let workspace = ensure_conversation_workspace(project_root, conversation_id)?;
    let snapshot = ensure_project_snapshot(project_root, conversation_id)?;
    Ok(Paths { snapshot, worktree: workspace.join("worktrees").join(task_id) })
}

pub fn create_worktree_for(
    project_root: &Path,
    conversation_id: &str,
    task_id: &str,
) -> Result<CoderWorktree, String> {
    let task_id = validate_task_id(task_id)?;
    let binary = git_binary().ok_or("environment_git_missing|Git이 설치되어 있지 않습니다.")?;
    let Paths { snapshot, worktree } = paths(project_root, conversation_id, task_id)?;
    let branch = branch_name(task_id);
    let _guard = SNAPSHOT_GIT_LOCK.lock().map_err(|_| "worktree 잠금 실패".to_string())?;

    prepare_workspace_git(&snapshot)?;
    ensure_local_excludes(&snapshot)?;
    commit_all(&binary, &snapshot, &format!("cradle: checkpoint before {task_id}"))?;
    remove_worktree(&binary, &snapshot, &worktree, &branch);
    if let Some(parent) = worktree.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("worktree 폴더 생성 실패: {error}"))?;
    }
    git(&binary, &snapshot, &["worktree", "add", "-b", &branch, &worktree.to_string_lossy(), "HEAD"])?;
    Ok(CoderWorktree { path: worktree.to_string_lossy().into_owned(), branch })
}

/// Merges a Coder worktree back into the snapshot. Conflicts with another
/// Coder's merge keep this task's version and are reported, so the existing
/// workspace review screen shows them before anything reaches the project.
pub fn merge_worktree_for(
    project_root: &Path,
    conversation_id: &str,
    task_id: &str,
) -> Result<WorktreeMergeOutcome, String> {
    let task_id = validate_task_id(task_id)?;
    let binary = git_binary().ok_or("environment_git_missing|Git이 설치되어 있지 않습니다.")?;
    let Paths { snapshot, worktree } = paths(project_root, conversation_id, task_id)?;
    let branch = branch_name(task_id);
    if !worktree.is_dir() {
        return Err(format!("worktree가 없습니다: {}", worktree.display()));
    }
    let _guard = SNAPSHOT_GIT_LOCK.lock().map_err(|_| "worktree 잠금 실패".to_string())?;

    commit_all(&binary, &worktree, &format!("cradle: {task_id}"))?;
    commit_all(&binary, &snapshot, "cradle: snapshot sync")?;
    let base = git(&binary, &snapshot, &["merge-base", "HEAD", &branch])?;
    let changed_files = lines(git(&binary, &snapshot, &["diff", "--name-only", &base, &branch])?);
    if changed_files.is_empty() {
        remove_worktree(&binary, &snapshot, &worktree, &branch);
        return Ok(WorktreeMergeOutcome {
            merged: true,
            message: "변경 사항이 없습니다.".to_string(),
            ..Default::default()
        });
    }

    let message = format!("cradle: merge {task_id}");
    let mut conflict_files = Vec::new();
    if git(&binary, &snapshot, &["merge", "--no-ff", "--no-edit", "-m", &message, &branch]).is_err() {
        conflict_files = lines(git(&binary, &snapshot, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default());
        let _ = git(&binary, &snapshot, &["merge", "--abort"]);
        if let Err(error) =
            git(&binary, &snapshot, &["merge", "--no-ff", "--no-edit", "-X", "theirs", "-m", &message, &branch])
        {
            let _ = git(&binary, &snapshot, &["merge", "--abort"]);
            return Ok(WorktreeMergeOutcome {
                merged: false,
                changed_files,
                conflict_files,
                message: format!("worktree 병합 실패(작업 결과는 {branch} 브랜치에 보존): {error}"),
            });
        }
    }
    remove_worktree(&binary, &snapshot, &worktree, &branch);
    let message = if conflict_files.is_empty() {
        format!("{}개 파일을 작업공간에 합쳤습니다.", changed_files.len())
    } else {
        format!(
            "{}개 파일을 합쳤고, 다른 작업과 겹친 {}개 파일은 이 작업 내용을 우선했습니다. 변경 검토 화면에서 확인해 주세요.",
            changed_files.len(),
            conflict_files.len()
        )
    };
    Ok(WorktreeMergeOutcome { merged: true, changed_files, conflict_files, message })
}

pub fn discard_worktree_for(project_root: &Path, conversation_id: &str, task_id: &str) -> Result<(), String> {
    let task_id = validate_task_id(task_id)?;
    let Some(binary) = git_binary() else { return Ok(()) };
    let Paths { snapshot, worktree } = paths(project_root, conversation_id, task_id)?;
    let _guard = SNAPSHOT_GIT_LOCK.lock().map_err(|_| "worktree 잠금 실패".to_string())?;
    remove_worktree(&binary, &snapshot, &worktree, &branch_name(task_id));
    Ok(())
}

fn project_root() -> Result<PathBuf, String> {
    load_settings()?
        .project_dir
        .ok_or_else(|| "프로젝트 폴더가 지정되지 않았습니다.".to_string())
}

#[tauri::command]
pub async fn create_coder_worktree(conversation_id: String, task_id: String) -> Result<CoderWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree_for(&project_root()?, conversation_id.trim(), &task_id)
    })
    .await
    .map_err(|error| format!("worktree 생성 작업 실패: {error}"))?
}

#[tauri::command]
pub async fn merge_coder_worktree(conversation_id: String, task_id: String) -> Result<WorktreeMergeOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        merge_worktree_for(&project_root()?, conversation_id.trim(), &task_id)
    })
    .await
    .map_err(|error| format!("worktree 병합 작업 실패: {error}"))?
}

#[tauri::command]
pub async fn discard_coder_worktree(conversation_id: String, task_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        discard_worktree_for(&project_root()?, conversation_id.trim(), &task_id)
    })
    .await
    .map_err(|error| format!("worktree 정리 작업 실패: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("coder-wt-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn recognizes_conversation_worktree_paths() {
        assert!(is_conversation_worktree(Path::new("/p/.ai-character/conversations/c1/worktrees/t1")));
        assert!(!is_conversation_worktree(Path::new("/p/.ai-character/conversations/c1/project")));
        assert!(!is_conversation_worktree(Path::new("/p/worktrees/t1")));
    }

    #[test]
    fn rejects_unsafe_task_ids() {
        assert!(validate_task_id("task-1").is_ok());
        assert!(validate_task_id("../x").is_err());
        assert!(validate_task_id("a b").is_err());
    }

    #[test]
    fn parallel_coders_merge_and_conflicts_prefer_task_version() {
        if git_binary().is_none() {
            return;
        }
        let root = temp_project("merge");
        fs::write(root.join("shared.txt"), "base\n").unwrap();
        fs::write(root.join("keys.env"), "OPENAI_API_KEY=secret\n").unwrap();

        let a = create_worktree_for(&root, "conv-wt", "task-a").unwrap();
        let b = create_worktree_for(&root, "conv-wt", "task-b").unwrap();
        fs::write(Path::new(&a.path).join("a.txt"), "from a\n").unwrap();
        fs::write(Path::new(&a.path).join("shared.txt"), "edited by a\n").unwrap();
        fs::write(Path::new(&b.path).join("b.txt"), "from b\n").unwrap();
        fs::write(Path::new(&b.path).join("shared.txt"), "edited by b\n").unwrap();

        let first = merge_worktree_for(&root, "conv-wt", "task-a").unwrap();
        assert!(first.merged && first.conflict_files.is_empty());
        let second = merge_worktree_for(&root, "conv-wt", "task-b").unwrap();
        assert!(second.merged);
        assert_eq!(second.conflict_files, vec!["shared.txt".to_string()]);

        let snapshot = ensure_project_snapshot(&root, "conv-wt").unwrap();
        assert_eq!(fs::read_to_string(snapshot.join("a.txt")).unwrap(), "from a\n");
        assert_eq!(fs::read_to_string(snapshot.join("b.txt")).unwrap(), "from b\n");
        assert_eq!(fs::read_to_string(snapshot.join("shared.txt")).unwrap(), "edited by b\n");
        assert!(!snapshot.join("keys.env").exists());
        assert!(!Path::new(&a.path).exists());
        let _ = fs::remove_dir_all(&root);
    }
}
