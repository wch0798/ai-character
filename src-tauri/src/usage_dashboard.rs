use crate::settings::load_settings;
use std::env;
use std::fs::File;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const DEFAULT_PORT: u16 = 4318;

static DASHBOARD_CHILD: Mutex<Option<Child>> = Mutex::new(None);
static DASHBOARD_AUTH: Mutex<Option<(u16, String)>> = Mutex::new(None);

fn generate_usage_token() -> Result<String, String> {
    let mut buffer = [0u8; 32];
    getrandom::getrandom(&mut buffer).map_err(|error| format!("난수 생성 실패: {error}"))?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Where the PID of the dashboard server we started is kept, so after an app restart we can
/// tell our own leftover server apart from another program that happens to use the port.
fn dashboard_pid_file() -> PathBuf {
    env::temp_dir().join("ai-character-usage-dashboard.pid")
}

fn recorded_dashboard_pid() -> Option<u32> {
    std::fs::read_to_string(dashboard_pid_file()).ok()?.trim().parse().ok()
}

fn current_usage_token() -> Option<String> {
    DASHBOARD_AUTH
        .lock()
        .ok()?
        .as_ref()
        .map(|(_, token)| token.clone())
}

fn store_usage_token(port: u16, token: String) {
    if let Ok(mut guard) = DASHBOARD_AUTH.lock() {
        *guard = Some((port, token));
    }
}

fn dashboard_public_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

fn dashboard_bootstrap_url(port: u16) -> String {
    match current_usage_token() {
        Some(token) => format!("http://127.0.0.1:{port}/auth?t={token}"),
        None => dashboard_public_url(port),
    }
}

fn dashboard_init_script(token: &str) -> String {
    format!(
        "(function(){{try{{window.__AI_CHARACTER_USAGE_TOKEN__={};}}catch(e){{}}}})();",
        serde_json::json!(token)
    )
}

fn dashboard_port() -> u16 {
    env::var("AI_CHARACTER_USAGE_PORT")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT)
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
    http_get_127(port, "/api/usage")
        .map(|body| body.contains("\"providers\""))
        .unwrap_or(false)
}

