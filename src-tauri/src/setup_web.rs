//! Browser-based first-run setup served by the app itself (no Node.js needed).
//!
//! Security model: loopback only, a random session cookie obtained through a one-time code that
//! the app puts in the URL it opens, Host/Origin checks against DNS rebinding and cross-site
//! requests, and a custom header on every write so plain HTML forms from other sites cannot post.
//! Secret values are write-only: the page can save or clear keys but never read them back.

use crate::agent_commands::{apply_basic_preferences, BasicPreferencesPatch};
use crate::settings::{load_settings, save_settings};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const INDEX_HTML: &str = include_str!("setup_web/index.html");
const APP_JS: &str = include_str!("setup_web/app.js");
const COOKIE_NAME: &str = "aic_setup";
const CODE_TTL: Duration = Duration::from_secs(120);
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 256 * 1024;
const PROGRESS_KEY: &str = "setup.progress";
const COMPLETED_KEY: &str = "setup.completed";
const FIRST_OPEN_KEY: &str = "setup.web_opened";
const SESSION_KEY: &str = "setup.session";
/// A fixed port keeps an open setup tab working after the app restarts; a random one is the fallback.
const PREFERRED_PORT: u16 = 17321;
const SECTIONS: &[&str] = &["welcome", "folder", "keys", "accounts", "behavior", "alerts", "updates", "finish", "usage", "local", "remote", "help"];
/// SKT publishes this guest key openly for its free A.X beta; it is not a user secret.
const SKT_AX_PUBLIC_KEY: &str = "sktax-XyeKFrq67ZjS4EpsDlrHHXV8it";

struct SetupServer {
    port: u16,
    session: String,
    code: Mutex<Option<(String, Instant)>>,
}

static SERVER: OnceLock<Arc<SetupServer>> = OnceLock::new();
static START_LOCK: Mutex<()> = Mutex::new(());

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).map_err(|error| format!("난수 생성 실패: {error}"))?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn is_session_token(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// Reused across restarts so a tab that is already open keeps its login; it lives next to the
/// other user-only app settings, which any process able to read it could change anyway.
fn persistent_session() -> Result<String, String> {
    let mut settings = load_settings()?;
    if let Some(existing) = settings.extra(SESSION_KEY).filter(|value| is_session_token(value)) {
        return Ok(existing.to_string());
    }
    let session = random_hex(32)?;
    settings.set_extra(SESSION_KEY, Some(session.clone()));
    save_settings(&settings)?;
    Ok(session)
}

fn ensure_server(app: &AppHandle) -> Result<Arc<SetupServer>, String> {
    let _guard = START_LOCK.lock().map_err(|_| "설정 서버 잠금 실패".to_string())?;
    if let Some(server) = SERVER.get() {
        return Ok(server.clone());
    }
    let listener = TcpListener::bind(("127.0.0.1", PREFERRED_PORT))
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .map_err(|error| format!("설정 서버를 열 수 없습니다: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let server = Arc::new(SetupServer { port, session: persistent_session()?, code: Mutex::new(None) });
    let _ = SERVER.set(server.clone());
    let accept_server = server.clone();
    let app = app.clone();
    std::thread::Builder::new()
        .name("setup-web".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let server = accept_server.clone();
                let app = app.clone();
                let _ = std::thread::Builder::new()
                    .name("setup-web-conn".into())
                    .spawn(move || handle_connection(stream, &server, &app));
            }
        })
        .map_err(|error| format!("설정 서버 스레드 시작 실패: {error}"))?;
    Ok(server)
}

/// Starts the server if needed and opens the setup page in the default browser.
pub fn open(app: &AppHandle, section: Option<&str>) -> Result<String, String> {
    let server = ensure_server(app)?;
    let code = random_hex(24)?;
    if let Ok(mut slot) = server.code.lock() {
        *slot = Some((code.clone(), Instant::now()));
    }
    let section = section.filter(|value| SECTIONS.contains(value)).unwrap_or("welcome");
    let base = format!("http://127.0.0.1:{}/", server.port);
    let url = format!("{base}auth?code={code}&to={section}");
    crate::window_stack::suppress_main_always_on_top(app);
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|error| format!("브라우저를 열 수 없습니다: {error}"))?;
    Ok(base)
}

