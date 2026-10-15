//! Using another computer's local AI over an encrypted iroh connection.
//!
//! Ollama never listens on the network. The sharing computer accepts iroh connections only from
//! computers paired with a one-time connection code and forwards a short list of Ollama paths to
//! 127.0.0.1:11434. The using computer opens a 127.0.0.1 tunnel per paired computer, so the rest
//! of the app talks plain HTTP to `http://127.0.0.1:<port>`.

use base64::Engine;
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayConfig, RelayMap, RelayMode, RelayUrl, SecretKey, TransportAddr};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const OLLAMA_PORT: u16 = 11434;
const ALPN: &[u8] = b"ai-character/share/1";
const SHARE_ENABLED_KEY: &str = "local.share_enabled";
const SECRET_KEY_KEY: &str = "share.secret_key";
const RELAY_URL_KEY: &str = "share.relay_url";
const RELAY_TOKEN_KEY: &str = "share.relay_token";
const PAIRED_KEY: &str = "share.paired";
const REMOTES_KEY: &str = "share.remotes";
const LEGACY_CODE_KEY: &str = "local.share_code";
const LEGACY_REMOTES_KEY: &str = "local.remotes";
const STATUS_PATH: &str = "/ai-character/status";
const PAIR_PATH: &str = "/ai-character/pair";
const TICKET_PREFIX: &str = "AIC1.";
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LIFETIME: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING_CODES: usize = 5;
const MAX_REMOTES: usize = 8;
const MAX_PAIRED: usize = 16;
const MAX_HEAD: usize = 16 * 1024;
const MAX_PAIR_BODY: usize = 4096;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const SHORT_ID_DOMAIN: &str = "aic-short-id/1:";
const SHORT_KEY_DOMAIN: &str = "aic-short-key/1:";
const RELAY_API_TIMEOUT: Duration = Duration::from_secs(10);
/// Hole punching usually finishes within a few seconds; the path is reported after this.
const PATH_SETTLE: Duration = Duration::from_secs(8);

/// Ollama paths a paired computer may use; everything else (delete, create, push...) is refused.
const ALLOWED_PATHS: &[(&str, &str)] = &[
    ("GET", "/api/version"),
    ("GET", "/api/tags"),
    ("POST", "/api/show"),
    ("POST", "/api/pull"),
    ("GET", "/v1/models"),
    ("POST", "/v1/chat/completions"),
];

struct Net {
    endpoint: Endpoint,
    relays: String,
}

static NET: tokio::sync::Mutex<Option<Net>> = tokio::sync::Mutex::const_new(None);
static CONNS: LazyLock<Mutex<HashMap<String, Connection>>> = LazyLock::new(Default::default);
static TUNNELS: LazyLock<Mutex<HashMap<String, u16>>> = LazyLock::new(Default::default);
static PENDING: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());
static ONLINE: Mutex<Option<String>> = Mutex::new(None);
static HEALTH_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Relay {
    url: String,
    #[serde(default)]
    token: String,
}

/// A computer this one uses (client side).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Remote {
    pub name: String,
    pub id: String,
    #[serde(default)]
    pub relay: Option<String>,
    #[serde(default)]
    pub relay_token: String,
    #[serde(default)]
    pub addrs: Vec<String>,
}

/// A computer allowed to use this one (sharing side).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Paired {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub added: u64,
}

/// What a connection code carries: who to dial, where, and the one-time pairing secret.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Ticket {
    pub v: u8,
    pub n: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub t: String,
    #[serde(default)]
    pub a: Vec<String>,
    pub s: String,
}

fn settings() -> Result<crate::settings::AppSettings, String> {
    crate::settings::load_settings()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0)
}

pub fn share_enabled() -> bool {
    settings().map(|settings| settings.extra_bool(SHARE_ENABLED_KEY, false)).unwrap_or(false)
}

fn list_setting<T: for<'de> Deserialize<'de>>(key: &str) -> Vec<T> {
    settings()
        .ok()
        .and_then(|settings| settings.extra(key).and_then(|raw| serde_json::from_str(raw).ok()))
        .unwrap_or_default()
}

fn save_list<T: Serialize>(key: &str, list: &[T]) -> Result<(), String> {
    let mut settings = settings()?;
    let value = if list.is_empty() { None } else { Some(serde_json::to_string(list).map_err(|error| error.to_string())?) };
    settings.set_extra(key, value);
    crate::settings::save_settings(&settings)
}

pub fn remotes() -> Vec<Remote> {
    list_setting(REMOTES_KEY)
}

pub fn paired() -> Vec<Paired> {
    list_setting(PAIRED_KEY)
}