fn http_get_127(port: u16, path: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("사용량 서버 연결 실패: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let token = current_usage_token().unwrap_or_default();
    let request = format!(
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nX-AI-Character-Token: {token}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("사용량 요청 실패: {error}"))?;
    let mut body = Vec::new();
    stream
        .read_to_end(&mut body)
        .map_err(|error| format!("사용량 응답 읽기 실패: {error}"))?;
    let text = String::from_utf8_lossy(&body);
    let Some((header, rest)) = text.split_once("\r\n\r\n") else {
        return Err("사용량 서버 응답이 올바르지 않습니다.".to_string());
    };
    let status = header.lines().next().unwrap_or("");
    if !status.contains(" 200 ") && !status.ends_with(" 200") {
        return Err(format!("사용량 서버 오류: {status}"));
    }
    Ok(rest.to_string())
}

fn kill_managed_child() {
    if let Ok(mut guard) = DASHBOARD_CHILD.lock() {
        if let Some(mut previous) = guard.take() {
            crate::process_util::kill_tree(&mut previous);
            let _ = previous.wait();
        }
    }
    if let Ok(mut guard) = DASHBOARD_AUTH.lock() {
        *guard = None;
    }
}

#[cfg(windows)]
fn listening_pids_on_port(port: u16) -> std::collections::HashSet<u32> {
    let mut pids = std::collections::HashSet::new();
    let mut command = Command::new("netstat");
    crate::windows_process::hide_console(&mut command);
    let Ok(output) = command.args(["-ano", "-p", "tcp"]).output() else {
        return pids;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let needle = format!(":{port}");
    for line in text.lines() {
        let upper = line.to_ascii_uppercase();
        if !upper.contains("LISTENING") || !line.contains(&needle) {
            continue;
        }
        let Some(after) = line.split(&needle).nth(1) else {
            continue;
        };
        if after
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_digit())
        {
            continue;
        }
        if let Some(pid) = line.split_whitespace().last().and_then(|value| value.parse().ok()) {
            if pid > 0 {
                pids.insert(pid);
            }
        }
    }
    pids
}

fn wait_until_closed(port: u16) -> bool {
    for _ in 0..20 {
        if !port_is_open(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    !port_is_open(port)
}

/// Frees the port only from our own dashboard server (this run's child, or the one a previous
/// run left behind). Anything else on the port belongs to another program and is left alone:
/// 4318 is also the standard OpenTelemetry port.
fn clear_port(port: u16) -> Result<(), String> {
    kill_managed_child();
    if wait_until_closed(port) {
        return Ok(());
    }
    if let Some(pid) = recorded_dashboard_pid() {
        #[cfg(target_os = "macos")]
        {
            let listed = Command::new("lsof")
                .args(["-ti", &format!("tcp:{port}")])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
                .map(|output| {
                    String::from_utf8_lossy(&output.stdout)
                        .split_whitespace()
                        .any(|item| item.parse() == Ok(pid))
                })
                .unwrap_or(false);
            if listed {
                let _ = Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        #[cfg(windows)]
        {
            if pid != std::process::id() && listening_pids_on_port(port).contains(&pid) {
                let mut command = Command::new("taskkill");
                crate::windows_process::hide_console(&mut command);
                let _ = command
                    .args(["/PID", &pid.to_string(), "/F", "/T"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        if wait_until_closed(port) {
            return Ok(());
        }
    }
    Err(format!(
        "{port}번 포트를 다른 프로그램이 쓰고 있어 사용량 화면을 열지 못했습니다. 그 프로그램을 끄거나, 환경 변수 AI_CHARACTER_USAGE_PORT에 다른 포트 번호를 지정한 뒤 앱을 다시 시작하세요."
    ))
}

fn resolve_dashboard_dir() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(custom) = env::var("AI_CHARACTER_USAGE_DASHBOARD") {
        candidates.push(PathBuf::from(custom.trim()));
    }
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
            return candidate.canonicalize().or_else(|_| Ok(candidate));
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

fn node_semver(path: &Path) -> Option<(u32, u32)> {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        crate::windows_process::hide_console(&mut command);
    }
    let output = command.arg("-v").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn push_node_candidate(out: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_file() && !out.iter().any(|existing| existing == &path) {
        out.push(path);
    }
}

fn candidate_node_binaries() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(custom) = env::var("AI_CHARACTER_NODE_BIN") {
        push_node_candidate(&mut out, PathBuf::from(custom.trim()));
    }
    if let Some(path_value) = crate::process_util::process_path() {
        for dir in env::split_paths(&path_value) {
            for name in ["node.exe", "node"] {
                push_node_candidate(&mut out, dir.join(name));
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            push_node_candidate(
                &mut out,
                local.join("Programs").join("nodejs").join("node.exe"),
            );
        }
        if let Some(program_files) = env::var_os("ProgramFiles") {
            push_node_candidate(
                &mut out,
                PathBuf::from(program_files).join("nodejs").join("node.exe"),
            );
        }
        if let Some(home) = env::var_os("USERPROFILE") {
            push_node_candidate(
                &mut out,
                PathBuf::from(home).join(".local").join("bin").join("node.exe"),
            );
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        push_node_candidate(&mut out, Path::new(dir).join("node"));
    }
    out
}

fn dashboard_node_rank(major: u32, minor: u32) -> (u8, u32, u32) {
    // 22.5+ 를 최우선. Node 24는 Windows에서 `E:` 드라이브 realpath(EISDIR) 버그가 있다.
    let family = if major == 22 && minor >= 5 {
        2
    } else if major > 22 {
        1
    } else {
        0
    };
    (family, major, minor)
}

fn resolve_node_binary() -> Result<PathBuf, String> {
    let candidates = candidate_node_binaries();
    let mut best: Option<(PathBuf, u8, u32, u32)> = None;
    for path in &candidates {
        if let Some((major, minor)) = node_semver(path) {
            if major < 22 || (major == 22 && minor < 5) {
                continue;
            }
            let (family, major, minor) = dashboard_node_rank(major, minor);
            match &best {
                None => best = Some((path.clone(), family, major, minor)),
                Some((_, best_family, best_major, best_minor))
                    if (family, major, minor) > (*best_family, *best_major, *best_minor) =>
                {
                    best = Some((path.clone(), family, major, minor));
                }
                _ => {}
            }
        }
    }
    if let Some((path, _, _, _)) = best {
        return Ok(path);
    }
    candidates.into_iter().next().ok_or_else(|| {
        "Node.js를 찾을 수 없습니다. 사용량 대시보드는 Node 22.5+ 가 필요합니다.".to_string()
    })
}

fn compact_dashboard_error(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return String::new();
    }
    if let Some(line) = text
        .lines()
        .find(|line| line.contains("Error:") || line.contains("EISDIR") || line.contains("ENOENT"))
    {
        return line.trim().chars().take(180).collect();
    }
    text.chars().take(180).collect()
}

fn spawn_dashboard_server(dashboard_dir: &Path, app_dir: &Path, port: u16) -> Result<(), String> {
    let node = resolve_node_binary()?;
    let script = dashboard_dir.join("server.mjs");
    if !script.is_file() {
        return Err(format!("서버 스크립트가 없습니다: {}", script.display()));
    }

    let log_path = app_dir.join("usage-dashboard.log");
    let log = File::create(&log_path).map_err(|error| {
        format!(
            "사용량 로그 파일을 만들 수 없습니다: {} ({error})",
            log_path.display()
        )
    })?;
    let log_err = log
        .try_clone()
        .map_err(|error| format!("사용량 로그 복제 실패: {error}"))?;

    let token = generate_usage_token()?;
    let mut child_cmd = Command::new(&node);
    crate::process_util::apply_process_env(&mut child_cmd);
    #[cfg(windows)]
    {
        crate::windows_process::hide_console(&mut child_cmd);
    }
    let mut child = child_cmd
        .arg("server.mjs")
        .current_dir(dashboard_dir)
        .env("PORT", port.to_string())
        .env("AI_CHARACTER_DIR", app_dir)
        .env(
            "AI_CHARACTER_STATE_DB",
            crate::chat_state::state_db_path().unwrap_or_else(|_| app_dir.join("state.db")),
        )
        .env(
            "AI_CHARACTER_KEYS_FILE",
            crate::local_env::loaded_keys_path()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(crate::local_env::preferred_keys_path),
        )
        .env("AI_CHARACTER_USAGE_TOKEN", &token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|error| format!("사용량 대시보드 실행 실패: {error}"))?;

    store_usage_token(port, token);
    let _ = std::fs::write(dashboard_pid_file(), child.id().to_string());

    if !wait_until_ready(port, Duration::from_secs(8)) {
        let _ = child.kill();
        if let Ok(mut guard) = DASHBOARD_AUTH.lock() {
            *guard = None;
        }
        let details = compact_dashboard_error(
            &std::fs::read_to_string(&log_path).unwrap_or_default(),
        );
        return Err(if details.is_empty() {
            format!(
                "사용량 대시보드가 포트 {port}에서 시작되지 않았습니다. Node 22.5+ 를 확인해주세요."
            )
        } else {
            format!("사용량 대시보드가 시작되지 않았습니다: {details}")
        });
    }

    let mut guard = DASHBOARD_CHILD
        .lock()
        .map_err(|_| "사용량 대시보드 상태 잠금에 실패했습니다.".to_string())?;
    if let Some(mut previous) = guard.take() {
        crate::process_util::kill_tree(&mut previous);
    }
    *guard = Some(child);
    Ok(())
}

fn ensure_dashboard_running() -> Result<u16, String> {
    let port = dashboard_port();
    let token_ok = current_usage_token().is_some();
    let needs_start = !port_is_open(port) || !token_ok || !dashboard_api_is_current(port);
    if needs_start {
        if port_is_open(port) {
            clear_port(port)?;
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
    Ok(port)
}

fn read_usage_snapshot() -> Result<serde_json::Value, String> {
    let port = ensure_dashboard_running()?;
    let body = http_get_127(port, "/api/usage")?;
    serde_json::from_str(&body).map_err(|error| format!("사용량 JSON 파싱 실패: {error}"))
}

fn restore_main_always_on_top(app: &tauri::AppHandle) {
    crate::window_stack::restore_main_always_on_top(app);
}

fn open_dashboard_window(
    app: &tauri::AppHandle,
    url: &str,
    token: Option<&str>,
) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|error| format!("사용량 URL 파싱 실패: {error}"))?;
    crate::window_stack::suppress_main_always_on_top(app);
    if let Some(existing) = app.get_webview_window("usage-dashboard") {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_always_on_top(true);
        let _ = existing.set_focus();
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(app, "usage-dashboard", WebviewUrl::External(parsed))
        .title("AI-Character 계정 사용량")
        .inner_size(1120.0, 820.0)
        .resizable(true)
        .always_on_top(true)
        .visible(true);
    if let Some(token) = token {
        builder = builder.initialization_script(dashboard_init_script(token));
    }
    let window = builder
        .build()
        .map_err(|error| format!("사용량 페이지를 열 수 없습니다: {error}"))?;

    let app_for_close = app.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
        ) {
            restore_main_always_on_top(&app_for_close);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn open_usage_dashboard(app: tauri::AppHandle) -> Result<String, String> {
    let port = tauri::async_runtime::spawn_blocking(ensure_dashboard_running)
        .await
        .map_err(|error| format!("사용량 서버 시작 실패: {error}"))??;
    let url = dashboard_public_url(port);
    let token = current_usage_token();
    if let Err(error) = open_dashboard_window(&app, &url, token.as_deref()) {
        restore_main_always_on_top(&app);
        let fallback = dashboard_bootstrap_url(port);
        app.opener()
            .open_url(&fallback, None::<&str>)
            .map_err(|open_error| format!("{error} / 브라우저 열기 실패: {open_error}"))?;
    }
    Ok(url)
}

#[tauri::command]
pub async fn get_usage_snapshot() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(read_usage_snapshot)
        .await
        .map_err(|error| format!("사용량 불러오기 실패: {error}"))?
}