#[tauri::command]
pub fn open_setup_web(app: AppHandle, section: Option<String>) -> Result<String, String> {
    open(&app, section.as_deref())
}

/// Starts the server with the app so an already-open setup tab reconnects after a restart, and
/// opens the page once on the very first launch so a new user lands on guided setup.
pub fn start(app: AppHandle) {
    if let Err(error) = ensure_server(&app) {
        eprintln!("{error}");
    }
    let Ok(mut settings) = load_settings() else {
        return;
    };
    if settings.extra_bool(COMPLETED_KEY, false) || settings.extra_bool(FIRST_OPEN_KEY, false) {
        return;
    }
    settings.set_extra(FIRST_OPEN_KEY, Some("true".into()));
    if save_settings(&settings).is_err() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        if let Err(error) = open(&app, Some("welcome")) {
            eprintln!("처음 설정 페이지 열기 실패: {error}");
        }
    });
}

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    query: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn query_param(&self, name: &str) -> Option<String> {
        url::form_urlencoded::parse(self.query.as_bytes())
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }
}

fn read_request(stream: &mut impl Read) -> Result<Request, String> {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break pos;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err("header too large".into());
        }
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let target = request_line.next().unwrap_or_default();
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect();
    let length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_BODY_BYTES {
        return Err("body too large".into());
    }
    let mut body = buffer[header_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    Ok(Request { method, path: path.to_string(), query: query.to_string(), headers, body })
}

fn host_allowed(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|host| host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}"))
}

fn origin_allowed(origin: Option<&str>, port: u16) -> bool {
    match origin {
        None => true,
        Some(origin) => origin == format!("http://127.0.0.1:{port}") || origin == format!("http://localhost:{port}"),
    }
}

fn cookie_value<'a>(header: Option<&'a str>, name: &str) -> Option<&'a str> {
    header?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

/// Writes must come from our own page: same origin, JSON body and a header a cross-site form cannot set.
fn write_allowed(request: &Request, port: u16) -> bool {
    origin_allowed(request.header("origin"), port)
        && request.header("x-ai-character") == Some("setup")
        && request.header("content-type").is_some_and(|value| value.starts_with("application/json"))
        && request.header("sec-fetch-site").map_or(true, |site| site == "same-origin")
}

struct Response {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
    extra: Vec<(String, String)>,
}

impl Response {
    fn json(status: u16, value: Value) -> Self {
        Response { status, content_type: "application/json; charset=utf-8", body: value.to_string().into_bytes(), extra: vec![] }
    }

    fn text(status: u16, content_type: &'static str, body: &str) -> Self {
        Response { status, content_type, body: body.as_bytes().to_vec(), extra: vec![] }
    }

    fn error(status: u16, message: impl Into<String>) -> Self {
        Self::json(status, json!({ "error": message.into() }))
    }
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    }
}