fn is_paired(id: &str) -> bool {
    paired().iter().any(|peer| peer.id == id)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex32(text: &str) -> Option<[u8; 32]> {
    let text = text.trim();
    if text.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(text.get(index * 2..index * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// The endpoint key identifies this computer to paired computers, so it must survive restarts.
fn secret_key() -> Result<SecretKey, String> {
    let mut settings = settings()?;
    if let Some(bytes) = settings.extra(SECRET_KEY_KEY).and_then(unhex32) {
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let key = SecretKey::generate();
    settings.set_extra(SECRET_KEY_KEY, Some(hex(&key.to_bytes())));
    crate::settings::save_settings(&settings)?;
    Ok(key)
}

fn new_code(len: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; len];
    getrandom::getrandom(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| CODE_ALPHABET[*byte as usize % CODE_ALPHABET.len()] as char).collect())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.bytes().zip(right.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn host_name() -> String {
    let name = if cfg!(target_os = "macos") {
        std::process::Command::new("scutil")
            .args(["--get", "ComputerName"])
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else if cfg!(windows) {
        std::env::var("COMPUTERNAME").ok()
    } else {
        std::fs::read_to_string("/etc/hostname").ok().map(|name| name.trim().to_string())
    };
    name.filter(|name| !name.is_empty()).map(|name| clean_name(&name)).unwrap_or_else(|| "내 컴퓨터".into())
}

fn clean_name(name: &str) -> String {
    name.trim().chars().filter(|c| !c.is_control()).take(40).collect()
}

// ---------------------------------------------------------------- relay server setting

/// Accepts `relay.example.com`, `https://relay.example.com` (and `http://` only for local tests).
pub fn normalize_relay_url(input: &str) -> Result<Option<String>, String> {
    let text = input.trim().trim_end_matches('/');
    if text.is_empty() {
        return Ok(None);
    }
    let with_scheme = if text.contains("://") { text.to_string() } else { format!("https://{text}") };
    let url = url::Url::parse(&with_scheme).map_err(|_| "중계 서버 주소를 이해하지 못했습니다. relay.내도메인.com 처럼 넣어 주세요.".to_string())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let local = matches!(host.as_str(), "localhost" | "127.0.0.1");
    if host.is_empty() || !(url.scheme() == "https" || (url.scheme() == "http" && local)) {
        return Err("중계 서버 주소는 https:// 로 시작해야 합니다.".into());
    }
    if url.path() != "/" || url.query().is_some() || !url.username().is_empty() {
        return Err("중계 서버 주소에는 도메인만 넣어 주세요 (뒤에 /경로 없이).".into());
    }
    Ok(Some(url.to_string()))
}

fn own_relay() -> Option<Relay> {
    let settings = settings().ok()?;
    let url = settings.extra(RELAY_URL_KEY).filter(|url| !url.is_empty())?.to_string();
    Some(Relay { url, token: settings.extra(RELAY_TOKEN_KEY).unwrap_or_default().to_string() })
}

/// Our relay plus the relays named in paired computers' codes (with their access tokens).
fn relay_list() -> Vec<Relay> {
    let mut list: Vec<Relay> = own_relay().into_iter().collect();
    for remote in remotes() {
        if let Some(url) = remote.relay.filter(|url| !list.iter().any(|relay| relay.url == *url)) {
            list.push(Relay { url, token: remote.relay_token });
        }
    }
    list
}

fn relay_config(relay: &Relay) -> Option<RelayConfig> {
    let url: RelayUrl = relay.url.parse().ok()?;
    let config = RelayConfig::from(url);
    Some(if relay.token.is_empty() { config } else { config.with_auth_token(relay.token.clone()) })
}

fn relay_mode(list: &[Relay]) -> RelayMode {
    let configs: Vec<RelayConfig> = list.iter().filter_map(relay_config).collect();
    if configs.is_empty() {
        RelayMode::Disabled
    } else {
        RelayMode::Custom(configs.into_iter().collect::<RelayMap>())
    }
}

pub fn set_relay(url: &str, token: Option<&str>) -> Result<Value, String> {
    let url = normalize_relay_url(url)?;
    let mut settings = settings()?;
    settings.set_extra(RELAY_URL_KEY, url.clone());
    if let Some(token) = token {
        let token = token.trim();
        if token.chars().any(|c| c.is_whitespace() || c.is_control()) || token.len() > 200 {
            return Err("접속 암호에는 띄어쓰기 없이 영문·숫자만 넣어 주세요.".into());
        }
        settings.set_extra(RELAY_TOKEN_KEY, (!token.is_empty()).then(|| token.to_string()));
    }
    if url.is_none() {
        settings.set_extra(RELAY_TOKEN_KEY, None);
    }
    crate::settings::save_settings(&settings)?;
    Ok(json!({
        "share": share_status(),
        "message": if url.is_some() { "중계 서버를 저장했습니다. '연결 확인'으로 접속되는지 확인해 보세요." } else { "중계 서버를 지웠습니다. 같은 공유기 안에서만 연결됩니다." },
    }))
}

pub async fn test_relay() -> Result<Value, String> {
    if own_relay().is_none() {
        return Err("먼저 중계 서버 주소를 넣고 저장해 주세요.".into());
    }
    let endpoint = endpoint().await?;
    match tokio::time::timeout(Duration::from_secs(10), endpoint.online()).await {
        Ok(()) => Ok(json!({ "ok": true, "message": "중계 서버에 연결됐습니다. 밖에 있는 컴퓨터와도 연결할 수 있습니다." })),
        Err(_) => Err("중계 서버에 연결하지 못했습니다. 주소, 접속 암호, 서버가 켜져 있는지(443·80 포트) 확인해 주세요.".into()),
    }
}

// ---------------------------------------------------------------- relay server helpers (aic-relay)

async fn relay_call(relay: &Relay, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<(u16, Value), String> {
    let client = reqwest::Client::builder().timeout(RELAY_API_TIMEOUT).build().map_err(|error| error.to_string())?;
    let url = format!("{}/aic/v1{path}", relay.url.trim_end_matches('/'));
    let mut builder = client.request(method, url).bearer_auth(&relay.token);
    if let Some(body) = body {
        builder = builder.header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string());
    }
    let response = builder.send().await.map_err(|_| "중계 서버에 연결하지 못했습니다. 인터넷 연결과 중계 서버가 켜져 있는지 확인해 주세요.".to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

fn relay_refusal(status: u16) -> String {
    match status {
        401 => "중계 서버 접속 암호가 맞지 않습니다.".into(),
        429 => "틀린 암호나 코드를 너무 많이 보내 중계 서버가 이 인터넷 주소를 30분 동안 막았습니다. 서버 관리 화면에서 풀 수도 있습니다.".into(),
        404 => "이 중계 서버는 6자리 코드를 지원하지 않습니다. 중계 서버를 최신 버전으로 업데이트하거나 긴 연결 코드를 쓰세요.".into(),
        _ => format!("중계 서버가 요청을 거절했습니다 (HTTP {status})."),
    }
}

/// Six digits, shown as "123 456".
fn short_digits() -> Result<String, String> {
    loop {
        let mut bytes = [0u8; 4];
        getrandom::getrandom(&mut bytes).map_err(|error| error.to_string())?;
        let value = u32::from_le_bytes(bytes);
        if value < u32::MAX - u32::MAX % 1_000_000 {
            return Ok(format!("{:06}", value % 1_000_000));
        }
    }
}

/// `"123 456"`, `"123-456"` and `"123456"` all mean the same code.
pub fn normalize_short_code(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit() || c == ' ' || c == '-') {
        return None;
    }
    let digits: String = trimmed.chars().filter(char::is_ascii_digit).collect();
    (digits.len() == 6).then_some(digits)
}

fn short_hash(domain: &str, digits: &str) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(format!("{domain}{digits}").as_bytes()).into()
}

/// The relay looks boxes up by this; it never receives the digits.
pub fn short_id(digits: &str) -> String {
    hex(&short_hash(SHORT_ID_DOMAIN, digits))
}

pub fn seal_ticket(digits: &str, ticket: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&short_hash(SHORT_KEY_DOMAIN, digits)).map_err(|error| error.to_string())?;
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce).map_err(|error| error.to_string())?;
    let sealed = cipher.encrypt(aes_gcm::Nonce::from_slice(&nonce), ticket.as_bytes()).map_err(|error| error.to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([nonce.as_slice(), &sealed].concat()))
}

pub fn open_ticket(digits: &str, sealed: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    let bad = || "받은 연결 정보를 풀지 못했습니다. 새 코드를 만들어 다시 시도해 주세요.".to_string();
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(sealed).map_err(|_| bad())?;
    if raw.len() < 12 + 16 {
        return Err(bad());
    }
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&short_hash(SHORT_KEY_DOMAIN, digits)).map_err(|_| bad())?;
    let plain = cipher.decrypt(aes_gcm::Nonce::from_slice(&raw[..12]), &raw[12..]).map_err(|_| bad())?;
    String::from_utf8(plain).map_err(|_| bad())
}

/// Leaves the long code on our relay under a fresh 6-digit number.
async fn publish_short_code(relay: &Relay, ticket: &str) -> Result<String, String> {
    for _ in 0..5 {
        let digits = short_digits()?;
        let body = json!({ "id": short_id(&digits), "sealed": seal_ticket(&digits, ticket)?, "minutes": CODE_LIFETIME.as_secs() / 60 });
        match relay_call(relay, reqwest::Method::POST, "/codes", Some(&body)).await? {
            (200, _) => return Ok(format!("{} {}", &digits[..3], &digits[3..])),
            (409, _) => continue,
            (status, _) => return Err(relay_refusal(status)),
        }
    }
    Err("6자리 코드를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.".into())
}

/// The relay to fetch a 6-digit code from: the one typed in, else ours, else one a paired computer uses.
fn short_code_relay(url: Option<&str>, token: Option<&str>) -> Result<Relay, String> {
    if let Some(url) = normalize_relay_url(url.unwrap_or_default())? {
        let token = token.map(str::trim).unwrap_or_default();
        if token.is_empty() {
            return Err("중계 서버 접속 암호도 넣어 주세요.".into());
        }
        return Ok(Relay { url, token: token.to_string() });
    }
    own_relay()
        .filter(|relay| !relay.token.is_empty())
        .or_else(|| remotes().into_iter().find_map(|remote| remote.relay.filter(|_| !remote.relay_token.is_empty()).map(|url| Relay { url, token: remote.relay_token })))
        .ok_or_else(|| "6자리 코드는 중계 서버를 거쳐 전달됩니다. 이 컴퓨터에 아직 중계 서버 정보가 없으니, 아래 '중계 서버 주소·접속 암호'를 함께 넣거나 긴 연결 코드를 붙여 넣어 주세요.".to_string())
}

/// Which way a connection currently flows: straight between the two computers, or through the relay.
fn path_kind(conn: &Connection) -> Option<(&'static str, u128)> {
    let paths = conn.paths();
    let selected = paths.iter().find(|path| path.is_selected())?;
    let kind = if selected.is_relay() { "relay" } else { "direct" };
    Some((kind, selected.rtt().as_millis()))
}

/// Tells the remote's relay whether this connection ended up direct, for the relay's statistics.
fn report_path_later(remote: &Remote, conn: Connection) {
    let Some(url) = remote.relay.clone().filter(|_| !remote.relay_token.is_empty()) else { return };
    let relay = Relay { url, token: remote.relay_token.clone() };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PATH_SETTLE).await;
        if let Some((kind, _)) = path_kind(&conn) {
            let _ = relay_call(&relay, reqwest::Method::POST, "/paths", Some(&json!({ "path": kind }))).await;
        }
    });
}

