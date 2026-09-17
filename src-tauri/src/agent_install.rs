use crate::agent_core::{resolve_agent_binary, AgentKind};
use crate::environment_preflight::git_binary;
use crate::settings::load_settings;
use serde::Serialize;
use std::env;
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeComponentStatus {
    pub id: String,
    pub label: String,
    pub ready: bool,
    pub detail: String,
    pub can_auto_install: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSetupStatus {
    pub platform: String,
    pub components: Vec<RuntimeComponentStatus>,
    pub all_ready: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStepResult {
    pub id: String,
    pub ok: bool,
    pub message: String,
}

fn platform_name() -> &'static str {
    #[cfg(windows)]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "linux"
    }
}

fn node_binary() -> Option<PathBuf> {
    if let Some(value) = env::var_os("PATH") {
        for dir in env::split_paths(&value) {
            for name in ["node.exe", "node"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(program_files) = env::var_os("ProgramFiles") {
            let candidate = PathBuf::from(program_files)
                .join("nodejs")
                .join("node.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            let candidate = PathBuf::from(local)
                .join("Programs")
                .join("node")
                .join("node.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn npm_binary() -> Option<PathBuf> {
    if let Some(value) = env::var_os("PATH") {
        for dir in env::split_paths(&value) {
            for name in ["npm.cmd", "npm.exe", "npm"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    if let Some(program_files) = env::var_os("ProgramFiles") {
        let candidate = PathBuf::from(program_files)
            .join("nodejs")
            .join("npm.cmd");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn winget_binary() -> Option<PathBuf> {
    if let Some(value) = env::var_os("PATH") {
        for dir in env::split_paths(&value) {
            for name in ["winget.exe", "winget"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local)
            .join("Microsoft")
            .join("WindowsApps")
            .join("winget.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn agent_status(agent: AgentKind) -> RuntimeComponentStatus {
    let settings = load_settings().ok();
    let saved = settings
        .as_ref()
        .and_then(|s| s.agent_path(agent).map(PathBuf::as_path));
    match resolve_agent_binary(agent, saved) {
        Ok(path) => RuntimeComponentStatus {
            id: agent.as_str().to_string(),
            label: agent.display_name().to_string(),
            ready: true,
            detail: path.display().to_string(),
            can_auto_install: cfg!(windows),
        },
        Err(error) => RuntimeComponentStatus {
            id: agent.as_str().to_string(),
            label: agent.display_name().to_string(),
            ready: false,
            detail: error,
            can_auto_install: cfg!(windows),
        },
    }
}

#[tauri::command]
pub fn get_runtime_setup_status() -> RuntimeSetupStatus {
    let mut components = Vec::new();

    match git_binary() {
        Some(path) => components.push(RuntimeComponentStatus {
            id: "git".into(),
            label: "Git".into(),
            ready: true,
            detail: path.display().to_string(),
            can_auto_install: cfg!(windows),
        }),
        None => components.push(RuntimeComponentStatus {
            id: "git".into(),
            label: "Git".into(),
            ready: false,
            detail: "없음 — 코드 작업/Codex에 필요".into(),
            can_auto_install: cfg!(windows) || cfg!(target_os = "macos"),
        }),
    }

    match node_binary() {
        Some(path) => components.push(RuntimeComponentStatus {
            id: "node".into(),
            label: "Node.js".into(),
            ready: true,
            detail: path.display().to_string(),
            can_auto_install: cfg!(windows),
        }),
        None => components.push(RuntimeComponentStatus {
            id: "node".into(),
            label: "Node.js".into(),
            ready: false,
            detail: "없음 — Claude/Codex CLI 설치에 필요".into(),
            can_auto_install: cfg!(windows),
        }),
    }

    for agent in [
        AgentKind::Claude,
        AgentKind::Cursor,
        AgentKind::Codex,
        AgentKind::Antigravity,
    ] {
        components.push(agent_status(agent));
    }

    let all_ready = components.iter().all(|c| c.ready);
    let missing: Vec<_> = components
        .iter()
        .filter(|c| !c.ready)
        .map(|c| c.label.as_str())
        .collect();
    let message = if all_ready {
        "필요한 프로그램이 모두 준비되었습니다. Agent 로그인만 각 앱에서 한 번 해 주세요.".to_string()
    } else {
        format!(
            "아직 없는 항목: {}. ‘필수 프로그램 설치’로 자동 설치할 수 있습니다.",
            missing.join(", ")
        )
    };

    RuntimeSetupStatus {
        platform: platform_name().to_string(),
        components,
        all_ready,
        message,
    }
}

#[cfg(windows)]
fn run_winget(package_id: &str) -> Result<String, String> {
    let winget = winget_binary().ok_or_else(|| {
        "winget이 없습니다. Microsoft Store에서 '앱 설치 관리자'를 설치하세요.".to_string()
    })?;
    let output = Command::new(winget)
        .args([
            "install",
            "--id",
            package_id,
            "-e",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ])
        .output()
        .map_err(|error| format!("winget 실행 실패: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    // 이미 설치됨도 성공으로 처리
    if output.status.success()
        || stdout.contains("already installed")
        || stderr.contains("already installed")
        || stdout.contains("No available upgrade")
    {
        return Ok(format!("{package_id} 설치 완료"));
    }
    Err(format!(
        "{package_id} 설치 실패: {}",
        if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        }
    ))
}

#[cfg(windows)]
fn run_npm_global(package: &str) -> Result<String, String> {
    let npm = npm_binary().ok_or_else(|| {
        "npm이 없습니다. Node.js를 먼저 설치하세요.".to_string()
    })?;
    let output = Command::new(npm)
        .args(["install", "-g", package])
        .output()
        .map_err(|error| format!("npm 실행 실패: {error}"))?;
    if output.status.success() {
        return Ok(format!("{package} 전역 설치 완료"));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "{package} 설치 실패: {}",
        if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        }
    ))
}

#[cfg(windows)]
fn open_url(url: &str) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|error| format!("브라우저 열기 실패: {error}"))?;
    Ok(())
}

/// Git + Node 등 기반 런타임 설치
#[tauri::command]
pub fn install_windows_runtimes() -> Result<Vec<InstallStepResult>, String> {
    #[cfg(not(windows))]
    {
        return Err("이 기능은 Windows에서만 사용할 수 있습니다.".to_string());
    }
    #[cfg(windows)]
    {
        let mut steps = Vec::new();

        if git_binary().is_none() {
            match run_winget("Git.Git") {
                Ok(message) => steps.push(InstallStepResult {
                    id: "git".into(),
                    ok: true,
                    message,
                }),
                Err(error) => {
                    let _ = open_url("https://git-scm.com/download/win");
                    steps.push(InstallStepResult {
                        id: "git".into(),
                        ok: false,
                        message: format!("{error} — 다운로드 페이지를 열었습니다."),
                    });
                }
            }
        } else {
            steps.push(InstallStepResult {
                id: "git".into(),
                ok: true,
                message: "Git 이미 설치됨".into(),
            });
        }

        if node_binary().is_none() {
            match run_winget("OpenJS.NodeJS.LTS") {
                Ok(message) => steps.push(InstallStepResult {
                    id: "node".into(),
                    ok: true,
                    message,
                }),
                Err(error) => {
                    let _ = open_url("https://nodejs.org/en/download");
                    steps.push(InstallStepResult {
                        id: "node".into(),
                        ok: false,
                        message: format!("{error} — Node 다운로드 페이지를 열었습니다."),
                    });
                }
            }
        } else {
            steps.push(InstallStepResult {
                id: "node".into(),
                ok: true,
                message: "Node.js 이미 설치됨".into(),
            });
        }

        Ok(steps)
    }
}

/// Agent CLI 설치 (가능한 것만 자동, 나머지는 공식 설치 페이지)
#[tauri::command]
pub fn install_agent_cli(agent: String) -> Result<InstallStepResult, String> {
    let agent = AgentKind::parse(&agent)?;
    #[cfg(not(windows))]
    {
        return Ok(InstallStepResult {
            id: agent.as_str().to_string(),
            ok: false,
            message: format!(
                "{} Windows 자동 설치는 Windows에서만 지원합니다.",
                agent.display_name()
            ),
        });
    }
    #[cfg(windows)]
    {
        // 이미 있으면 스킵
        let settings = load_settings().ok();
        let saved = settings
            .as_ref()
            .and_then(|s| s.agent_path(agent).map(PathBuf::as_path));
        if resolve_agent_binary(agent, saved).is_ok() {
            return Ok(InstallStepResult {
                id: agent.as_str().to_string(),
                ok: true,
                message: format!("{} 이미 설치됨", agent.display_name()),
            });
        }

        let result = match agent {
            AgentKind::Claude => {
                if node_binary().is_none() {
                    let _ = install_windows_runtimes();
                }
                run_npm_global("@anthropic-ai/claude-code").or_else(|error| {
                    let _ = open_url("https://docs.anthropic.com/en/docs/claude-code/overview");
                    Err(format!("{error} — 문서를 열었습니다."))
                })
            }
            AgentKind::Codex => {
                if node_binary().is_none() {
                    let _ = install_windows_runtimes();
                }
                run_npm_global("@openai/codex").or_else(|error| {
                    let _ = open_url("https://github.com/openai/codex");
                    Err(format!("{error} — 문서를 열었습니다."))
                })
            }
            AgentKind::Cursor => run_winget("Anysphere.Cursor").or_else(|error| {
                let _ = open_url("https://cursor.com/download");
                Err(format!("{error} — Cursor 다운로드 페이지를 열었습니다."))
            }),
            AgentKind::Antigravity => {
                let _ = open_url("https://antigravity.google/");
                Err("Antigravity는 공식 설치 페이지를 열었습니다. 설치 후 앱을 다시 실행하세요.".to_string())
            }
        };

        match result {
            Ok(message) => Ok(InstallStepResult {
                id: agent.as_str().to_string(),
                ok: true,
                message,
            }),
            Err(message) => Ok(InstallStepResult {
                id: agent.as_str().to_string(),
                ok: false,
                message,
            }),
        }
    }
}

/// 한 번에: Git/Node + Claude/Cursor/Codex (Antigravity는 링크)
#[tauri::command]
pub fn install_all_required_runtimes() -> Result<Vec<InstallStepResult>, String> {
    #[cfg(not(windows))]
    {
        return Err(
            "필수 프로그램 일괄 설치는 Windows에서만 지원합니다. macOS는 Homebrew 등으로 설치하세요."
                .to_string(),
        );
    }
    #[cfg(windows)]
    {
        let mut steps = install_windows_runtimes()?;
        for agent in ["claude", "cursor", "codex", "antigravity"] {
            steps.push(install_agent_cli(agent.to_string())?);
        }
        Ok(steps)
    }
}
