use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CradleEnvironmentStatus {
    pub git_installed: bool,
    pub git_version: Option<String>,
    pub git_path: Option<String>,
    pub workspace_git_ready: bool,
    pub workspace_path: Option<String>,
    pub install_supported: bool,
    pub install_hint: String,
    pub message: String,
}

fn executable_variants(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

fn common_git_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    #[cfg(windows)]
    {
        if let Some(program_files) = env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(program_files).join("Git").join("cmd"));
        }
        if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
            dirs.push(PathBuf::from(program_files_x86).join("Git").join("cmd"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    dirs
}

pub fn git_binary() -> Option<PathBuf> {
    if let Some(value) = crate::process_util::process_path() {
        for dir in env::split_paths(&value) {
            for name in executable_variants("git") {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    if git_version_for(&candidate).is_some() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    for dir in common_git_dirs() {
        for name in executable_variants("git") {
            let candidate = dir.join(name);
            if candidate.is_file() && git_version_for(&candidate).is_some() {
                return Some(candidate);
            }
        }
    }
    None
}

fn git_version_for(binary: &Path) -> Option<String> {
    let mut command = Command::new(binary);
    #[cfg(windows)]
    {
        crate::windows_process::hide_console(&mut command);
    }
    let output = command
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub(crate) fn run_git(binary: &Path, workspace: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(binary);
    #[cfg(windows)]
    {
        crate::windows_process::hide_console(&mut command);
    }
    // Agents edit these folders, .git included: a hook or fsmonitor they planted would run here,
    // outside the agent's checks, with the app's environment. So no hooks, no fsmonitor, no keys.
    for name in crate::policy_engine::SECRET_ENV_NAMES {
        command.env_remove(name);
    }
    let no_hooks = if cfg!(windows) { "core.hooksPath=NUL" } else { "core.hooksPath=/dev/null" };
    let output = command
        .args(["-c", no_hooks, "-c", "core.fsmonitor=false"])
        .arg("-C")
        .arg(workspace)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Git 실행 실패: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        format!("exit={:?}", output.status.code())
    } else {
        stderr
    };
    Err(format!("Git 명령 실패: {detail}"))
}

pub fn is_conversation_workspace(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    normalized.contains("/.ai-character/conversations/") && normalized.ends_with("/project")
}

fn workspace_git_ready(binary: &Path, workspace: &Path) -> bool {
    run_git(binary, workspace, &["rev-parse", "--is-inside-work-tree"])
        .map(|value| value.trim() == "true")
        .unwrap_or(false)
}

pub fn prepare_workspace_git(workspace: &Path) -> Result<bool, String> {
    if !workspace.is_dir() {
        return Err(format!("CRADLE workspace가 없습니다: {}", workspace.display()));
    }
    if !is_conversation_workspace(workspace) {
        return Err("원본 프로젝트에는 CRADLE 전용 Git 저장소를 만들지 않습니다.".to_string());
    }
    let binary = git_binary().ok_or_else(|| {
        "environment_git_missing|Git이 설치되어 있지 않습니다. 설정의 'Git 설치'를 사용해주세요.".to_string()
    })?;
    if workspace_git_ready(&binary, workspace) {
        return Ok(false);
    }

    run_git(&binary, workspace, &["init"])?;
    // Create only an empty local baseline commit. Project files, .env files,
    // credentials and other content are never staged into Git by this step.
    run_git(
        &binary,
        workspace,
        &[
            "-c",
            "user.name=AI-Character CRADLE",
            "-c",
            "user.email=cradle@local.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "AI-Character CRADLE baseline",
        ],
    )?;
    Ok(true)
}

pub fn git_status(workspace: Option<&Path>) -> CradleEnvironmentStatus {
    let binary = git_binary();
    let git_version = binary.as_deref().and_then(git_version_for);
    let workspace_git_ready = match (binary.as_deref(), workspace) {
        (Some(binary), Some(workspace)) if workspace.is_dir() => workspace_git_ready(binary, workspace),
        _ => false,
    };
    let message = if binary.is_none() {
        "Git 설치가 필요합니다. 코드 작업 전 설치 도우미를 실행해주세요.".to_string()
    } else if workspace.is_some() && !workspace_git_ready {
        "Git은 설치되어 있습니다. CRADLE workspace는 첫 코드 작업 전에 자동 초기화됩니다.".to_string()
    } else if workspace_git_ready {
        "Git과 CRADLE workspace가 준비되었습니다.".to_string()
    } else {
        "Git이 설치되어 있습니다. CRADLE workspace는 작업 시작 시 자동 준비됩니다.".to_string()
    };

    CradleEnvironmentStatus {
        git_installed: binary.is_some(),
        git_version,
        git_path: binary.map(|path| path.to_string_lossy().into_owned()),
        workspace_git_ready,
        workspace_path: workspace.map(|path| path.to_string_lossy().into_owned()),
        install_supported: cfg!(target_os = "macos") || cfg!(windows),
        install_hint: if cfg!(target_os = "macos") {
            "macOS Command Line Tools 설치 창을 엽니다.".to_string()
        } else if cfg!(windows) {
            "Git for Windows 다운로드 페이지를 엽니다.".to_string()
        } else {
            "배포판 패키지 관리자에서 git을 설치해주세요.".to_string()
        },
        message,
    }
}

pub fn is_codex_trust_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("not inside a trusted directory")
        || lower.contains("skip-git-repo-check")
        || (lower.contains("git") && lower.contains("trusted"))
}

pub fn launch_git_installer() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("xcode-select")
            .arg("--install")
            .spawn()
            .map_err(|error| format!("Git 설치 도우미 실행 실패: {error}"))?;
        return Ok(());
    }

    #[cfg(windows)]
    {
        crate::windows_setup::install_git().map(|_| ())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Err("Git이 없습니다. 예: sudo apt install git / sudo dnf install git / sudo pacman -S git".to_string())
    }
}