/// Online state per remote id, asked from each remote's relay. Remotes whose relay doesn't answer are left out.
async fn presence(list: &[Remote]) -> HashMap<String, (bool, u64)> {
    let mut groups: HashMap<(String, String), Vec<String>> = HashMap::new();
    for remote in list {
        if let Some(url) = remote.relay.clone().filter(|_| !remote.relay_token.is_empty()) {
            groups.entry((url, remote.relay_token.clone())).or_default().push(remote.id.clone());
        }
    }
    let mut out = HashMap::new();
    for ((url, token), ids) in groups {
        let Ok((200, value)) = relay_call(&Relay { url, token }, reqwest::Method::POST, "/presence", Some(&json!({ "ids": ids }))).await else { continue };
        for id in ids {
            let device = &value["devices"][&id];
            if let Some(online) = device["online"].as_bool() {
                out.insert(id, (online, device["lastSeen"].as_u64().unwrap_or(0)));
            }
        }
    }
    out
}

// ---------------------------------------------------------------- endpoint

/// Binds (or re-binds after a relay change) the one iroh endpoint this app uses for both roles.
async fn endpoint() -> Result<Endpoint, String> {
    let relays = relay_list();
    let fingerprint = serde_json::to_string(&relays).unwrap_or_default();
    let mut net = NET.lock().await;
    if let Some(current) = net.as_ref() {
        if current.relays == fingerprint && !current.endpoint.is_closed() {
            return Ok(current.endpoint.clone());
        }
    }
    if let Some(old) = net.take() {
        old.endpoint.close().await;
    }
    CONNS.lock().map_err(|error| error.to_string())?.clear();
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(secret_key()?)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(relay_mode(&relays))
        .bind()
        .await
        .map_err(|error| format!("연결 준비에 실패했습니다: {error}"))?;
    tauri::async_runtime::spawn(accept_loop(endpoint.clone()));
    *net = Some(Net { endpoint: endpoint.clone(), relays: fingerprint });
    Ok(endpoint)
}

/// Re-applies sharing and reconnects to paired computers after the app (or computer) restarts.
pub fn on_startup() {
    clear_legacy_share();
    if share_enabled() || !remotes().is_empty() {
        tauri::async_runtime::spawn(async {
            let _ = endpoint().await;
        });
    }
    if !remotes().is_empty() {
        ensure_health_loop();
    }
}

/// The old LAN share opened Ollama on 0.0.0.0 with an 8-letter code; close that once.
fn clear_legacy_share() {
    let Ok(mut settings) = settings() else { return };
    if settings.extra(LEGACY_CODE_KEY).is_none() && settings.extra(LEGACY_REMOTES_KEY).is_none() {
        return;
    }
    settings.set_extra(LEGACY_CODE_KEY, None);
    settings.set_extra(LEGACY_REMOTES_KEY, None);
    if crate::settings::save_settings(&settings).is_ok() {
        crate::local_ai::clear_shared_ollama_host();
    }
}

// ---------------------------------------------------------------- sharing side

pub fn share_status() -> Value {
    let id = settings().ok().and_then(|settings| settings.extra(SECRET_KEY_KEY).and_then(unhex32)).map(|bytes| SecretKey::from_bytes(&bytes).public().fmt_short().to_string());
    let relay = own_relay();
    let pending = PENDING.lock().map(|pending| pending.iter().filter(|(_, created)| created.elapsed() < CODE_LIFETIME).count()).unwrap_or(0);
    json!({
        "enabled": share_enabled(),
        "name": host_name(),
        "id": id,
        "relay": relay.as_ref().map(|relay| relay.url.clone()),
        "relayHasToken": relay.as_ref().is_some_and(|relay| !relay.token.is_empty()),
        "paired": paired(),
        "pendingCodes": pending,
        "codeMinutes": CODE_LIFETIME.as_secs() / 60,
    })
}

pub fn set_share(enabled: bool) -> Result<Value, String> {
    let mut settings = settings()?;
    settings.set_extra(SHARE_ENABLED_KEY, Some(enabled.to_string()));
    crate::settings::save_settings(&settings)?;
    if enabled {
        tauri::async_runtime::spawn(async {
            let _ = endpoint().await;
        });
    } else if let Ok(mut pending) = PENDING.lock() {
        pending.clear();
    }
    Ok(json!({
        "share": share_status(),
        "message": if enabled {
            "공유를 켰습니다. '연결 코드 만들기'로 코드를 만들어 다른 컴퓨터에 넣어 주세요."
        } else {
            "공유를 껐습니다. 연결된 컴퓨터도 더 이상 쓸 수 없습니다 (다시 켜면 그대로 이어집니다)."
        },
    }))
}

pub fn encode_ticket(ticket: &Ticket) -> String {
    let json = serde_json::to_vec(ticket).unwrap_or_default();
    format!("{TICKET_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json))
}

pub fn decode_ticket(code: &str) -> Result<Ticket, String> {
    let bad = || "연결 코드가 올바르지 않습니다. AIC1. 로 시작하는 코드를 빠짐없이 복사해 붙여 넣어 주세요.".to_string();
    let compact: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    let body = compact.strip_prefix(TICKET_PREFIX).ok_or_else(bad)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body).map_err(|_| bad())?;
    let ticket: Ticket = serde_json::from_slice(&raw).map_err(|_| bad())?;
    if ticket.v != 1 {
        return Err("이 연결 코드는 다른 버전의 AI Character에서 만들었습니다. 두 컴퓨터 모두 최신으로 업데이트해 주세요.".into());
    }
    if ticket.id.parse::<EndpointId>().is_err() || ticket.s.len() < 16 || ticket.a.iter().any(|addr| addr.parse::<SocketAddr>().is_err()) {
        return Err(bad());
    }
    if let Some(relay) = &ticket.r {
        normalize_relay_url(relay).map_err(|_| bad())?;
    }
    Ok(ticket)
}