fn write_response(stream: &mut TcpStream, response: Response) {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'\r\nConnection: close\r\n",
        response.status,
        status_text(response.status),
        response.content_type,
        response.body.len()
    );
    for (key, value) in response.extra {
        head.push_str(&format!("{key}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&response.body);
    let _ = stream.flush();
}

fn expired_page() -> Response {
    Response::text(
        401,
        "text/html; charset=utf-8",
        "<!doctype html><meta charset=utf-8><title>AI Character 설정</title><body style=\"font-family:system-ui;padding:40px;background:#0f1320;color:#e8ecf4\"><h2>링크가 만료되었습니다</h2><p>보안을 위해 설정 링크는 한 번만 쓸 수 있습니다.<br>AI Character 앱의 <b>설정 → 시작 → 웹에서 쉽게 설정</b> 또는 트레이 메뉴의 <b>처음 설정 (웹)</b>을 다시 눌러 주세요.</p></body>",
    )
}

fn handle_connection(mut stream: TcpStream, server: &SetupServer, app: &AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(_) => return,
    };
    let response = route(&request, server, app);
    write_response(&mut stream, response);
}

fn route(request: &Request, server: &SetupServer, app: &AppHandle) -> Response {
    if !host_allowed(request.header("host"), server.port) {
        return Response::error(403, "허용되지 않은 주소입니다.");
    }
    if request.method == "GET" && request.path == "/auth" {
        return authenticate(request, server);
    }
    let authorized = cookie_value(request.header("cookie"), COOKIE_NAME)
        .is_some_and(|value| constant_time_eq(value, &server.session));
    if !authorized {
        return if request.path.starts_with("/api/") { Response::error(401, "세션이 만료되었습니다. 앱에서 다시 열어 주세요.") } else { expired_page() };
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => Response::text(200, "text/html; charset=utf-8", INDEX_HTML),
        ("GET", "/app.js") => Response::text(200, "text/javascript; charset=utf-8", APP_JS),
        ("GET", "/api/usage") => {
            let days = request.query_param("days").and_then(|value| value.parse::<i64>().ok()).unwrap_or(7);
            match crate::usage_report::report(days, true) {
                Ok(value) => Response::json(200, value),
                Err(error) => Response::error(400, error),
            }
        }
        ("GET", path) if path.starts_with("/api/") => match api_get(path) {
            Ok(value) => Response::json(200, value),
            Err(error) => Response::error(400, error),
        },
        ("POST", path) if path.starts_with("/api/") => {
            if !write_allowed(request, server.port) {
                return Response::error(403, "허용되지 않은 요청입니다.");
            }
            let body: Value = match serde_json::from_slice(if request.body.is_empty() { b"{}" } else { &request.body }) {
                Ok(value) => value,
                Err(error) => return Response::error(400, format!("잘못된 요청 형식: {error}")),
            };
            match api_post(path, body, app) {
                Ok(value) => Response::json(200, value),
                Err(error) => Response::error(400, crate::policy_engine::mask_secrets(&error)),
            }
        }
        ("GET", _) | ("POST", _) => Response::error(404, "없는 주소입니다."),
        _ => Response::error(405, "지원하지 않는 요청입니다."),
    }
}

fn authenticate(request: &Request, server: &SetupServer) -> Response {
    let supplied = request.query_param("code").unwrap_or_default();
    let valid = server
        .code
        .lock()
        .ok()
        .and_then(|mut slot| {
            let matches = slot
                .as_ref()
                .is_some_and(|(code, issued)| issued.elapsed() < CODE_TTL && constant_time_eq(code, &supplied));
            matches.then(|| slot.take())
        })
        .is_some();
    if !valid {
        return expired_page();
    }
    let section = request
        .query_param("to")
        .filter(|value| SECTIONS.contains(&value.as_str()))
        .unwrap_or_else(|| "welcome".into());
    let mut response = Response::text(302, "text/plain; charset=utf-8", "");
    response.extra.push(("Location".into(), format!("/#{section}")));
    response.extra.push((
        "Set-Cookie".into(),
        format!("{COOKIE_NAME}={}; HttpOnly; SameSite=Strict; Path=/", server.session),
    ));
    response
}

fn to_json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

fn sanitize_progress(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .map(|map| {
            map.iter()
                .filter(|(key, _)| SECTIONS.contains(&key.as_str()))
                .filter_map(|(key, state)| {
                    state
                        .as_str()
                        .filter(|state| matches!(*state, "done" | "skipped"))
                        .map(|state| (key.clone(), state.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn setup_progress() -> Result<Value, String> {
    let settings = load_settings()?;
    let progress = settings
        .extra(PROGRESS_KEY)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .map(|value| sanitize_progress(&value))
        .unwrap_or_default();
    Ok(json!({ "completed": settings.extra_bool(COMPLETED_KEY, false), "progress": progress }))
}

fn state() -> Result<Value, String> {
    let build = crate::updates::updater_build_status_value();
    Ok(json!({
        "platform": std::env::consts::OS,
        "build": build,
        "projectDir": crate::agent_commands::get_project_dir()?,
        "preferences": to_json(crate::agent_commands::get_app_preferences()?)?,
        "readiness": to_json(crate::agent_commands::get_free_auto_readiness()?)?,
        "apiKeys": to_json(crate::local_env::api_key_statuses())?,
        "alerts": to_json(crate::alerts::get_alert_settings())?,
        "updates": to_json(crate::updates::get_update_settings())?,
        "setup": setup_progress()?,
        "providers": to_json(crate::agent_commands::get_automatic_provider_status()?)?,
        "freeServices": to_json(crate::provider_router::free_service_statuses())?,
        "usage": crate::alerts::get_usage_alerts().ok().map(to_json).transpose()?,
        "paths": {
            "settings": crate::settings::settings_path().ok().map(|path| path.to_string_lossy().into_owned()),
        },
    }))
}

fn export_settings() -> Result<Value, String> {
    Ok(json!({
        "kind": "ai-character-settings",
        "version": 1,
        "projectDir": crate::agent_commands::get_project_dir()?,
        "preferences": to_json(crate::agent_commands::get_app_preferences()?)?,
        "alerts": to_json(crate::alerts::get_alert_settings())?,
        "updates": to_json(crate::updates::get_update_settings())?,
    }))
}

fn api_get(path: &str) -> Result<Value, String> {
    match path {
        "/api/state" => state(),
        "/api/runtime" => to_json(crate::agent_install::get_runtime_setup_status()),
        "/api/export" => export_settings(),
        "/api/local" => Ok(tauri::async_runtime::block_on(crate::local_ai::status())),
        "/api/remote" => Ok(tauri::async_runtime::block_on(crate::remote_ai::remote_statuses())),
        _ => Err("없는 주소입니다.".into()),
    }
}

fn str_field(body: &Value, name: &str) -> Result<String, String> {
    body.get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("'{name}' 값이 필요합니다."))
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("잘못된 값: {error}"))
}

fn apply_recommended() -> Result<(), String> {
    apply_basic_preferences(BasicPreferencesPatch {
        cradle_enabled: Some(true),
        auto_web_search: Some(true),
        gemini_api_enabled: Some(true),
        allow_paid_open_ai_api: Some(false),
        warn_sensitive_files: Some(true),
        ..Default::default()
    })?;
    let mut alerts = crate::alerts::get_alert_settings();
    alerts.desktop = true;
    alerts.block_paid_over_limit = true;
    crate::alerts::set_alert_settings(alerts)?;
    Ok(())
}

fn import_settings(body: Value) -> Result<Value, String> {
    if body.get("kind").and_then(Value::as_str) != Some("ai-character-settings") {
        return Err("AI Character 설정 백업 파일이 아닙니다.".into());
    }
    let mut notes = Vec::new();
    if let Some(preferences) = body.get("preferences").cloned() {
        apply_basic_preferences(parse(preferences)?)?;
        notes.push("동작 방식");
    }
    if let Some(alerts) = body.get("alerts").cloned() {
        crate::alerts::set_alert_settings(parse(alerts)?)?;
        notes.push("알림·비용 한도");
    }
    if let Some(updates) = body.get("updates").cloned() {
        crate::updates::set_update_settings(parse(updates)?)?;
        notes.push("자동 업데이트");
    }
    let mut warning = None;
    if let Some(dir) = body.get("projectDir").and_then(Value::as_str) {
        match crate::agent_commands::set_project_dir(dir.to_string()) {
            Ok(_) => notes.push("작업 폴더"),
            Err(error) => warning = Some(format!("작업 폴더는 이 컴퓨터에 없어 건너뛰었습니다: {error}")),
        }
    }
    Ok(json!({ "applied": notes, "warning": warning }))
}

fn pick_folder(app: &AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::window_stack::suppress_main_always_on_top(app);
    let Some(picked) = app.dialog().file().set_title("작업 폴더 선택").blocking_pick_folder() else {
        return Ok(json!({ "cancelled": true }));
    };
    let path = picked.into_path().map_err(|error| format!("폴더 경로를 읽을 수 없습니다: {error}"))?;
    let saved = crate::agent_commands::set_project_dir(path.to_string_lossy().into_owned())?;
    Ok(json!({ "projectDir": saved }))
}

fn api_post(path: &str, body: Value, app: &AppHandle) -> Result<Value, String> {
    match path {
        "/api/project" => {
            let saved = crate::agent_commands::set_project_dir(str_field(&body, "path")?)?;
            Ok(json!({ "projectDir": saved }))
        }
        "/api/project/pick" => pick_folder(app),
        "/api/key" => {
            let name = str_field(&body, "name")?;
            let value = body.get("value").and_then(Value::as_str).unwrap_or_default().to_string();
            to_json(crate::local_env::save_api_key_blocking(name.trim(), value.trim())?)
        }
        "/api/key/test" => {
            let name = str_field(&body, "name")?;
            let message = tauri::async_runtime::block_on(crate::local_env::test_api_key(name))?;
            Ok(json!({ "message": message }))
        }
        "/api/key/skt-public" => to_json(crate::local_env::save_api_key_blocking("SKT_AX_API_KEY", SKT_AX_PUBLIC_KEY)?),
        "/api/local/pull" => crate::local_ai::start_pull(&str_field(&body, "model")?),
        "/api/local/delete" => tauri::async_runtime::block_on(crate::local_ai::delete_model(&str_field(&body, "model")?)),
        "/api/local/prefer" => crate::local_ai::set_preferred(body.get("model").and_then(Value::as_str).map(str::to_string)),
        "/api/local/start" => crate::local_ai::start_ollama(),
        "/api/local/install" => crate::local_ai::start_install_ollama(),
        "/api/local/disk" => crate::local_ai::set_models_dir(body.get("dir").and_then(Value::as_str).unwrap_or_default()),
        "/api/share" => crate::remote_ai::set_share(body.get("enabled").and_then(Value::as_bool).unwrap_or(false)),
        "/api/share/code" => tauri::async_runtime::block_on(crate::remote_ai::create_code()),
        "/api/share/relay" => crate::remote_ai::set_relay(
            body.get("url").and_then(Value::as_str).unwrap_or_default(),
            body.get("token").and_then(Value::as_str),
        ),
        "/api/share/relay/test" => tauri::async_runtime::block_on(crate::remote_ai::test_relay()),
        "/api/share/unpair" => crate::remote_ai::remove_paired(&str_field(&body, "id")?),
        "/api/remote/add" => tauri::async_runtime::block_on(crate::remote_ai::pair_any(
            &str_field(&body, "code")?,
            body.get("name").and_then(Value::as_str).unwrap_or_default(),
            body.get("relay").and_then(Value::as_str),
            body.get("token").and_then(Value::as_str),
        )),
        "/api/remote/remove" => crate::remote_ai::remove_remote(&str_field(&body, "id")?),
        "/api/remote/pull" => tauri::async_runtime::block_on(crate::remote_ai::start_remote_pull(&str_field(&body, "id")?, &str_field(&body, "model")?)),
        "/api/keys/open" => Ok(json!({ "path": crate::local_env::open_keys_env_file()? })),
        "/api/preferences" => to_json(apply_basic_preferences(parse(body)?)?),
        "/api/alerts" => to_json(crate::alerts::set_alert_settings(parse(body)?)?),
        "/api/updates" => to_json(crate::updates::set_update_settings(parse(body)?)?),
        "/api/recommended" => {
            apply_recommended()?;
            state()
        }
        "/api/login" => {
            let agent = str_field(&body, "agent")?;
            let message = if agent == "github" {
                crate::agent_install::launch_github_login(app.clone())?
            } else {
                crate::agent_install::launch_agent_login(app.clone(), agent)?
            };
            Ok(json!({ "message": message }))
        }
        "/api/install" => {
            let target = str_field(&body, "target")?;
            let results = if target == "all" || (target == "node" && cfg!(windows)) {
                crate::agent_install::install_all_required_runtimes_impl()?
            } else if target == "git" {
                crate::window_stack::suppress_main_always_on_top(app);
                crate::environment_preflight::launch_git_installer()?;
                vec![crate::agent_install::InstallStepResult {
                    id: "git".into(),
                    ok: true,
                    message: "Git 설치 창을 열었습니다. 설치가 끝나면 '다시 확인'을 누르세요.".into(),
                }]
            } else {
                vec![crate::agent_install::install_agent_cli_impl(target)?]
            };
            to_json(results)
        }
        "/api/setup" => {
            let mut settings = load_settings()?;
            if let Some(progress) = body.get("progress") {
                let clean = sanitize_progress(progress);
                settings.set_extra(PROGRESS_KEY, Some(serde_json::to_string(&clean).map_err(|error| error.to_string())?));
            }
            if let Some(completed) = body.get("completed").and_then(Value::as_bool) {
                settings.set_extra(COMPLETED_KEY, Some(completed.to_string()));
            }
            save_settings(&settings)?;
            setup_progress()
        }
        "/api/import" => import_settings(body),
        _ => Err("없는 주소입니다.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(raw: &str) -> Request {
        read_request(&mut raw.as_bytes()).expect("parse")
    }

    #[test]
    fn parses_request_line_headers_and_body() {
        let parsed = request("POST /api/key?x=1 HTTP/1.1\r\nHost: 127.0.0.1:5\r\nContent-Length: 11\r\n\r\n{\"a\":\"bc\"}!extra");
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, "/api/key");
        assert_eq!(parsed.query, "x=1");
        assert_eq!(parsed.header("host"), Some("127.0.0.1:5"));
        assert_eq!(parsed.body, b"{\"a\":\"bc\"}!");
    }

    #[test]
    fn rejects_oversized_bodies() {
        let raw = format!("POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY_BYTES + 1);
        assert!(read_request(&mut raw.as_bytes()).is_err());
    }

    #[test]
    fn host_and_origin_must_be_this_loopback_server() {
        assert!(host_allowed(Some("127.0.0.1:4000"), 4000));
        assert!(host_allowed(Some("localhost:4000"), 4000));
        assert!(!host_allowed(Some("evil.example:4000"), 4000));
        assert!(!host_allowed(Some("127.0.0.1:4001"), 4000));
        assert!(!host_allowed(None, 4000));
        assert!(origin_allowed(None, 4000));
        assert!(origin_allowed(Some("http://127.0.0.1:4000"), 4000));
        assert!(!origin_allowed(Some("https://evil.example"), 4000));
    }

    #[test]
    fn writes_need_custom_header_and_json() {
        let ok = request("POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:9\r\nOrigin: http://127.0.0.1:9\r\nX-AI-Character: setup\r\nContent-Type: application/json\r\nSec-Fetch-Site: same-origin\r\n\r\n");
        assert!(write_allowed(&ok, 9));
        let form = request("POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:9\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\n");
        assert!(!write_allowed(&form, 9));
        let cross = request("POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:9\r\nX-AI-Character: setup\r\nContent-Type: application/json\r\nSec-Fetch-Site: cross-site\r\n\r\n");
        assert!(!write_allowed(&cross, 9));
    }

    #[test]
    fn reads_cookie_and_compares_in_constant_time() {
        assert_eq!(cookie_value(Some("a=1; aic_setup=abc; b=2"), COOKIE_NAME), Some("abc"));
        assert_eq!(cookie_value(Some("other=1"), COOKIE_NAME), None);
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }

    #[test]
    fn progress_keeps_only_known_sections_and_states() {
        let clean = sanitize_progress(&json!({ "keys": "done", "alerts": "skipped", "bogus": "done", "folder": "maybe", "updates": 1 }));
        assert_eq!(clean.len(), 2);
        assert_eq!(clean.get("keys").map(String::as_str), Some("done"));
        assert_eq!(clean.get("alerts").map(String::as_str), Some("skipped"));
    }

    #[test]
    fn preference_patch_accepts_the_frontend_field_names() {
        let patch: BasicPreferencesPatch = serde_json::from_value(json!({ "allowPaidOpenAiApi": true, "cradleEnabled": false })).unwrap();
        assert_eq!(patch.allow_paid_open_ai_api, Some(true));
        assert_eq!(patch.cradle_enabled, Some(false));
        assert_eq!(patch.timeout_seconds, None);
    }

    #[test]
    fn state_exposes_key_status_but_never_key_values() {
        let value = api_get("/api/state").expect("state");
        for field in ["platform", "build", "preferences", "readiness", "apiKeys", "alerts", "updates", "setup"] {
            assert!(value.get(field).is_some(), "missing {field}");
        }
        for key in value["apiKeys"].as_array().expect("keys") {
            let fields: Vec<&str> = key.as_object().unwrap().keys().map(String::as_str).collect();
            assert!(fields.iter().all(|f| ["name", "label", "configured", "source", "testable"].contains(f)), "{fields:?}");
        }
        assert!(value["preferences"].get("allowPaidOpenAiApi").is_some(), "{:?}", value["preferences"]);
        let export = api_get("/api/export").expect("export");
        assert_eq!(export["kind"], "ai-character-settings");
        assert!(export.get("apiKeys").is_none());
    }

    #[test]
    fn session_tokens_must_be_full_length_hex() {
        assert!(is_session_token(&"a1".repeat(32)));
        assert!(!is_session_token("abc"));
        assert!(!is_session_token(&"zz".repeat(32)));
    }

    #[test]
    fn random_tokens_are_unique_hex() {
        let a = random_hex(16).unwrap();
        let b = random_hex(16).unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
