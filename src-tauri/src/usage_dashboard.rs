use crate::settings::load_settings;
use std::env;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;

const DEFAULT_PORT: u16 = 4318;

static DASHBOARD_CHILD: Mutex<Option<Child>> = Mutex::new(None);

fn dashboard_port() -> u16 {
    env::var("AI_CHARACTER_USAGE_PORT")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn dashboard_url() -> String {
    format!("http://127.0.0.1:{}", dashboard_port())
}

fn port_is_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn wait_until_ready(port: u16, timeout: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < timeout {
        if port_is_open(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(120));
    }
    false
}

/// 새 provider API(`/api/usage`의 `providers`)가 없으면 구버전 서버로 본다.
fn dashboard_api_is_current(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request =
        format!("GET /api/usage HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut body = String::new();
    if stream.read_to_string(&mut body).is_err() {
        return false;
    }
    body.contains("\"providers\"")
}

fn kill_managed_child() {
    if let Ok(mut guard) = DASHBOARD_CHILD.lock() {
        if let Some(mut previous) = guard.take() {
            let _ = previous.kill();
            let _ = previous.wait();
        }
    }
}

fn clear_port(port: u16) {
    kill_managed_child();
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|output| {
                let pids = String::from_utf8_lossy(&output.stdout);
                for pid in pids.split_whitespace() {
                    let _ = Command::new("kill")
                        .args(["-9", pid])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                Some(())
            });
    }
    #[cfg(windows)]
    {
        let _ = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}"
                ),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    // 포트가 풀릴 때까지 잠깐 대기
    for _ in 0..20 {
        if !port_is_open(port) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn resolve_dashboard_dir() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("usage-dashboard"));
        candidates.push(cwd.join("..").join("usage-dashboard"));
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        candidates.push(PathBuf::from(manifest).join("..").join("usage-dashboard"));
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("usage-dashboard"));
            candidates.push(parent.join("..").join("usage-dashboard"));
            candidates.push(parent.join("../../../usage-dashboard"));
        }
    }

    for candidate in candidates {
        let server = candidate.join("server.mjs");
        if server.is_file() {
            return candidate
                .canonicalize()
                .or_else(|_| Ok(candidate));
        }
    }
    Err("usage-dashboard 폴더를 찾을 수 없습니다. AI-Character 프로젝트의 usage-dashboard를 확인해주세요.".to_string())
}

fn resolve_app_dir() -> Result<PathBuf, String> {
    if let Ok(settings) = load_settings() {
        if let Some(project) = settings.project_dir {
            return Ok(project.join(".ai-character"));
        }
    }
    if let Ok(cwd) = env::current_dir() {
        return Ok(cwd.join(".ai-character"));
    }
    Err("프로젝트 폴더가 지정되지 않았습니다.".to_string())
}

fn resolve_node_binary() -> Result<PathBuf, String> {
    if let Ok(custom) = env::var("AI_CHARACTER_NODE_BIN") {
        let path = PathBuf::from(custom.trim());
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Some(path_value) = env::var_os("PATH") {
        for dir in env::split_paths(&path_value) {
            for name in ["node", "nodejs"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    for dir in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ] {
        let candidate = Path::new(dir).join("node");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("Node.js를 찾을 수 없습니다. usage-dashboard 실행에 Node 22.5+ 가 필요합니다.".to_string())
}

fn spawn_dashboard_server(dashboard_dir: &Path, app_dir: &Path, port: u16) -> Result<(), String> {
    let node = resolve_node_binary()?;
    let script = dashboard_dir.join("server.mjs");
    if !script.is_file() {
        return Err(format!("서버 스크립트가 없습니다: {}", script.display()));
    }

    let mut child = Command::new(&node)
        .arg(&script)
        .current_dir(dashboard_dir)
        .env("PORT", port.to_string())
        .env("AI_CHARACTER_DIR", app_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("사용량 대시보드 실행 실패: {error}"))?;

    if !wait_until_ready(port, Duration::from_secs(8)) {
        let _ = child.kill();
        return Err(format!(
            "사용량 대시보드가 포트 {port}에서 시작되지 않았습니다. Node 버전(22.5+)을 확인해주세요."
        ));
    }

    let mut guard = DASHBOARD_CHILD
        .lock()
        .map_err(|_| "사용량 대시보드 상태 잠금에 실패했습니다.".to_string())?;
    if let Some(mut previous) = guard.take() {
        let _ = previous.kill();
    }
    *guard = Some(child);
    Ok(())
}

#[tauri::command]
pub fn open_usage_dashboard(app: tauri::AppHandle) -> Result<String, String> {
    let port = dashboard_port();
    let url = dashboard_url();

    let needs_start = !port_is_open(port) || !dashboard_api_is_current(port);
    if needs_start {
        if port_is_open(port) {
            clear_port(port);
        }
        let dashboard_dir = resolve_dashboard_dir()?;
        let app_dir = resolve_app_dir()?;
        std::fs::create_dir_all(&app_dir).map_err(|error| {
            format!(
                "앱 데이터 폴더를 만들 수 없습니다: {} ({error})",
                app_dir.display()
            )
        })?;
        spawn_dashboard_server(&dashboard_dir, &app_dir, port)?;
    }

    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|error| format!("사용량 페이지를 열 수 없습니다: {error}"))?;

    Ok(url)
}