/// Makes a one-time connection code (valid for 10 minutes) for another computer.
pub async fn create_code() -> Result<Value, String> {
    if !share_enabled() {
        set_share(true)?;
    }
    let endpoint = endpoint().await?;
    if own_relay().is_some() {
        let _ = tokio::time::timeout(Duration::from_secs(5), endpoint.online()).await;
    }
    let mut addrs = Vec::new();
    for _ in 0..20 {
        addrs = endpoint.addr().ip_addrs().map(ToString::to_string).collect();
        if !addrs.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let secret = new_code(20)?;
    {
        let mut pending = PENDING.lock().map_err(|error| error.to_string())?;
        pending.retain(|(_, created)| created.elapsed() < CODE_LIFETIME);
        if pending.len() >= MAX_PENDING_CODES {
            pending.remove(0);
        }
        pending.push((secret.clone(), Instant::now()));
    }
    let relay = own_relay();
    let ticket = Ticket {
        v: 1,
        n: host_name(),
        id: endpoint.id().to_string(),
        r: relay.as_ref().map(|relay| relay.url.clone()),
        t: relay.as_ref().map(|relay| relay.token.clone()).unwrap_or_default(),
        a: addrs,
        s: secret,
    };
    let code = encode_ticket(&ticket);
    let (short, short_error) = match relay.as_ref().filter(|relay| !relay.token.is_empty()) {
        Some(relay) => match publish_short_code(relay, &code).await {
            Ok(short) => (Some(short), None),
            Err(error) => (None, Some(error)),
        },
        None => (None, None),
    };
    Ok(json!({
        "code": code,
        "short": short,
        "shortError": short_error,
        "minutes": CODE_LIFETIME.as_secs() / 60,
        "viaRelay": ticket.r.is_some(),
        "share": share_status(),
    }))
}

fn take_pending(secret: &str) -> bool {
    let Ok(mut pending) = PENDING.lock() else { return false };
    pending.retain(|(_, created)| created.elapsed() < CODE_LIFETIME);
    match pending.iter().position(|(code, _)| constant_time_eq(code, secret)) {
        Some(index) => {
            pending.remove(index);
            true
        }
        None => false,
    }
}

pub fn remove_paired(id: &str) -> Result<Value, String> {
    let mut list = paired();
    list.retain(|peer| peer.id != id);
    save_list(PAIRED_KEY, &list)?;
    Ok(json!({ "share": share_status(), "message": "연결을 끊었습니다. 그 컴퓨터는 새 연결 코드 없이는 다시 쓸 수 없습니다." }))
}

async fn accept_loop(endpoint: Endpoint) {
    while let Some(incoming) = endpoint.accept().await {
        tauri::async_runtime::spawn(async move {
            let Ok(accepting) = incoming.accept() else { return };
            if let Ok(conn) = accepting.await {
                serve_connection(conn).await;
            }
        });
    }
}

async fn serve_connection(conn: Connection) {
    if !share_enabled() {
        conn.close(1u32.into(), b"sharing is off");
        return;
    }
    let peer = conn.remote_id().to_string();
    while let Ok((send, recv)) = conn.accept_bi().await {
        tauri::async_runtime::spawn(serve_stream(peer.clone(), send, recv));
    }
}

#[derive(Debug, PartialEq)]
pub struct RequestHead {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub len: usize,
}

impl RequestHead {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    fn route(&self) -> &str {
        self.path.split('?').next().unwrap_or_default()
    }
}

pub fn parse_head(buffer: &[u8]) -> Option<RequestHead> {
    let end = buffer.windows(4).position(|window| window == b"\r\n\r\n")?;
    let text = std::str::from_utf8(&buffer[..end]).ok()?;
    let mut lines = text.split("\r\n");
    let mut parts = lines.next()?.split(' ');
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    if !parts.next()?.starts_with("HTTP/1.") || !path.starts_with('/') {
        return None;
    }
    let headers = lines.filter_map(|line| line.split_once(':')).map(|(key, value)| (key.trim().to_string(), value.trim().to_string())).collect();
    Some(RequestHead { method, path, headers, len: end + 4 })
}

pub fn allowed(method: &str, route: &str) -> bool {
    ALLOWED_PATHS.iter().any(|(allowed_method, allowed_route)| *allowed_method == method && *allowed_route == route)
}

/// One request per stream: Ollama sees a local request and closes the connection when done.
pub fn forwarded_head(head: &RequestHead) -> String {
    const DROPPED: &[&str] = &["host", "connection", "keep-alive", "origin", "referer", "upgrade", "proxy-connection", "proxy-authorization"];
    let mut out = format!("{} {} HTTP/1.1\r\nHost: 127.0.0.1:{OLLAMA_PORT}\r\n", head.method, head.path);
    for (key, value) in &head.headers {
        if !DROPPED.iter().any(|dropped| key.eq_ignore_ascii_case(dropped)) {
            out.push_str(&format!("{key}: {value}\r\n"));
        }
    }
    out.push_str("Connection: close\r\n\r\n");
    out
}

async fn read_head(recv: &mut RecvStream) -> Option<(RequestHead, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(head) = parse_head(&buffer) {
            let rest = buffer.split_off(head.len);
            return Some((head, rest));
        }
        if buffer.len() > MAX_HEAD {
            return None;
        }
        let read = tokio::time::timeout(Duration::from_secs(15), AsyncReadExt::read(recv, &mut chunk)).await.ok()?.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

async fn respond(send: &mut SendStream, status: &str, body: &str) {
    let text = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = AsyncWriteExt::write_all(send, text.as_bytes()).await;
    let _ = send.finish();
}

fn error_body(message: &str) -> String {
    json!({ "error": message }).to_string()
}

async fn serve_stream(peer: String, mut send: SendStream, mut recv: RecvStream) {
    let Some((head, rest)) = read_head(&mut recv).await else {
        return respond(&mut send, "400 Bad Request", &error_body("bad request")).await;
    };
    if !share_enabled() {
        return respond(&mut send, "403 Forbidden", &error_body("이 컴퓨터의 공유가 꺼져 있습니다.")).await;
    }
    if head.method == "POST" && head.route() == PAIR_PATH {
        return serve_pair(&peer, &head, rest, &mut send, &mut recv).await;
    }
    if !is_paired(&peer) {
        return respond(&mut send, "403 Forbidden", &error_body("연결되지 않은 컴퓨터입니다. 새 연결 코드로 다시 연결해 주세요.")).await;
    }
    if head.method == "GET" && head.route() == STATUS_PATH {
        let value = crate::local_ai::shared_status().await;
        return respond(&mut send, "200 OK", &value.to_string()).await;
    }
    if !allowed(&head.method, head.route()) {
        return respond(&mut send, "403 Forbidden", &error_body("공유에서 허용되지 않은 기능입니다.")).await;
    }
    proxy(OLLAMA_PORT, &head, rest, send, recv).await;
}

async fn proxy(port: u16, head: &RequestHead, rest: Vec<u8>, mut send: SendStream, mut recv: RecvStream) {
    let Ok(ollama) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await else {
        return respond(&mut send, "502 Bad Gateway", &error_body("그 컴퓨터의 Ollama가 꺼져 있습니다.")).await;
    };
    let (mut ollama_read, mut ollama_write) = ollama.into_split();
    if ollama_write.write_all(forwarded_head(head).as_bytes()).await.is_err() || ollama_write.write_all(&rest).await.is_err() {
        return respond(&mut send, "502 Bad Gateway", &error_body("Ollama에 요청을 보내지 못했습니다.")).await;
    }
    // Ollama cancels a request when its socket is half-closed, so the write side stays open
    // until the answer is finished.
    let upload = async {
        let _ = tokio::io::copy(&mut recv, &mut ollama_write).await;
        std::future::pending::<()>().await;
    };
    tokio::select! {
        _ = tokio::io::copy(&mut ollama_read, &mut send) => {}
        _ = upload => {}
    }
    let _ = send.finish();
}

async fn serve_pair(peer: &str, head: &RequestHead, mut body: Vec<u8>, send: &mut SendStream, recv: &mut RecvStream) {
    let length = head.header("content-length").and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
    if length > MAX_PAIR_BODY {
        return respond(send, "413 Payload Too Large", &error_body("too large")).await;
    }
    let mut chunk = [0u8; 1024];
    while body.len() < length {
        match tokio::time::timeout(Duration::from_secs(10), AsyncReadExt::read(recv, &mut chunk)).await {
            Ok(Ok(read)) if read > 0 => body.extend_from_slice(&chunk[..read]),
            _ => break,
        }
    }
    let request: Value = serde_json::from_slice(&body[..body.len().min(length)]).unwrap_or(Value::Null);
    let secret = request.get("secret").and_then(Value::as_str).unwrap_or_default();
    if !take_pending(secret) {
        tokio::time::sleep(Duration::from_millis(500)).await;
        return respond(send, "401 Unauthorized", &error_body("연결 코드가 맞지 않거나 10분이 지나 만료됐습니다. 그 컴퓨터에서 새 코드를 만들어 주세요.")).await;
    }
    let name = clean_name(request.get("name").and_then(Value::as_str).unwrap_or_default());
    let mut list = paired();
    list.retain(|item| item.id != peer);
    if list.len() >= MAX_PAIRED {
        return respond(send, "409 Conflict", &error_body("연결된 컴퓨터가 너무 많습니다. 쓰지 않는 연결을 먼저 끊어 주세요.")).await;
    }
    list.push(Paired { id: peer.to_string(), name: if name.is_empty() { "이름 없는 컴퓨터".into() } else { name }, added: now_secs() });
    if save_list(PAIRED_KEY, &list).is_err() {
        return respond(send, "500 Internal Server Error", &error_body("연결 정보를 저장하지 못했습니다.")).await;
    }
    respond(send, "200 OK", &json!({ "name": host_name() }).to_string()).await;
}

// ---------------------------------------------------------------- using side

fn remote_addr(remote: &Remote) -> Result<EndpointAddr, String> {
    let id: EndpointId = remote.id.parse().map_err(|_| "저장된 연결 정보가 손상됐습니다. 지우고 다시 연결해 주세요.".to_string())?;
    let mut addrs: Vec<TransportAddr> = remote.addrs.iter().filter_map(|addr| addr.parse().ok()).map(TransportAddr::Ip).collect();
    if let Some(url) = remote.relay.as_ref().and_then(|url| url.parse::<RelayUrl>().ok()) {
        addrs.push(TransportAddr::Relay(url));
    }
    Ok(EndpointAddr::from_parts(id, addrs))
}

async fn connect(remote: &Remote) -> Result<Connection, String> {
    let endpoint = endpoint().await?;
    let addr = remote_addr(remote)?;
    match tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(addr, ALPN)).await {
        Ok(Ok(conn)) => Ok(conn),
        Ok(Err(_)) | Err(_) => Err(format!(
            "{}에 연결하지 못했습니다. 그 컴퓨터가 켜져 있고 AI Character의 공유가 켜져 있는지 확인해 주세요.",
            remote.name
        )),
    }
}

async fn connection(remote: &Remote) -> Result<Connection, String> {
    let cached = CONNS.lock().ok().and_then(|conns| conns.get(&remote.id).filter(|conn| conn.close_reason().is_none()).cloned());
    if let Some(conn) = cached {
        return Ok(conn);
    }
    let conn = connect(remote).await?;
    if let Ok(mut conns) = CONNS.lock() {
        conns.insert(remote.id.clone(), conn.clone());
    }
    report_path_later(remote, conn.clone());
    Ok(conn)
}

/// A 127.0.0.1 port that forwards to the paired computer, so normal HTTP clients can use it.
async fn tunnel_base(remote: &Remote) -> Result<String, String> {
    let existing = TUNNELS.lock().ok().and_then(|tunnels| tunnels.get(&remote.id).copied());
    if let Some(port) = existing {
        return Ok(format!("http://127.0.0.1:{port}"));
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    {
        let mut tunnels = TUNNELS.lock().map_err(|error| error.to_string())?;
        if let Some(port) = tunnels.get(&remote.id) {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
        tunnels.insert(remote.id.clone(), port);
    }
    let id = remote.id.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok((local, _)) = listener.accept().await {
            let Some(remote) = remotes().into_iter().find(|remote| remote.id == id) else { break };
            tauri::async_runtime::spawn(async move {
                if let Ok(conn) = connection(&remote).await {
                    pipe_local(local, conn).await;
                }
            });
        }
        if let Ok(mut tunnels) = TUNNELS.lock() {
            tunnels.remove(&id);
        }
    });
    Ok(format!("http://127.0.0.1:{port}"))
}

async fn pipe_local(local: tokio::net::TcpStream, conn: Connection) {
    let Ok((mut send, mut recv)) = conn.open_bi().await else { return };
    let (mut local_read, mut local_write) = local.into_split();
    let upload = async {
        let _ = tokio::io::copy(&mut local_read, &mut send).await;
        let _ = send.finish();
        std::future::pending::<()>().await;
    };
    tokio::select! {
        _ = tokio::io::copy(&mut recv, &mut local_write) => {}
        _ = upload => {}
    }
    let _ = local_write.shutdown().await;
}

async fn request(remote_name: &str, conn: &Connection, raw: &[u8]) -> Result<(u16, Value), String> {
    let failed = || format!("{remote_name}와 주고받는 중 연결이 끊겼습니다. 다시 시도해 주세요.");
    let (mut send, mut recv) = conn.open_bi().await.map_err(|_| failed())?;
    AsyncWriteExt::write_all(&mut send, raw).await.map_err(|_| failed())?;
    let _ = send.finish();
    let response = match tokio::time::timeout(Duration::from_secs(15), recv.read_to_end(64 * 1024)).await {
        Ok(Ok(response)) => response,
        _ => return Err(failed()),
    };
    let text = String::from_utf8_lossy(&response);
    let status = text.split(' ').nth(1).and_then(|code| code.parse().ok()).ok_or_else(failed)?;
    let body = text.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or_default();
    Ok((status, serde_json::from_str(body).unwrap_or(Value::Null)))
}

/// Pairs with the computer that made `code`, then remembers it.
pub async fn pair(code: &str, name: &str) -> Result<Value, String> {
    let ticket = decode_ticket(code)?;
    if ticket.id == secret_key()?.public().to_string() {
        return Err("이 컴퓨터에서 만든 코드입니다. 다른 컴퓨터에서 만든 연결 코드를 넣어 주세요.".into());
    }
    let mut list = remotes();
    list.retain(|remote| remote.id != ticket.id);
    if list.len() >= MAX_REMOTES {
        return Err(format!("다른 컴퓨터는 {MAX_REMOTES}대까지 연결할 수 있습니다."));
    }
    let name = clean_name(name);
    let remote = Remote {
        name: if name.is_empty() { clean_name(&ticket.n) } else { name },
        id: ticket.id.clone(),
        relay: ticket.r.clone(),
        relay_token: ticket.t.clone(),
        addrs: ticket.a.clone(),
    };
    let endpoint = endpoint().await?;
    if let Some(relay) = ticket.r.as_ref().map(|url| Relay { url: url.clone(), token: ticket.t.clone() }) {
        if let Some(config) = relay_config(&relay) {
            let _ = endpoint.insert_relay(config.url.clone(), std::sync::Arc::new(config)).await;
        }
    }
    let conn = connect(&remote).await?;
    let body = json!({ "secret": ticket.s, "name": host_name() }).to_string();
    let raw = format!("POST {PAIR_PATH} HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let (status, value) = request(&remote.name, &conn, raw.as_bytes()).await?;
    if status != 200 {
        let message = value.get("error").and_then(Value::as_str).unwrap_or("연결을 허락받지 못했습니다.");
        return Err(message.to_string());
    }
    list.push(remote.clone());
    save_list(REMOTES_KEY, &list)?;
    report_path_later(&remote, conn.clone());
    if let Ok(mut conns) = CONNS.lock() {
        conns.insert(remote.id.clone(), conn);
    }
    ensure_health_loop();
    Ok(json!({ "remotes": list, "message": format!("{}와 연결했습니다.", remote.name) }))
}

/// Pairs with either a 6-digit code (fetched from a relay) or a long `AIC1.` code.
pub async fn pair_any(code: &str, name: &str, relay_url: Option<&str>, relay_token: Option<&str>) -> Result<Value, String> {
    let Some(digits) = normalize_short_code(code) else { return pair(code, name).await };
    let relay = short_code_relay(relay_url, relay_token)?;
    let sealed = match relay_call(&relay, reqwest::Method::POST, "/codes/take", Some(&json!({ "id": short_id(&digits) }))).await? {
        (200, value) => value.get("sealed").and_then(Value::as_str).unwrap_or_default().to_string(),
        (404, _) => return Err("그 6자리 코드를 찾지 못했습니다. 숫자를 다시 확인하거나 (코드는 10분 뒤, 또는 한 번 쓰면 사라집니다) 새 코드를 만들어 주세요.".into()),
        (status, _) => return Err(relay_refusal(status)),
    };
    let ticket = open_ticket(&digits, &sealed)?;
    pair(&ticket, name).await
}

pub fn remove_remote(id: &str) -> Result<Value, String> {
    let mut list = remotes();
    list.retain(|remote| remote.id != id);
    save_list(REMOTES_KEY, &list)?;
    if let Ok(mut conns) = CONNS.lock() {
        if let Some(conn) = conns.remove(id) {
            conn.close(0u32.into(), b"removed");
        }
    }
    if let Ok(mut online) = ONLINE.lock() {
        *online = None;
    }
    Ok(json!({ "remotes": list }))
}

async fn get_json(base: &str, path: &str, timeout: Duration) -> Result<(u16, Value), String> {
    let client = reqwest::Client::builder().timeout(timeout).no_proxy().build().map_err(|error| error.to_string())?;
    let response = client.get(format!("{base}{path}")).send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|error| error.to_string())?;
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

async fn remote_ollama(base: &str) -> Result<(String, Vec<crate::local_ai::InstalledModel>), String> {
    let (status, value) = get_json(base, "/api/version", Duration::from_secs(15)).await?;
    if status != 200 {
        return Err(value.get("error").and_then(Value::as_str).unwrap_or("그 컴퓨터의 Ollama에 연결하지 못했습니다.").to_string());
    }
    let version = value.get("version").and_then(Value::as_str).unwrap_or_default().to_string();
    let models = match get_json(base, "/api/tags", Duration::from_secs(10)).await {
        Ok((200, value)) => crate::local_ai::parse_installed(&value),
        _ => Vec::new(),
    };
    Ok((version, models))
}

fn ensure_health_loop() {
    if HEALTH_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        loop {
            refresh_online().await;
            tokio::time::sleep(Duration::from_secs(45)).await;
        }
    });
}

