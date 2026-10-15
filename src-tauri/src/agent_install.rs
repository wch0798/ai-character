use crate::agent_core::{inspect_agent_runtime, resolve_agent_binary, AgentKind};
use crate::environment_preflight::git_binary;
use crate::settings::load_settings;
use serde::Serialize;
#[cfg(not(windows))]
use std::env;
use std::path::PathBuf;
#[cfg(not(windows))]
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
    #[cfg(windows)]
    {
        return crate::windows_setup::node_binary();
    }
    #[cfg(not(windows))]
    {
        if let Some(value) = crate::process_util::process_path() {
            for dir in env::split_paths(&value) {
                for name in ["node.exe", "node"] {
                    let candidate = dir.join(name);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    }
}

fn agent_status(agent: AgentKind) -> RuntimeComponentStatus {
    let settings = load_settings().ok();
    let saved = settings
        .as_ref()
        .and_then(|s| s.agent_path(agent).map(PathBuf::as_path));
    let runtime = inspect_agent_runtime(agent, saved);
    let mut parts = Vec::new();
    if let Some(path) = runtime.cli.as_ref() {
        parts.push(format!("CLI {}", path.display()));
    }
    if let Some(path) = runtime.app.as_ref() {
        parts.push(format!("앱 {}", path.display()));
    }
    if parts.is_empty() {
        RuntimeComponentStatus {
            id: agent.as_str().to_string(),
            label: agent.display_name().to_string(),
            ready: false,
            detail: format!("{} CLI/앱 없음 — 둘 다 설치할 수 있습니다.", agent.display_name()),
            can_auto_install: cfg!(windows),
        }
    } else {
        RuntimeComponentStatus {
            id: agent.as_str().to_string(),
            label: agent.display_name().to_string(),
            ready: runtime.cli.is_some(),
            detail: parts.join(" · "),
            can_auto_install: cfg!(windows),
        }
    }
}

#[tauri::command]
pub fn get_runtime_setup_status() -> RuntimeSetupStatus {
    #[cfg(windows)]
    {
        crate::windows_setup::refresh_process_path();
    }

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

fn install_windows_runtimes_impl() -> Result<Vec<InstallStepResult>, String> {
    #[cfg(not(windows))]
    {
        Err("이 기능은 Windows에서만 사용할 수 있습니다.".to_string())
    }
    #[cfg(windows)]
    {
        crate::windows_setup::refresh_process_path();
        let mut steps = Vec::new();
        match crate::windows_setup::install_git() {
            Ok(message) => steps.push(InstallStepResult {
                id: "git".into(),
                ok: true,
                message,
            }),
            Err(error) => steps.push(InstallStepResult {
                id: "git".into(),
                ok: false,
                message: error,
            }),
        }
        match crate::windows_setup::install_node() {
            Ok(message) => steps.push(InstallStepResult {
                id: "node".into(),
                ok: true,
                message,
            }),
            Err(error) => steps.push(InstallStepResult {
                id: "node".into(),
                ok: false,
                message: error,
            }),
        }
        Ok(steps)
    }
}

pub(crate) fn install_agent_cli_impl(agent: String) -> Result<InstallStepResult, String> {
    let agent = AgentKind::parse(&agent)?;
    #[cfg(not(windows))]
    {
        Ok(InstallStepResult {
            id: agent.as_str().to_string(),
            ok: false,
            message: format!(
                "{} Windows 자동 설치는 Windows에서만 지원합니다.",
                agent.display_name()
            ),
        })
    }
    #[cfg(windows)]
    {
        crate::windows_setup::refresh_process_path();
        let runtime = crate::agent_core::inspect_agent_runtime(agent, None);
        let cli_ready = match runtime.cli.clone() {
            Some(path) => crate::agent_core::is_preferred_windows_binary(agent, &path),
            None => false,
        };
        if cli_ready && runtime.app.is_some() {
            return Ok(InstallStepResult {
                id: agent.as_str().to_string(),
                ok: true,
                message: format!(
                    "{} CLI와 앱이 이미 있습니다. ({})",
                    agent.display_name(),
                    runtime
                        .cli
                        .as_ref()
                        .or(runtime.app.as_ref())
                        .map(|path| path.display().to_string())
                        .unwrap_or_default()
                ),
            });
        }

        let result = match agent {
            AgentKind::Claude => {
                if node_binary().is_none() {
                    let _ = crate::windows_setup::install_node();
                }
                crate::windows_setup::install_claude()
            }
            AgentKind::Codex => {
                if node_binary().is_none() {
                    let _ = crate::windows_setup::install_node();
                }
                crate::windows_setup::install_codex()
            }
            AgentKind::Cursor => crate::windows_setup::install_cursor_agent(),
            AgentKind::Antigravity => crate::windows_setup::install_antigravity(),
        };

        match result {
            Ok(message) => {
                crate::windows_setup::refresh_process_path();
                let resolved = resolve_agent_binary(agent, None)
                    .map(|path| format!(" → {}", path.display()))
                    .unwrap_or_default();
                Ok(InstallStepResult {
                    id: agent.as_str().to_string(),
                    ok: true,
                    message: format!("{message}{resolved}"),
                })
            }
            Err(message) => Ok(InstallStepResult {
                id: agent.as_str().to_string(),
                ok: false,
                message,
            }),
        }
    }
}

pub(crate) fn install_all_required_runtimes_impl() -> Result<Vec<InstallStepResult>, String> {
    #[cfg(not(windows))]
    {
        Err(
            "필수 프로그램 일괄 설치는 Windows에서만 지원합니다. macOS는 Homebrew 등으로 설치하세요."
                .to_string(),
        )
    }
    #[cfg(windows)]
    {
        let mut steps = install_windows_runtimes_impl()?;
        for agent in ["claude", "cursor", "codex", "antigravity"] {
            steps.push(install_agent_cli_impl(agent.to_string())?);
        }
        Ok(steps)
    }
}

/// Git + Node 등 기반 런타임 설치
#[tauri::command]
pub async fn install_windows_runtimes() -> Result<Vec<InstallStepResult>, String> {
    tauri::async_runtime::spawn_blocking(install_windows_runtimes_impl)
        .await
        .map_err(|error| format!("설치 작업 실패: {error}"))?
}

/// Agent CLI 설치 (가능한 것만 자동, 나머지는 공식 설치 페이지)
#[tauri::command]
pub async fn install_agent_cli(agent: String) -> Result<InstallStepResult, String> {
    tauri::async_runtime::spawn_blocking(move || install_agent_cli_impl(agent))
        .await
        .map_err(|error| format!("설치 작업 실패: {error}"))?
}

/// 한 번에: Git/Node + Claude/Cursor/Codex (Antigravity는 링크)
#[tauri::command]
pub async fn install_all_required_runtimes() -> Result<Vec<InstallStepResult>, String> {
    tauri::async_runtime::spawn_blocking(install_all_required_runtimes_impl)
        .await
        .map_err(|error| format!("설치 작업 실패: {error}"))?
}

/// Agent CLI 로그인 흐름 시작 (브라우저/공식 로그인 UI)
#[tauri::command]
pub fn launch_agent_login(app: tauri::AppHandle, agent: String) -> Result<String, String> {
    crate::window_stack::suppress_main_always_on_top(&app);
    let agent = AgentKind::parse(&agent)?;
    let settings = load_settings().ok();
    let saved = settings
        .as_ref()
        .and_then(|s| s.agent_path(agent).map(PathBuf::as_path));
    let binary = resolve_agent_binary(agent, saved).map_err(|error| {
        format!("{error} — 먼저 설정에서 ‘필수 프로그램 설치’를 실행하세요.")
    })?;

    match agent {
        AgentKind::Claude => {
            #[cfg(windows)]
            {
                let envs = crate::isolated_browser::cli_browser_env("claude-cli")
                    .unwrap_or_default();
                crate::windows_process::launch_visible_cli_with_env(
                    &binary,
                    &["auth", "login"],
                    &envs,
                )
                .map_err(|error| format!("Claude 로그인 실행 실패: {error}"))?;
                let _ = crate::isolated_browser::open_url("claude-cli", "https://claude.ai/login");
            }
            #[cfg(not(windows))]
            {
                Command::new(&binary)
                    .args(["auth", "login"])
                    .spawn()
                    .map_err(|error| format!("Claude 로그인 실행 실패: {error}"))?;
            }
            Ok("Claude 로그인을 시작했습니다. 기본 구글 계정과 분리된 창에서 로그인하세요.".to_string())
        }
        AgentKind::Codex => {
            #[cfg(windows)]
            {
                let envs = crate::isolated_browser::cli_browser_env("codex-cli")
                    .unwrap_or_default();
                crate::windows_process::launch_visible_cli_with_env(&binary, &["login"], &envs)
                    .or_else(|_| {
                        crate::windows_process::launch_visible_cli_with_env(&binary, &[], &envs)
                    })
                    .map_err(|error| format!("Codex 로그인 실행 실패: {error}"))?;
                let _ = crate::isolated_browser::open_url("codex-cli", "https://chatgpt.com/");
            }
            #[cfg(not(windows))]
            {
                Command::new(&binary)
                    .args(["login"])
                    .spawn()
                    .or_else(|_| Command::new(&binary).spawn())
                    .map_err(|error| format!("Codex 로그인 실행 실패: {error}"))?;
            }
            Ok("Codex 로그인을 시작했습니다. 기본 구글 계정과 분리된 창에서 로그인하세요.".to_string())
        }
        AgentKind::Cursor => {
            #[cfg(windows)]
            {
                let envs = crate::isolated_browser::cli_browser_env("cursor-cli")
                    .unwrap_or_default();
                crate::windows_process::launch_visible_cli_with_env(&binary, &[], &envs)
                    .map_err(|error| format!("Cursor 실행 실패: {error}"))?;
                let _ = crate::isolated_browser::open_url(
                    "cursor-cli",
                    "https://authenticator.cursor.sh/",
                );
            }
            #[cfg(not(windows))]
            {
                let _ = Command::new(&binary).spawn();
                let _ = Command::new("open").arg("cursor://").spawn();
            }
            Ok("Cursor 로그인을 시작했습니다. 기본 구글 계정과 분리된 창에서 로그인하세요.".to_string())
        }
        AgentKind::Antigravity => {
            #[cfg(windows)]
            {
                crate::isolated_browser::open_url(
                    "antigravity-cli",
                    "https://antigravity.google/",
                )
                .map_err(|error| format!("페이지 열기 실패: {error}"))?;
            }
            #[cfg(not(windows))]
            {
                Command::new("open")
                    .arg("https://antigravity.google/")
                    .spawn()
                    .map_err(|error| format!("페이지 열기 실패: {error}"))?;
            }
            Ok("Antigravity 페이지를 분리된 브라우저 창에서 열었습니다. 기본 구글 계정과 섞이지 않습니다.".to_string())
        }
    }
}

/// GitHub는 Gmail(Google) 로그인을 쓰므로 분리 프로필이 아니라 기본 브라우저를 엽니다.
#[tauri::command]
pub fn launch_github_login(app: tauri::AppHandle) -> Result<String, String> {
    crate::window_stack::suppress_main_always_on_top(&app);
    #[cfg(windows)]
    {
        crate::windows_setup::open_url("https://github.com/login")
            .map_err(|error| format!("GitHub 로그인 페이지 열기 실패: {error}"))?;
        let gcm = PathBuf::from(
            r"C:\Program Files\Git\mingw64\libexec\git-core\git-credential-manager.exe",
        );
        let gcm_core = PathBuf::from(
            r"C:\Program Files\Git\mingw64\libexec\git-core\git-credential-manager-core.exe",
        );
        let helper = if gcm.is_file() {
            Some(gcm)
        } else if gcm_core.is_file() {
            Some(gcm_core)
        } else {
            None
        };
        if let Some(binary) = helper {
            let _ = crate::windows_process::launch_visible_cli_with_env(
                &binary,
                &["github", "login"],
                &[],
            );
        }
        Ok("GitHub 로그인을 기본 브라우저에서 열었습니다. Gmail(Google)로 로그인하세요. 토큰을 쓰려면 키 파일에 GITHUB_TOKEN= 을 넣으면 됩니다.".to_string())
    }
    #[cfg(not(windows))]
    {
        Command::new("open")
            .arg("https://github.com/login")
            .spawn()
            .map_err(|error| format!("GitHub 로그인 페이지 열기 실패: {error}"))?;
        Ok("GitHub 로그인을 기본 브라우저에서 열었습니다. Gmail(Google)로 로그인하세요.".to_string())
    }
}