async fn refresh_online() {
    let mut found = None;
    for remote in remotes() {
        let Ok(base) = tunnel_base(&remote).await else { continue };
        if matches!(get_json(&base, "/api/version", Duration::from_secs(15)).await, Ok((200, _))) {
            found = Some(base);
            break;
        }
    }
    if let Ok(mut online) = ONLINE.lock() {
        *online = found;
    }
}

/// The first paired computer whose Ollama answered recently, used as a fallback in the free pool.
pub fn first_reachable_remote() -> Option<String> {
    ONLINE.lock().ok()?.clone()
}

pub async fn remote_models(base: &str) -> Vec<String> {
    match get_json(base, "/api/tags", Duration::from_secs(10)).await {
        Ok((200, value)) => crate::local_ai::parse_installed(&value).into_iter().map(|model| model.name).filter(|name| !name.contains("embed")).collect(),
        _ => Vec::new(),
    }
}

fn last_seen_text(last_seen: u64) -> String {
    if last_seen == 0 {
        return String::new();
    }
    let ago = now_secs().saturating_sub(last_seen);
    let text = match ago {
        0..=119 => "방금".to_string(),
        120..=3599 => format!("{}분 전", ago / 60),
        3600..=86_399 => format!("{}시간 전", ago / 3600),
        _ => format!("{}일 전", ago / 86_400),
    };
    format!(" (마지막 접속: {text})")
}

pub async fn remote_statuses() -> Value {
    let mut out = Vec::new();
    let list = remotes();
    let online = presence(&list).await;
    for remote in list {
        let presence = online.get(&remote.id).copied();
        if let Some((false, last_seen)) = presence {
            out.push(json!({
                "name": remote.name, "id": remote.id, "viaRelay": remote.relay.is_some(), "ollama": false, "models": [],
                "online": false, "lastSeen": last_seen,
                "error": format!("{}이(가) 꺼져 있거나 인터넷에 연결되어 있지 않습니다{}. 그 컴퓨터를 켜고 AI Character를 실행해 주세요.", remote.name, last_seen_text(last_seen)),
            }));
            continue;
        }
        let base = match tunnel_base(&remote).await {
            Ok(base) => base,
            Err(error) => {
                out.push(json!({ "name": remote.name, "id": remote.id, "viaRelay": remote.relay.is_some(), "ollama": false, "error": error, "models": [] }));
                continue;
            }
        };
        let ollama = remote_ollama(&base).await;
        let specs = match get_json(&base, STATUS_PATH, Duration::from_secs(10)).await {
            Ok((200, value)) => Ok(value),
            Ok((_, value)) => Err(value.get("error").and_then(Value::as_str).unwrap_or("사양 정보를 받지 못했습니다.").to_string()),
            Err(_) => Err(format!("{}에 연결하지 못했습니다. 그 컴퓨터가 켜져 있고 공유가 켜져 있는지 확인해 주세요.", remote.name)),
        };
        if ollama.is_ok() {
            if let Ok(mut online) = ONLINE.lock() {
                online.get_or_insert(base.clone());
            }
        }
        let (version, models) = match &ollama {
            Ok((version, models)) => (Some(version.clone()), models.clone()),
            Err(_) => (None, Vec::new()),
        };
        let path = CONNS.lock().ok().and_then(|conns| conns.get(&remote.id).filter(|conn| conn.close_reason().is_none()).cloned()).and_then(|conn| path_kind(&conn));
        out.push(json!({
            "name": remote.name,
            "id": remote.id,
            "viaRelay": remote.relay.is_some(),
            "online": presence.map(|(online, _)| online),
            "path": path.map(|(kind, _)| kind),
            "rttMs": path.map(|(_, rtt)| rtt as u64),
            "ollama": version.is_some(),
            "version": version,
            "models": models,
            "error": specs.as_ref().err().cloned().or_else(|| ollama.as_ref().err().cloned()),
            "specs": specs.as_ref().ok(),
        }));
    }
    json!({ "remotes": out, "jobs": crate::local_ai::jobs_snapshot() })
}

pub fn pull_job_id(id: &str, model: &str) -> String {
    format!("remote|{id}|{model}")
}

pub async fn start_remote_pull(id: &str, model_id: &str) -> Result<Value, String> {
    let remote = remotes().into_iter().find(|remote| remote.id == id).ok_or("연결되지 않은 컴퓨터입니다.")?;
    let model = crate::local_ai::catalog_entry(model_id)?;
    let base = tunnel_base(&remote).await?;
    remote_ollama(&base).await.map_err(|error| format!("{}: {error}", remote.name))?;
    if let Ok((200, specs)) = get_json(&base, STATUS_PATH, Duration::from_secs(10)).await {
        let verdict = specs
            .get("catalog")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(model.id)))
            .and_then(|item| Some((item.get("verdict")?.as_str()?.to_string(), item.get("reason")?.as_str()?.to_string())));
        if let Some((verdict, reason)) = verdict {
            if verdict == "no_ram" || verdict == "no_disk" {
                return Err(format!("{reason} — {}에는 받을 수 없습니다.", remote.name));
            }
        }
    }
    crate::local_ai::spawn_pull(base, model.id.to_string(), pull_job_id(&remote.id, model.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ticket() -> Ticket {
        Ticket {
            v: 1,
            n: "거실 PC".into(),
            id: SecretKey::generate().public().to_string(),
            r: Some("https://relay.example.com/".into()),
            t: "token123".into(),
            a: vec!["192.168.0.5:51000".into(), "[fe80::1]:51000".into()],
            s: new_code(20).unwrap(),
        }
    }

    #[test]
    fn tickets_round_trip_and_reject_garbage() {
        let ticket = sample_ticket();
        let code = encode_ticket(&ticket);
        assert!(code.starts_with("AIC1."));
        let wrapped = format!("  {}\n{} ", &code[..30], &code[30..]);
        assert_eq!(decode_ticket(&wrapped).unwrap(), ticket);
        assert!(decode_ticket("AIC1.xxxx").is_err());
        assert!(decode_ticket("hello").is_err());
        let mut bad = ticket.clone();
        bad.id = "nope".into();
        assert!(decode_ticket(&encode_ticket(&bad)).is_err());
        let mut short = ticket.clone();
        short.s = "abc".into();
        assert!(decode_ticket(&encode_ticket(&short)).is_err());
        let mut future = ticket;
        future.v = 2;
        assert!(decode_ticket(&encode_ticket(&future)).unwrap_err().contains("버전"));
    }

    #[test]
    fn only_listed_ollama_paths_are_forwarded() {
        assert!(allowed("POST", "/v1/chat/completions"));
        assert!(allowed("GET", "/api/tags"));
        assert!(allowed("POST", "/api/pull"));
        assert!(!allowed("DELETE", "/api/delete"));
        assert!(!allowed("POST", "/api/create"));
        assert!(!allowed("GET", "/v1/chat/completions"));
        assert!(!allowed("POST", "/api/push"));
    }

    #[test]
    fn heads_are_parsed_and_rewritten() {
        let raw = b"POST /v1/chat/completions?x=1 HTTP/1.1\r\nHost: 127.0.0.1:5555\r\nConnection: keep-alive\r\nOrigin: http://evil\r\nContent-Length: 2\r\n\r\n{}";
        let head = parse_head(raw).unwrap();
        assert_eq!(head.method, "POST");
        assert_eq!(head.route(), "/v1/chat/completions");
        assert_eq!(&raw[head.len..], b"{}");
        let out = forwarded_head(&head);
        assert!(out.starts_with("POST /v1/chat/completions?x=1 HTTP/1.1\r\nHost: 127.0.0.1:11434\r\n"));
        assert!(out.contains("Content-Length: 2\r\n") && out.ends_with("Connection: close\r\n\r\n"));
        assert!(!out.contains("evil") && !out.contains("keep-alive") && !out.contains(":5555"));
        assert!(parse_head(b"GET /api/tags HTTP/1.1\r\n").is_none());
        assert!(parse_head(b"GET api HTTP/1.1\r\n\r\n").is_none());
    }

    #[test]
    fn relay_urls_are_normalized() {
        assert_eq!(normalize_relay_url(" relay.example.com/ ").unwrap().as_deref(), Some("https://relay.example.com/"));
        assert_eq!(normalize_relay_url("").unwrap(), None);
        assert!(normalize_relay_url("http://relay.example.com").is_err());
        assert!(normalize_relay_url("https://relay.example.com/path").is_err());
        assert!(normalize_relay_url("ftp://x").is_err());
        assert!(normalize_relay_url("http://localhost:3340").is_ok());
    }

    #[test]
    fn keys_and_codes() {
        let key = SecretKey::generate();
        assert_eq!(unhex32(&hex(&key.to_bytes())).unwrap(), key.to_bytes());
        assert!(unhex32("zz").is_none());
        let code = new_code(20).unwrap();
        assert!(code.len() == 20 && code.bytes().all(|byte| CODE_ALPHABET.contains(&byte)));
        assert!(constant_time_eq("ABC", "ABC") && !constant_time_eq("ABC", "ABD") && !constant_time_eq("AB", "ABC"));
    }

    #[test]
    fn six_digit_codes_seal_the_long_code() {
        let digits = short_digits().unwrap();
        assert!(digits.len() == 6 && digits.bytes().all(|byte| byte.is_ascii_digit()));
        assert_eq!(normalize_short_code(" 123 456 ").as_deref(), Some("123456"));
        assert_eq!(normalize_short_code("123-456").as_deref(), Some("123456"));
        assert_eq!(normalize_short_code("12345"), None);
        assert_eq!(normalize_short_code("AIC1.abc"), None);
        assert_eq!(short_id("123456").len(), 64);
        assert_ne!(short_id("123456"), short_id("123457"));
        let sealed = seal_ticket("123456", "AIC1.long-code").unwrap();
        assert!(!sealed.contains("long-code"));
        assert_eq!(open_ticket("123456", &sealed).unwrap(), "AIC1.long-code");
        assert!(open_ticket("654321", &sealed).is_err());
        assert!(open_ticket("123456", "garbage").is_err());
    }

    #[tokio::test]
    async fn endpoints_talk_directly_without_a_relay() {
        let bind = || Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).relay_mode(RelayMode::Disabled).bind();
        let host = bind().await.unwrap();
        let client = bind().await.unwrap();
        let addr = host.addr();
        let server = tokio::spawn(async move {
            let conn = host.accept().await.unwrap().accept().unwrap().await.unwrap();
            let (mut send, mut recv) = conn.accept_bi().await.unwrap();
            let mut buffer = Vec::new();
            recv.read_to_end(1024).await.map(|data| buffer = data).unwrap();
            AsyncWriteExt::write_all(&mut send, &buffer).await.unwrap();
            send.finish().unwrap();
            conn.closed().await;
        });
        let conn = client.connect(addr, ALPN).await.unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        AsyncWriteExt::write_all(&mut send, b"hello").await.unwrap();
        send.finish().unwrap();
        assert_eq!(recv.read_to_end(1024).await.unwrap(), b"hello");
        assert_eq!(path_kind(&conn).map(|(kind, _)| kind), Some("direct"));
        conn.close(0u32.into(), b"done");
        let _ = tokio::time::timeout(Duration::from_secs(3), server).await;
    }

    /// Needs a running relay: `AIC_TEST_RELAY=http://localhost:3340 AIC_TEST_RELAY_TOKEN=... cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn endpoints_meet_through_our_relay_only() {
        let relay = Relay { url: std::env::var("AIC_TEST_RELAY").unwrap(), token: std::env::var("AIC_TEST_RELAY_TOKEN").unwrap_or_default() };
        let bind = |relay: &Relay| Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).relay_mode(relay_mode(std::slice::from_ref(relay))).bind();
        let host = bind(&relay).await.unwrap();
        let client = bind(&relay).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), host.online()).await.expect("host reached the relay");
        let relay_only = EndpointAddr::from_parts(host.id(), host.addr().relay_urls().cloned().map(TransportAddr::Relay));
        assert!(relay_only.relay_urls().next().is_some());
        let host_id = host.id().to_string();
        tokio::spawn(async move {
            let conn = host.accept().await.unwrap().accept().unwrap().await.unwrap();
            let (mut send, mut recv) = conn.accept_bi().await.unwrap();
            let data = recv.read_to_end(1024).await.unwrap();
            AsyncWriteExt::write_all(&mut send, &data).await.unwrap();
            send.finish().unwrap();
            conn.closed().await;
        });
        let conn = tokio::time::timeout(Duration::from_secs(15), client.connect(relay_only, ALPN)).await.unwrap().unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        AsyncWriteExt::write_all(&mut send, b"via relay").await.unwrap();
        send.finish().unwrap();
        assert_eq!(recv.read_to_end(1024).await.unwrap(), b"via relay");
        assert_eq!(path_kind(&conn).map(|(kind, _)| kind), Some("relay"));

        // aic-relay extras: presence, 6-digit code mailbox, path report.
        let (status, value) = relay_call(&relay, reqwest::Method::POST, "/presence", Some(&json!({ "ids": [host_id] }))).await.unwrap();
        assert_eq!((status, value["devices"][&host_id]["online"].as_bool()), (200, Some(true)), "{value}");
        let short = publish_short_code(&relay, "AIC1.long-code").await.unwrap();
        let digits = normalize_short_code(&short).unwrap();
        let (status, value) = relay_call(&relay, reqwest::Method::POST, "/codes/take", Some(&json!({ "id": short_id(&digits) }))).await.unwrap();
        assert_eq!(status, 200);
        assert_eq!(open_ticket(&digits, value["sealed"].as_str().unwrap()).unwrap(), "AIC1.long-code");
        let (status, _) = relay_call(&relay, reqwest::Method::POST, "/codes/take", Some(&json!({ "id": short_id(&digits) }))).await.unwrap();
        assert_eq!(status, 404, "a code works once");
        assert_eq!(relay_call(&relay, reqwest::Method::POST, "/paths", Some(&json!({ "path": "relay" }))).await.unwrap().0, 200);

        let wrong = Relay { token: "wrong-token".into(), ..relay };
        let stranger = bind(&wrong).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), stranger.online()).await.is_err(), "a wrong token must be refused");
    }

    /// Manual end-to-end check for the relay's phone page against this app's real sharing side:
    /// settings go to a throwaway HOME, a fake Ollama answers on 127.0.0.1:11434, and the test
    /// prints a 6-digit code, then waits for a phone to pair and chat.
    /// `HOME=$(mktemp -d) AIC_TEST_RELAY=http://localhost:3340 AIC_TEST_RELAY_TOKEN=... cargo test phone_pairs -- --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn phone_pairs_with_the_real_sharing_side() {
        let home = std::env::var("HOME").unwrap();
        assert!(home.to_ascii_lowercase().contains("tmp") || home.contains("/T/"), "run with a throwaway HOME, not {home}");
        let chats = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ollama = tokio::net::TcpListener::bind(("127.0.0.1", OLLAMA_PORT)).await.expect("port 11434 is free (no real Ollama running)");
        let served = chats.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = ollama.accept().await {
                let served = served.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let head = loop {
                        let read = socket.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        raw.extend_from_slice(&chunk[..read]);
                        if let Some(head) = parse_head(&raw) {
                            break head;
                        }
                    };
                    let length = head.header("content-length").and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
                    while raw.len() < head.len + length {
                        let read = socket.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            break;
                        }
                        raw.extend_from_slice(&chunk[..read]);
                    }
                    if head.route() == "/api/tags" {
                        let body = r#"{"models":[{"name":"qwen3:4b"},{"name":"nomic-embed-text:latest"}]}"#;
                        let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                        let _ = socket.write_all(reply.as_bytes()).await;
                        return;
                    }
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await;
                    for word in ["안녕하세요! ", "진짜 앱의 ", "공유 기능으로 ", "답하고 있어요."] {
                        let event = format!("data: {}\n\n", json!({ "choices": [{ "delta": { "content": word } }] }));
                        let _ = socket.write_all(format!("{:x}\r\n{event}\r\n", event.len()).as_bytes()).await;
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    let done = "data: [DONE]\n\n";
                    let _ = socket.write_all(format!("{:x}\r\n{done}\r\n0\r\n\r\n", done.len()).as_bytes()).await;
                    served.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                });
            }
        });

        set_relay(&std::env::var("AIC_TEST_RELAY").unwrap(), Some(&std::env::var("AIC_TEST_RELAY_TOKEN").unwrap())).unwrap();
        let code = create_code().await.unwrap();
        assert!(code["shortError"].is_null(), "{code}");
        println!("SHORT_CODE={}", code["short"].as_str().unwrap());
        let deadline = Instant::now() + Duration::from_secs(600);
        while chats.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            assert!(Instant::now() < deadline, "no phone chatted within 10 minutes");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let peers = paired();
        assert_eq!(peers.len(), 1, "the phone paired");
        println!("PAIRED={} CHATS={}", peers[0].name, chats.load(std::sync::atomic::Ordering::SeqCst));
    }

    /// A plain HTTP client -> local tunnel -> iroh -> sharing side -> fake Ollama, with a streamed answer.
    #[tokio::test]
    async fn http_goes_through_the_tunnel_to_ollama() {
        let ollama = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let ollama_port = ollama.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let (mut socket, _) = ollama.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut chunk = [0u8; 1024];
            while !raw.ends_with(b"{\"q\":1}") {
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended early");
                raw.extend_from_slice(&chunk[..read]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\n").await.unwrap();
            for part in ["{\"a\":1}\n", "{\"a\":2}\n"] {
                socket.write_all(part.as_bytes()).await.unwrap();
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            String::from_utf8(raw).unwrap()
        });

        let bind = || Endpoint::builder(presets::Minimal).alpns(vec![ALPN.to_vec()]).relay_mode(RelayMode::Disabled).bind();
        let host = bind().await.unwrap();
        let client = bind().await.unwrap();
        let addr = host.addr();
        tokio::spawn(async move {
            let conn = host.accept().await.unwrap().accept().unwrap().await.unwrap();
            let (send, mut recv) = conn.accept_bi().await.unwrap();
            let (head, rest) = read_head(&mut recv).await.unwrap();
            assert!(allowed(&head.method, head.route()));
            proxy(ollama_port, &head, rest, send, recv).await;
            conn.closed().await;
        });

        let conn = client.connect(addr, ALPN).await.unwrap();
        let tunnel = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let tunnel_port = tunnel.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (local, _) = tunnel.accept().await.unwrap();
            pipe_local(local, conn).await;
        });

        let response = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap()
            .post(format!("http://127.0.0.1:{tunnel_port}/v1/chat/completions"))
            .header("Origin", "http://somewhere")
            .body("{\"q\":1}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(response.text().await.unwrap(), "{\"a\":1}\n{\"a\":2}\n");
        let request = seen.await.unwrap();
        assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:11434\r\n"));
        assert!(request.contains("Connection: close\r\n") && !request.to_ascii_lowercase().contains("origin"));
    }
}
