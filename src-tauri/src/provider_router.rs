use crate::policy_engine::{self, mask_secrets, policy_settings, PolicySettings};
use crate::settings::AppSettings;
use crate::usage_ledger::{self, UsageEntry};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const GEMINI_PROVIDER: &str = "gemini_api";
pub const OPENROUTER_PROVIDER: &str = "openrouter_api";
pub const OPENAI_PROVIDER: &str = "openai_api";
/// One automatic target that tries every configured extra free service in order.
pub const FREE_POOL_PROVIDER: &str = "free_pool_api";
const OLLAMA_PROVIDER: &str = "ollama_local";
const LMSTUDIO_PROVIDER: &str = "lmstudio_local";
const REMOTE_OLLAMA_PROVIDER: &str = "ollama_remote";
const MAX_MODELS_PER_FREE_SERVICE: usize = 2;
const DEFAULT_GEMINI_MODEL: &str = "gemini-3.8-flash";
// Fallbacks Google still serves; the 2.x models now answer 404 ("no longer available").
const DEFAULT_GEMINI_FREE_MODELS: &str = "gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.5-flash,gemini-3.1-flash-lite";
const DEFAULT_OPENAI_MODEL: &str = "gpt-5-mini";
const MAX_PROMPT_CHARS: usize = 80_000;
const MODEL_REFRESH_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_FREE_MODEL_ATTEMPTS: usize = 3;
const MAX_BACKOFF_SECS: u64 = 30;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticProviderStatus {
    pub provider: String,
    pub enabled: bool,
    pub configured: bool,
    pub available: bool,
    pub model: String,
    pub cost_class: String,
    pub reason: Option<String>,
}

pub enum StreamEvent<'a> {
    /// Discard text shown so far (a new attempt starts or the attempt failed).
    Reset,
    Delta(&'a str),
}

pub type StreamSink = Arc<dyn Fn(StreamEvent<'_>) + Send + Sync>;

#[derive(Clone, Default)]
pub struct CallContext {
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub role: Option<String>,
    pub cache_fingerprint: Option<String>,
    pub stream: Option<StreamSink>,
}

/// Splits a server-sent-events byte stream into `data:` payloads across chunk boundaries.
#[derive(Default)]
pub struct SseLines {
    buffer: Vec<u8>,
}

impl SseLines {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut payloads = Vec::new();
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            if let Some(data) = sse_data(&line) {
                payloads.push(data);
            }
        }
        payloads
    }

    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buffer);
        sse_data(&rest)
    }
}

fn sse_data(line: &[u8]) -> Option<String> {
    let line = String::from_utf8_lossy(line);
    let data = line.trim_end_matches(['\r', '\n']).strip_prefix("data:")?.trim_start();
    (!data.is_empty() && data != "[DONE]").then(|| data.to_string())
}

/// Reads an SSE response, passing each JSON payload to `on_event`.
async fn read_sse(
    provider: &str,
    mut response: reqwest::Response,
    mut on_event: impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let mut lines = SseLines::default();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| format!("PROVIDER_FAILED|{provider}|스트림 읽기 실패: {}", mask_secrets(&error.to_string())))?;
        let done = chunk.is_none();
        let payloads = match chunk {
            Some(bytes) => lines.push(&bytes),
            None => lines.finish().into_iter().collect(),
        };
        for payload in payloads {
            if let Ok(value) = serde_json::from_str::<Value>(&payload) {
                on_event(value)?;
            }
        }
        if done {
            return Ok(());
        }
    }
}

#[derive(Clone, Debug, Default)]
struct ProviderReply {
    text: String,
    input_tokens: i64,
    output_tokens: i64,
    cached_tokens: i64,
    cost_usd: f64,
}

fn env_key(name: &str) -> Option<String> {
    crate::process_util::secret_value(name)
}

fn gemini_api_key() -> Option<String> {
    env_key("GEMINI_API_KEY")
}

fn openai_api_key() -> Option<String> {
    env_key("OPENAI_API_KEY")
}

fn openrouter_api_key() -> Option<String> {
    env_key("OPENROUTER_API_KEY")
}

fn gemini_model() -> String {
    env_key("GEMINI_MODEL").unwrap_or_else(|| DEFAULT_GEMINI_MODEL.to_string())
}

fn openai_model() -> String {
    env_key("OPENAI_MODEL").unwrap_or_else(|| DEFAULT_OPENAI_MODEL.to_string())
}

/// Gemini cannot report whether a key is on the free tier, so only listed models count as free.
pub fn gemini_free_models() -> Vec<String> {
    env_key("GEMINI_FREE_MODELS")
        .unwrap_or_else(|| DEFAULT_GEMINI_FREE_MODELS.to_string())
        .split(',')
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn gemini_model_is_free(model: &str) -> bool {
    gemini_free_models().iter().any(|free| free == model)
}

fn gemini_candidates() -> Vec<String> {
    let mut models = Vec::new();
    let primary = gemini_model();
    if gemini_model_is_free(&primary) {
        models.push(primary);
    }
    for model in gemini_free_models() {
        if !models.iter().any(|have| have == &model) {
            models.push(model);
        }
    }
    models
}

/// Code, music, and safety models are free but give the wrong kind of answer for facts.
fn factual_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    !["code", "lyria", "clip", "content-safety", "embed", "whisper", "tts", "image"]
        .iter()
        .any(|word| id.contains(word))
}

fn factual_rank(id: &str) -> u8 {
    let id = id.to_ascii_lowercase();
    if id.contains("preview") || id.contains("-note") {
        return 3;
    }
    if id.contains("gemma") || id.contains("llama") || id.contains("qwen") || id.contains("gemini") || id.contains("nemotron") {
        return 0;
    }
    1
}

fn openrouter_candidates(limit: usize) -> Vec<String> {
    if let Some(model) = env_key("OPENROUTER_MODEL") {
        return vec![model];
    }
    let Ok(connection) = usage_ledger::open_ledger() else {
        return Vec::new();
    };
    let models = usage_ledger::list_models(&connection, Some(OPENROUTER_PROVIDER)).unwrap_or_default();
    let usable: Vec<String> = models
        .iter()
        .filter(|model| model.active && model.is_free && model.context_length >= 16_000)
        .map(|model| model.model_id.clone())
        .collect();
    let mut preferred: Vec<String> = usable.iter().filter(|id| factual_chat_model(id)).cloned().collect();
    if preferred.is_empty() {
        preferred = usable;
    } else {
        preferred.sort_by_key(|id| factual_rank(id));
    }
    preferred.into_iter().take(limit).collect()
}

/// An extra free service that speaks the OpenAI chat-completions format.
pub struct FreeService {
    pub id: &'static str,
    pub label: &'static str,
    /// `None` for local servers (Ollama, LM Studio), which need no key.
    pub key_env: Option<&'static str>,
    pub model_env: Option<&'static str>,
    pub models: &'static [&'static str],
    /// The same key can also buy paid models, so only the listed free models are ever called.
    pub locked: bool,
    pub limits: &'static str,
}

/// Tried in this order: generous fast clouds first, the local models last.
pub const FREE_SERVICES: &[FreeService] = &[
    FreeService {
        id: "groq_api",
        label: "Groq",
        key_env: Some("GROQ_API_KEY"),
        model_env: Some("GROQ_MODEL"),
        models: &["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
        locked: false,
        limits: "분당 30회 · 하루 1,000회",
    },
    FreeService {
        id: "nvidia_api",
        label: "NVIDIA NIM",
        key_env: Some("NVIDIA_API_KEY"),
        model_env: Some("NVIDIA_MODEL"),
        models: &["openai/gpt-oss-120b", "meta/llama-3.3-70b-instruct"],
        locked: false,
        limits: "분당 약 40회 · 하루 한도 없음",
    },
    FreeService {
        id: "skt_ax_api",
        label: "SKT A.X",
        key_env: Some("SKT_AX_API_KEY"),
        model_env: None,
        models: &["ax4"],
        locked: true,
        limits: "IP당 분당 10회 · 무료 베타",
    },
    FreeService {
        id: "hasa_api",
        label: "HASA 공공 AI 허브",
        key_env: Some("HASA_API_KEY"),
        model_env: Some("HASA_MODEL"),
        models: &["exaone-4.0-32b", "gpt-oss-120b"],
        locked: false,
        limits: "하루 500회 · 분당 10회 · 한 번에 1개",
    },
    FreeService {
        id: "zai_api",
        label: "Z.ai GLM",
        key_env: Some("ZAI_API_KEY"),
        model_env: None,
        models: &["glm-4.7-flash", "glm-4.5-flash"],
        locked: true,
        limits: "무료 Flash 모델만 · 한 번에 1개 요청",
    },
    FreeService {
        id: "sambanova_api",
        label: "SambaNova",
        key_env: Some("SAMBANOVA_API_KEY"),
        model_env: Some("SAMBANOVA_MODEL"),
        models: &["Meta-Llama-3.3-70B-Instruct", "DeepSeek-V3.1"],
        locked: false,
        limits: "모델당 하루 약 20회",
    },
    FreeService {
        id: "cloudflare_api",
        label: "Cloudflare Workers AI",
        key_env: Some("CLOUDFLARE_API_TOKEN"),
        model_env: Some("CLOUDFLARE_MODEL"),
        models: &["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"],
        locked: false,
        limits: "하루 10,000 뉴런 (무료 플랜)",
    },
    FreeService {
        id: "siliconflow_api",
        label: "SiliconFlow",
        key_env: Some("SILICONFLOW_API_KEY"),
        model_env: None,
        models: &["Qwen/Qwen3-8B", "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B"],
        locked: true,
        limits: "무료 소형 모델만",
    },
    FreeService {
        id: "hunyuan_api",
        label: "Tencent Hunyuan",
        key_env: Some("HUNYUAN_API_KEY"),
        model_env: None,
        models: &["hunyuan-lite"],
        locked: true,
        limits: "무료 hunyuan-lite만",
    },
    FreeService {
        id: OLLAMA_PROVIDER,
        label: "Ollama (내 컴퓨터)",
        key_env: None,
        model_env: Some("OLLAMA_MODEL"),
        models: &[],
        locked: false,
        limits: "한도 없음 · 컴퓨터 성능만큼",
    },
    FreeService {
        id: REMOTE_OLLAMA_PROVIDER,
        label: "다른 컴퓨터 (Ollama)",
        key_env: None,
        model_env: None,
        models: &[],
        locked: false,
        limits: "한도 없음 · 그 컴퓨터 성능만큼",
    },
    FreeService {
        id: LMSTUDIO_PROVIDER,
        label: "LM Studio (내 컴퓨터)",
        key_env: None,
        model_env: None,
        models: &[],
        locked: false,
        limits: "한도 없음 · 컴퓨터 성능만큼",
    },
];

pub fn is_local_service(id: &str) -> bool {
    matches!(id, OLLAMA_PROVIDER | LMSTUDIO_PROVIDER | REMOTE_OLLAMA_PROVIDER)
}

pub fn free_service(id: &str) -> Option<&'static FreeService> {
    FREE_SERVICES.iter().find(|service| service.id == id)
}

fn free_service_url(service: &FreeService) -> Option<String> {
    Some(match service.id {
        "groq_api" => "https://api.groq.com/openai/v1/chat/completions".to_string(),
        "nvidia_api" => "https://integrate.api.nvidia.com/v1/chat/completions".to_string(),
        "zai_api" => "https://api.z.ai/api/paas/v4/chat/completions".to_string(),
        "sambanova_api" => "https://api.sambanova.ai/v1/chat/completions".to_string(),
        "cloudflare_api" => {
            let account = env_key("CLOUDFLARE_ACCOUNT_ID")?;
            if !account.chars().all(|c| c.is_ascii_alphanumeric()) {
                return None;
            }
            format!("https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions")
        }
        "siliconflow_api" => "https://api.siliconflow.com/v1/chat/completions".to_string(),
        "skt_ax_api" => "https://guest-api.sktax.chat/v1/chat/completions".to_string(),
        "hasa_api" => "https://open.hasa.re.kr/v1/chat/completions".to_string(),
        "hunyuan_api" => "https://api.hunyuan.cloud.tencent.com/v1/chat/completions".to_string(),
        OLLAMA_PROVIDER => format!("{}/v1/chat/completions", crate::local_ai::OLLAMA_BASE),
        LMSTUDIO_PROVIDER => format!("{}/v1/chat/completions", crate::local_ai::LMSTUDIO_BASE),
        REMOTE_OLLAMA_PROVIDER => format!("{}/v1/chat/completions", crate::remote_ai::first_reachable_remote()?),
        _ => return None,
    })
}

fn free_service_configured(service: &FreeService) -> bool {
    match service.key_env {
        Some(name) => env_key(name).is_some() && free_service_url(service).is_some(),
        None if service.id == LMSTUDIO_PROVIDER => crate::local_ai::lmstudio_running(),
        None if service.id == REMOTE_OLLAMA_PROVIDER => crate::remote_ai::first_reachable_remote().is_some(),
        None => crate::local_ai::ollama_running(),
    }
}

/// Locked services ignore overrides; the others accept `<NAME>_MODEL` first.
fn free_service_models(service: &FreeService) -> Vec<String> {
    let mut models = Vec::new();
    if !service.locked {
        if let Some(model) = service.model_env.and_then(env_key) {
            models.push(model);
        }
    }
    for model in service.models {
        if !models.iter().any(|known| known == model) {
            models.push(model.to_string());
        }
    }
    models
}

/// Installed chat models, skipping embedding-only ones, with the model picked in setup first.
async fn ollama_models() -> Vec<String> {
    if let Some(model) = env_key("OLLAMA_MODEL") {
        return vec![model];
    }
    let installed = crate::local_ai::ollama_installed_models().await;
    let mut models = parse_ollama_models(&json!({ "models": installed }));
    if let Some(preferred) = crate::local_ai::preferred_model() {
        if let Some(index) = models.iter().position(|model| *model == preferred) {
            let model = models.remove(index);
            models.insert(0, model);
        }
    }
    models
}

async fn local_models(service: &FreeService) -> Vec<String> {
    match service.id {
        OLLAMA_PROVIDER => ollama_models().await,
        LMSTUDIO_PROVIDER => crate::local_ai::lmstudio_models().await,
        REMOTE_OLLAMA_PROVIDER => match crate::remote_ai::first_reachable_remote() {
            Some(base) => crate::remote_ai::remote_models(&base).await,
            None => Vec::new(),
        },
        _ => free_service_models(service),
    }
}

pub fn parse_ollama_models(value: &Value) -> Vec<String> {
    value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("name").and_then(Value::as_str))
        .filter(|name| !name.contains("embed"))
        .map(str::to_string)
        .collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeServiceStatus {
    pub id: String,
    pub label: String,
    pub key_env: Option<String>,
    pub configured: bool,
    pub models: Vec<String>,
    pub locked: bool,
    pub local: bool,
    pub limits: String,
}

pub fn free_service_statuses() -> Vec<FreeServiceStatus> {
    FREE_SERVICES
        .iter()
        .map(|service| FreeServiceStatus {
            id: service.id.to_string(),
            label: service.label.to_string(),
            key_env: service.key_env.map(str::to_string),
            configured: free_service_configured(service),
            models: free_service_models(service),
            locked: service.locked,
            local: is_local_service(service.id),
            limits: service.limits.to_string(),
        })
        .collect()
}

fn openrouter_model_label() -> String {
    openrouter_candidates(1)
        .into_iter()
        .next()
        .unwrap_or_else(|| "무료 모델 목록 갱신 필요".to_string())
}

pub fn provider_statuses(settings: &AppSettings) -> Vec<AutomaticProviderStatus> {
    let policy = policy_settings(settings);
    let gemini_configured = gemini_api_key().is_some();
    let openai_configured = openai_api_key().is_some();
    let openrouter_configured = openrouter_api_key().is_some();
    let gemini = gemini_model();
    let gemini_free = gemini_model_is_free(&gemini);

    vec![
        AutomaticProviderStatus {
            provider: GEMINI_PROVIDER.to_string(),
            enabled: settings.gemini_api_enabled,
            configured: gemini_configured,
            available: settings.gemini_api_enabled && gemini_configured && gemini_free,
            model: gemini,
            cost_class: if gemini_free { "free_first" } else { "paid_opt_in" }.to_string(),
            reason: if !settings.gemini_api_enabled {
                Some("설정에서 Gemini 자동 Provider가 꺼져 있습니다.".to_string())
            } else if !gemini_configured {
                Some("GEMINI_API_KEY 환경변수가 없습니다.".to_string())
            } else if !gemini_free {
                Some("GEMINI_MODEL이 무료 목록(GEMINI_FREE_MODELS)에 없어 유료로 취급합니다.".to_string())
            } else {
                None
            },
        },
        AutomaticProviderStatus {
            provider: OPENROUTER_PROVIDER.to_string(),
            enabled: policy.openrouter_enabled,
            configured: openrouter_configured,
            available: policy.openrouter_enabled && openrouter_configured,
            model: openrouter_model_label(),
            cost_class: "free_first".to_string(),
            reason: if !policy.openrouter_enabled {
                Some("설정에서 OpenRouter 무료 모델이 꺼져 있습니다.".to_string())
            } else if !openrouter_configured {
                Some("OPENROUTER_API_KEY 환경변수가 없습니다.".to_string())
            } else {
                None
            },
        },
        free_pool_status(),
        AutomaticProviderStatus {
            provider: OPENAI_PROVIDER.to_string(),
            enabled: settings.allow_paid_openai_api,
            configured: openai_configured,
            available: settings.allow_paid_openai_api && openai_configured,
            model: openai_model(),
            cost_class: "paid_opt_in".to_string(),
            reason: if !settings.allow_paid_openai_api {
                Some("OpenAI 유료 API 사용 허용이 꺼져 있습니다.".to_string())
            } else if !openai_configured {
                Some("OPENAI_API_KEY 환경변수가 없습니다.".to_string())
            } else {
                Some("호출할 때마다 사용자 승인이 필요합니다.".to_string())
            },
        },
    ]
}

fn free_pool_status() -> AutomaticProviderStatus {
    let ready: Vec<&str> = FREE_SERVICES
        .iter()
        .filter(|service| free_service_configured(service))
        .map(|service| service.label)
        .collect();
    AutomaticProviderStatus {
        provider: FREE_POOL_PROVIDER.to_string(),
        enabled: true,
        configured: !ready.is_empty(),
        available: !ready.is_empty(),
        model: if ready.is_empty() { "설정된 서비스 없음".to_string() } else { ready.join(" → ") },
        cost_class: "free_first".to_string(),
        reason: ready
            .is_empty()
            .then(|| "Groq·NVIDIA·GLM 등 추가 무료 AI 키가 없고 Ollama도 실행 중이 아닙니다.".to_string()),
    }
}

fn validate_prompt(prompt: &str) -> Result<String, String> {
    let clean = mask_secrets(prompt.trim());
    if clean.trim().is_empty() {
        return Err("PROVIDER_FAILED|common|프롬프트가 비어 있습니다.".to_string());
    }
    if clean.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "PROVIDER_FAILED|common|프롬프트는 {MAX_PROMPT_CHARS}자 이하여야 합니다."
        ));
    }
    Ok(clean)
}

/// Korean message first, the provider's own text (masked, shortened) after "자세히:".
/// "(HTTP status)" stays in the text: is_limited and failed_call_may_bill read it.
fn limited_error(provider: &str, status: u16, body: &str) -> String {
    let lower = body.to_lowercase();
    let detail = error_detail(body);
    if status == 429
        || lower.contains("resource_exhausted")
        || lower.contains("quota")
        || lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("usage limit")
    {
        return format!("PROVIDER_LIMITED|{provider}|사용 한도에 걸렸습니다. 잠시 후 다시 시도하거나 다른 AI를 쓰세요. (HTTP {status}){detail}");
    }
    if status == 401 || status == 403 {
        return format!("PROVIDER_AUTH|{provider}|API 키가 맞지 않거나 권한이 없습니다. 설정에서 키를 확인하세요. (HTTP {status}){detail}");
    }
    let message = match status {
        404 => "요청한 모델을 찾지 못했습니다.",
        400 | 413 | 422 => "AI 서비스가 요청 형식을 받아들이지 않았습니다.",
        500..=599 => "AI 서비스 쪽 서버에 문제가 있습니다. 잠시 후 다시 시도하세요.",
        _ => "AI 서비스가 요청을 처리하지 못했습니다.",
    };
    format!("PROVIDER_FAILED|{provider}|{message} (HTTP {status}){detail}")
}

/// " 자세히: …" with the provider's text masked, on one line and at most 200 characters.
fn error_detail(body: &str) -> String {
    let flat = mask_secrets(body).split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return String::new();
    }
    let mut short: String = flat.chars().take(200).collect();
    if flat.chars().count() > 200 {
        short.push('…');
    }
    format!(" 자세히: {short}")
}

fn http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent("AI-Character/0.2 cloud-first-router")
        .build()
        .map_err(|error| format!("PROVIDER_FAILED|common|클라이언트 생성 실패: {error}"))
}

fn retryable_status(status: u16) -> bool {
    matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
}

pub fn backoff_delay(attempt: u32, retry_after: Option<u64>) -> Duration {
    let base = 2u64.saturating_pow(attempt).min(MAX_BACKOFF_SECS);
    Duration::from_secs(retry_after.unwrap_or(base).min(MAX_BACKOFF_SECS))
}

enum Sent {
    /// Error or fully read response body.
    Done(u16, String),
    /// Successful response whose body is still unread (streaming).
    Open(reqwest::Response),
}

/// Sends a request with exponential backoff. Returns (status, body, retries used).
async fn send_with_retry(
    provider: &str,
    max_retries: u64,
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<(u16, String, i64), (String, i64)> {
    match send_with_retry_inner(provider, max_retries, false, build).await? {
        (Sent::Done(status, text), retries) => Ok((status, text, retries)),
        (Sent::Open(response), retries) => {
            let status = response.status().as_u16();
            let text = response
                .text()
                .await
                .map_err(|error| (format!("PROVIDER_FAILED|{provider}|응답 읽기 실패: {error}"), retries))?;
            Ok((status, text, retries))
        }
    }
}

async fn send_with_retry_inner(
    provider: &str,
    max_retries: u64,
    keep_open: bool,
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<(Sent, i64), (String, i64)> {
    let mut attempt: u32 = 0;
    loop {
        match build().send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                if keep_open && (200..300).contains(&status) {
                    return Ok((Sent::Open(response), attempt as i64));
                }
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.trim().parse::<u64>().ok());
                let text = response.text().await.map_err(|error| {
                    (format!("PROVIDER_FAILED|{provider}|응답 읽기 실패: {error}"), attempt as i64)
                })?;
                let daily_quota = text.to_lowercase().contains("per day") || text.contains("PerDay");
                if retryable_status(status) && !daily_quota && (attempt as u64) < max_retries {
                    tokio_sleep(backoff_delay(attempt, retry_after)).await;
                    attempt += 1;
                    continue;
                }
                return Ok((Sent::Done(status, text), attempt as i64));
            }
            Err(error) => {
                if (attempt as u64) < max_retries && (error.is_timeout() || error.is_connect()) {
                    tokio_sleep(backoff_delay(attempt, None)).await;
                    attempt += 1;
                    continue;
                }
                // A timeout may already have been billed (the provider got the request); a failed
                // connection never reached it. failed_call_may_bill reads these words.
                let message = if error.is_timeout() {
                    "AI 서비스 응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요."
                } else {
                    "AI 서비스에 연결하지 못했습니다. 인터넷 연결을 확인하세요."
                };
                return Err((
                    format!("PROVIDER_FAILED|{provider}|{message}{}", error_detail(&error.to_string())),
                    attempt as i64,
                ));
            }
        }
    }
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

fn as_i64(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0)
}

async fn request_gemini(prompt: &str, model: &str, max_retries: u64) -> Result<(ProviderReply, i64), (String, i64)> {
    let api_key = gemini_api_key().ok_or_else(|| {
        ("PROVIDER_NOT_CONFIGURED|gemini_api|GEMINI_API_KEY 환경변수가 없습니다.".to_string(), 0)
    })?;
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    let body = json!({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2}
    })
    .to_string();
    let client = http_client(90).map_err(|error| (error, 0))?;
    let (status, text, retries) = send_with_retry(GEMINI_PROVIDER, max_retries, || {
        client
            .post(&url)
            .header("x-goog-api-key", &api_key)
            .header("Content-Type", "application/json")
            .body(body.clone())
    })
    .await?;
    if !(200..300).contains(&status) {
        return Err((
            limited_error(GEMINI_PROVIDER, status, &text.chars().take(1000).collect::<String>()),
            retries,
        ));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| (format!("PROVIDER_FAILED|gemini_api|JSON 해석 실패: {error}"), retries))?;
    let mut parts = Vec::new();
    if let Some(candidates) = value.get("candidates").and_then(Value::as_array) {
        for candidate in candidates {
            if let Some(content_parts) = candidate
                .get("content")
                .and_then(|value| value.get("parts"))
                .and_then(Value::as_array)
            {
                for part in content_parts {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        if !text.trim().is_empty() {
                            parts.push(text.trim().to_string());
                        }
                    }
                }
            }
        }
    }
    if parts.is_empty() {
        return Err((
            "PROVIDER_FAILED|gemini_api|Gemini 응답에서 텍스트를 찾지 못했습니다.".to_string(),
            retries,
        ));
    }
    let usage = value.get("usageMetadata");
    Ok((
        ProviderReply {
            text: parts.join("\n"),
            input_tokens: as_i64(usage.and_then(|u| u.get("promptTokenCount"))),
            output_tokens: as_i64(usage.and_then(|u| u.get("candidatesTokenCount"))),
            cached_tokens: as_i64(usage.and_then(|u| u.get("cachedContentTokenCount"))),
            cost_usd: 0.0,
        },
        retries,
    ))
}

async fn request_openrouter(prompt: &str, model: &str, max_retries: u64) -> Result<(ProviderReply, i64), (String, i64)> {
    let api_key = openrouter_api_key().ok_or_else(|| {
        ("PROVIDER_NOT_CONFIGURED|openrouter_api|OPENROUTER_API_KEY 환경변수가 없습니다.".to_string(), 0)
    })?;
    let body = json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "usage": {"include": true}
    })
    .to_string();
    let client = http_client(120).map_err(|error| (error, 0))?;
    let (status, text, retries) = send_with_retry(OPENROUTER_PROVIDER, max_retries, || {
        client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .header("HTTP-Referer", "https://github.com/wch0798/ai-character")
            .header("X-Title", "AI-Character")
            .body(body.clone())
    })
    .await?;
    if !(200..300).contains(&status) {
        return Err((
            limited_error(OPENROUTER_PROVIDER, status, &text.chars().take(1000).collect::<String>()),
            retries,
        ));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| (format!("PROVIDER_FAILED|openrouter_api|JSON 해석 실패: {error}"), retries))?;
    if let Some(error) = value.get("error") {
        let code = error.get("code").and_then(Value::as_u64).unwrap_or(500) as u16;
        return Err((limited_error(OPENROUTER_PROVIDER, code, &error.to_string()), retries));
    }
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if content.is_empty() {
        return Err((
            "PROVIDER_FAILED|openrouter_api|OpenRouter 응답에서 텍스트를 찾지 못했습니다.".to_string(),
            retries,
        ));
    }
    let usage = value.get("usage");
    Ok((
        ProviderReply {
            text: content,
            input_tokens: as_i64(usage.and_then(|u| u.get("prompt_tokens"))),
            output_tokens: as_i64(usage.and_then(|u| u.get("completion_tokens"))),
            cached_tokens: as_i64(usage.and_then(|u| u.pointer("/prompt_tokens_details/cached_tokens"))),
            cost_usd: usage.and_then(|u| u.get("cost")).and_then(Value::as_f64).unwrap_or(0.0),
        },
        retries,
    ))
}

/// Text pieces of one Gemini streaming payload, untrimmed so word spacing survives.
pub fn gemini_delta(value: &Value) -> String {
    let mut text = String::new();
    for candidate in value.get("candidates").and_then(Value::as_array).into_iter().flatten() {
        let parts = candidate.pointer("/content/parts").and_then(Value::as_array);
        for part in parts.into_iter().flatten() {
            if let Some(piece) = part.get("text").and_then(Value::as_str) {
                text.push_str(piece);
            }
        }
    }
    text
}

async fn stream_gemini(
    prompt: &str,
    model: &str,
    max_retries: u64,
    sink: &StreamSink,
) -> Result<(ProviderReply, i64), (String, i64)> {
    let api_key = gemini_api_key().ok_or_else(|| {
        ("PROVIDER_NOT_CONFIGURED|gemini_api|GEMINI_API_KEY 환경변수가 없습니다.".to_string(), 0)
    })?;
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse");
    let body = json!({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2}
    })
    .to_string();
    let client = http_client(180).map_err(|error| (error, 0))?;
    let (sent, retries) = send_with_retry_inner(GEMINI_PROVIDER, max_retries, true, || {
        client
            .post(&url)
            .header("x-goog-api-key", &api_key)
            .header("Content-Type", "application/json")
            .body(body.clone())
    })
    .await?;
    let response = match sent {
        Sent::Open(response) => response,
        Sent::Done(status, text) => {
            return Err((limited_error(GEMINI_PROVIDER, status, &text.chars().take(1000).collect::<String>()), retries));
        }
    };
    sink(StreamEvent::Reset);
    let mut full = String::new();
    let mut usage = Value::Null;
    read_sse(GEMINI_PROVIDER, response, |value| {
        if let Some(error) = value.get("error") {
            let code = error.get("code").and_then(Value::as_u64).unwrap_or(500) as u16;
            return Err(limited_error(GEMINI_PROVIDER, code, &error.to_string()));
        }
        let delta = gemini_delta(&value);
        if !delta.is_empty() {
            full.push_str(&delta);
            sink(StreamEvent::Delta(&delta));
        }
        if let Some(metadata) = value.get("usageMetadata") {
            usage = metadata.clone();
        }
        Ok(())
    })
    .await
    .map_err(|error| (error, retries))?;
    let text = full.trim().to_string();
    if text.is_empty() {
        return Err(("PROVIDER_FAILED|gemini_api|Gemini 응답에서 텍스트를 찾지 못했습니다.".to_string(), retries));
    }
    Ok((
        ProviderReply {
            text,
            input_tokens: as_i64(usage.get("promptTokenCount")),
            output_tokens: as_i64(usage.get("candidatesTokenCount")),
            cached_tokens: as_i64(usage.get("cachedContentTokenCount")),
            cost_usd: 0.0,
        },
        retries,
    ))
}

async fn stream_openrouter(
    prompt: &str,
    model: &str,
    max_retries: u64,
    sink: &StreamSink,
) -> Result<(ProviderReply, i64), (String, i64)> {
    let api_key = openrouter_api_key().ok_or_else(|| {
        ("PROVIDER_NOT_CONFIGURED|openrouter_api|OPENROUTER_API_KEY 환경변수가 없습니다.".to_string(), 0)
    })?;
    let body = json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "usage": {"include": true},
        "stream": true
    })
    .to_string();
    let client = http_client(180).map_err(|error| (error, 0))?;
    let (sent, retries) = send_with_retry_inner(OPENROUTER_PROVIDER, max_retries, true, || {
        client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .header("HTTP-Referer", "https://github.com/wch0798/ai-character")
            .header("X-Title", "AI-Character")
            .body(body.clone())
    })
    .await?;
    let response = match sent {
        Sent::Open(response) => response,
        Sent::Done(status, text) => {
            return Err((limited_error(OPENROUTER_PROVIDER, status, &text.chars().take(1000).collect::<String>()), retries));
        }
    };
    sink(StreamEvent::Reset);
    let mut full = String::new();
    let mut usage = Value::Null;
    read_sse(OPENROUTER_PROVIDER, response, |value| {
        if let Some(error) = value.get("error") {
            let code = error.get("code").and_then(Value::as_u64).unwrap_or(500) as u16;
            return Err(limited_error(OPENROUTER_PROVIDER, code, &error.to_string()));
        }
        if let Some(delta) = value.pointer("/choices/0/delta/content").and_then(Value::as_str) {
            if !delta.is_empty() {
                full.push_str(delta);
                sink(StreamEvent::Delta(delta));
            }
        }
        if let Some(found) = value.get("usage").filter(|found| !found.is_null()) {
            usage = found.clone();
        }
        Ok(())
    })
    .await
    .map_err(|error| (error, retries))?;
    let text = full.trim().to_string();
    if text.is_empty() {
        return Err(("PROVIDER_FAILED|openrouter_api|OpenRouter 응답에서 텍스트를 찾지 못했습니다.".to_string(), retries));
    }
    Ok((
        ProviderReply {
            text,
            input_tokens: as_i64(usage.get("prompt_tokens")),
            output_tokens: as_i64(usage.get("completion_tokens")),
            cached_tokens: as_i64(usage.pointer("/prompt_tokens_details/cached_tokens")),
            cost_usd: usage.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
        },
        retries,
    ))
}

fn compat_error(provider: &str, value: &Value) -> Option<String> {
    let error = value.get("error").filter(|error| !error.is_null())?;
    let code = error
        .get("code")
        .and_then(|code| code.as_u64().or_else(|| code.as_str().and_then(|text| text.parse().ok())))
        .unwrap_or(500) as u16;
    Some(limited_error(provider, code, &error.to_string()))
}

/// Any extra free service: same chat-completions request, streamed when a sink is given.
async fn request_free_service(
    service: &FreeService,
    prompt: &str,
    model: &str,
    max_retries: u64,
    sink: Option<&StreamSink>,
) -> Result<(ProviderReply, i64), (String, i64)> {
    let provider = service.id;
    let key = match service.key_env {
        Some(name) => Some(env_key(name).ok_or_else(|| {
            (format!("PROVIDER_NOT_CONFIGURED|{provider}|{name}가 없습니다."), 0)
        })?),
        None => None,
    };
    let url = free_service_url(service)
        .ok_or_else(|| (format!("PROVIDER_NOT_CONFIGURED|{provider}|연결 주소를 만들 수 없습니다 (계정 ID 확인)."), 0))?;
    let mut body = json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "stream": sink.is_some()
    });
    if provider == "zai_api" {
        body["thinking"] = json!({"type": "disabled"});
    }
    let body = body.to_string();
    let client = http_client(if key.is_none() { 600 } else { 180 }).map_err(|error| (error, 0))?;
    let (sent, retries) = send_with_retry_inner(provider, max_retries, sink.is_some(), || {
        let request = client.post(&url).header("Content-Type", "application/json").body(body.clone());
        match &key {
            Some(key) => request.bearer_auth(key),
            None => request,
        }
    })
    .await?;
    let not_found = || (format!("PROVIDER_FAILED|{provider}|{} 응답에서 텍스트를 찾지 못했습니다.", service.label), retries);
    let Some(sink) = sink else {
        let Sent::Done(status, text) = sent else {
            return Err((format!("PROVIDER_FAILED|{provider}|응답을 읽지 못했습니다."), retries));
        };
        if !(200..300).contains(&status) {
            return Err((limited_error(provider, status, &text.chars().take(1000).collect::<String>()), retries));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| (format!("PROVIDER_FAILED|{provider}|JSON 해석 실패: {error}"), retries))?;
        if let Some(error) = compat_error(provider, &value) {
            return Err((error, retries));
        }
        let content = value.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or_default().trim();
        if content.is_empty() {
            return Err(not_found());
        }
        let usage = value.get("usage");
        return Ok((
            ProviderReply {
                text: content.to_string(),
                input_tokens: as_i64(usage.and_then(|u| u.get("prompt_tokens"))),
                output_tokens: as_i64(usage.and_then(|u| u.get("completion_tokens"))),
                cached_tokens: as_i64(usage.and_then(|u| u.pointer("/prompt_tokens_details/cached_tokens"))),
                cost_usd: 0.0,
            },
            retries,
        ));
    };
    let response = match sent {
        Sent::Open(response) => response,
        Sent::Done(status, text) => {
            return Err((limited_error(provider, status, &text.chars().take(1000).collect::<String>()), retries));
        }
    };
    sink(StreamEvent::Reset);
    let mut full = String::new();
    let mut usage = Value::Null;
    read_sse(provider, response, |value| {
        if let Some(error) = compat_error(provider, &value) {
            return Err(error);
        }
        if let Some(delta) = value.pointer("/choices/0/delta/content").and_then(Value::as_str) {
            if !delta.is_empty() {
                full.push_str(delta);
                sink(StreamEvent::Delta(delta));
            }
        }
        if let Some(found) = value.get("usage").or_else(|| value.pointer("/x_groq/usage")).filter(|found| !found.is_null()) {
            usage = found.clone();
        }
        Ok(())
    })
    .await
    .map_err(|error| (error, retries))?;
    let text = full.trim().to_string();
    if text.is_empty() {
        return Err(not_found());
    }
    Ok((
        ProviderReply {
            text,
            input_tokens: as_i64(usage.get("prompt_tokens")),
            output_tokens: as_i64(usage.get("completion_tokens")),
            cached_tokens: 0,
            cost_usd: 0.0,
        },
        retries,
    ))
}

async fn request_openai(prompt: &str, model: &str, max_retries: u64) -> Result<(ProviderReply, i64), (String, i64)> {
    let api_key = openai_api_key().ok_or_else(|| {
        ("PROVIDER_NOT_CONFIGURED|openai_api|OPENAI_API_KEY 환경변수가 없습니다.".to_string(), 0)
    })?;
    let body = json!({
        "model": model,
        "input": prompt,
        "text": {"verbosity": "low"}
    })
    .to_string();
    let client = http_client(90).map_err(|error| (error, 0))?;
    let (status, text, retries) = send_with_retry(OPENAI_PROVIDER, max_retries, || {
        client
            .post("https://api.openai.com/v1/responses")
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .body(body.clone())
    })
    .await?;
    if !(200..300).contains(&status) {
        return Err((
            limited_error(OPENAI_PROVIDER, status, &text.chars().take(1000).collect::<String>()),
            retries,
        ));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| (format!("PROVIDER_FAILED|openai_api|JSON 해석 실패: {error}"), retries))?;

    let mut output = value
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if output.is_empty() {
        let mut parts = Vec::new();
        if let Some(outputs) = value.get("output").and_then(Value::as_array) {
            for item in outputs {
                if let Some(contents) = item.get("content").and_then(Value::as_array) {
                    for content in contents {
                        if let Some(text) = content.get("text").and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                parts.push(text.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
        output = parts.join("\n");
    }
    if output.is_empty() {
        return Err((
            "PROVIDER_FAILED|openai_api|OpenAI 응답에서 텍스트를 찾지 못했습니다.".to_string(),
            retries,
        ));
    }
    let usage = value.get("usage");
    let input_tokens = as_i64(usage.and_then(|u| u.get("input_tokens")));
    let output_tokens = as_i64(usage.and_then(|u| u.get("output_tokens")));
    Ok((
        ProviderReply {
            text: output,
            input_tokens,
            output_tokens,
            cached_tokens: as_i64(usage.and_then(|u| u.pointer("/input_tokens_details/cached_tokens"))),
            // OpenAI reports tokens, not money: price them by model.
            cost_usd: policy_engine::estimate_model_usd(model, input_tokens, output_tokens),
        },
        retries,
    ))
}

fn cache_key(provider: &str, model: &str, prompt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(provider.as_bytes());
    hasher.update([0]);
    hasher.update(model.as_bytes());
    hasher.update([0]);
    hasher.update(prompt.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// What a call counts against the daily paid limit. Paid calls are priced by model (never
/// below the flat setting); a paid call that failed after the provider worked on it still
/// counts its input, since it may have been billed.
fn estimated_spend(
    cost_class: &str,
    model: &str,
    prompt: &str,
    reply: &ProviderReply,
    error: Option<&str>,
    flat_per_1k: f64,
) -> f64 {
    let flat = policy_engine::estimate_paid_usd(reply.input_tokens, reply.output_tokens, flat_per_1k);
    if cost_class != "paid" {
        return flat;
    }
    if let Some(error) = error {
        return if policy_engine::failed_call_may_bill(error) {
            policy_engine::estimate_model_usd(model, policy_engine::estimate_tokens(prompt), 0)
        } else {
            0.0
        };
    }
    let input = if reply.input_tokens > 0 { reply.input_tokens } else { policy_engine::estimate_tokens(prompt) };
    let output = if reply.output_tokens > 0 { reply.output_tokens } else { policy_engine::estimate_tokens(&reply.text) };
    reply.cost_usd.max(flat).max(policy_engine::estimate_model_usd(model, input, output))
}

fn record(
    context: &CallContext,
    provider: &str,
    model: &str,
    cost_class: &str,
    policy: &PolicySettings,
    started: Instant,
    outcome: &Result<(ProviderReply, i64), (String, i64)>,
    cache_hit: bool,
    prompt: &str,
) {
    let (reply, retries, status, error) = match outcome {
        Ok((reply, retries)) => (reply.clone(), *retries, "ok", None),
        Err((error, retries)) => (ProviderReply::default(), *retries, "error", Some(error.clone())),
    };
    let estimated = if cache_hit {
        0.0
    } else {
        estimated_spend(cost_class, model, prompt, &reply, error.as_deref(), policy.estimated_paid_usd_per_1k_tokens)
    };
    usage_ledger::record_usage(&UsageEntry {
        session_id: context.session_id.clone(),
        task_id: context.task_id.clone(),
        role: context.role.clone(),
        provider: provider.to_string(),
        model: model.to_string(),
        cost_class: cost_class.to_string(),
        input_tokens: reply.input_tokens,
        output_tokens: reply.output_tokens,
        cached_tokens: reply.cached_tokens,
        cost_usd: reply.cost_usd,
        estimated_paid_usd: estimated,
        latency_ms: started.elapsed().as_millis().min(i64::MAX as u128) as i64,
        retries,
        cache_hit,
        status: status.to_string(),
        error,
    });
    if let Ok(connection) = usage_ledger::open_ledger() {
        let _ = usage_ledger::record_model_result(
            &connection,
            provider,
            model,
            outcome.is_ok(),
            outcome.as_ref().err().map(|(error, _)| error.as_str()),
        );
    }
}

async fn call_model(
    provider: &str,
    model: &str,
    cost_class: &str,
    prompt: &str,
    context: &CallContext,
    policy: &PolicySettings,
) -> Result<String, String> {
    let fingerprint = context.cache_fingerprint.clone().unwrap_or_default();
    let key = cache_key(provider, model, prompt);
    if policy.prompt_cache_enabled && !fingerprint.is_empty() {
        if let Ok(connection) = usage_ledger::open_ledger() {
            if let Some(cached) = usage_ledger::cache_get(&connection, &key, &fingerprint) {
                record(
                    context,
                    provider,
                    model,
                    cost_class,
                    policy,
                    Instant::now(),
                    &Ok((ProviderReply { text: cached.clone(), ..Default::default() }, 0)),
                    true,
                    prompt,
                );
                return Ok(cached);
            }
        }
    }

    policy_engine::reserve_call(context.session_id.as_deref(), policy.max_calls_per_session)?;
    let started = Instant::now();
    let retries = policy.max_retries_per_call;
    let outcome = match (provider, context.stream.as_ref()) {
        (GEMINI_PROVIDER, Some(sink)) => stream_gemini(prompt, model, retries, sink).await,
        (GEMINI_PROVIDER, None) => request_gemini(prompt, model, retries).await,
        (OPENROUTER_PROVIDER, Some(sink)) => stream_openrouter(prompt, model, retries, sink).await,
        (OPENROUTER_PROVIDER, None) => request_openrouter(prompt, model, retries).await,
        (OPENAI_PROVIDER, _) => request_openai(prompt, model, retries).await,
        (other, sink) => match free_service(other) {
            Some(service) => request_free_service(service, prompt, model, retries, sink).await,
            None => Err((format!("PROVIDER_FAILED|{other}|지원하지 않는 자동 Provider입니다."), 0)),
        },
    };
    if let (Err(_), Some(sink)) = (&outcome, context.stream.as_ref()) {
        sink(StreamEvent::Reset);
    }
    record(context, provider, model, cost_class, policy, started, &outcome, false, prompt);
    let (reply, _) = outcome.map_err(|(error, _)| error)?;
    if policy.prompt_cache_enabled && !fingerprint.is_empty() {
        if let Ok(connection) = usage_ledger::open_ledger() {
            let _ = usage_ledger::cache_put(&connection, &key, provider, model, &fingerprint, &reply.text);
        }
    }
    Ok(reply.text)
}

fn is_limited(error: &str) -> bool {
    error.starts_with("PROVIDER_LIMITED|") || error.contains("HTTP 404") || error.contains("HTTP 503")
}

pub async fn run_provider_with_context(
    provider: &str,
    prompt: &str,
    settings: &AppSettings,
    context: &CallContext,
) -> Result<String, String> {
    let prompt = validate_prompt(prompt)?;
    let policy = policy_settings(settings);
    match provider.trim().to_ascii_lowercase().as_str() {
        GEMINI_PROVIDER => {
            if !settings.gemini_api_enabled {
                return Err("PROVIDER_DISABLED|gemini_api|Gemini 자동 Provider가 꺼져 있습니다.".to_string());
            }
            let model = gemini_model();
            if !gemini_model_is_free(&model) {
                policy_engine::require_paid_approval(GEMINI_PROVIDER, context.session_id.as_deref())?;
                return call_model(GEMINI_PROVIDER, &model, "paid", &prompt, context, &policy).await;
            }
            let mut last_error = String::new();
            for candidate in gemini_candidates() {
                match call_model(GEMINI_PROVIDER, &candidate, "free", &prompt, context, &policy).await {
                    Ok(text) => return Ok(text),
                    Err(error) if is_limited(&error) => last_error = error,
                    Err(error) => return Err(error),
                }
            }
            Err(if last_error.is_empty() {
                "PROVIDER_FAILED|gemini_api|사용할 무료 Gemini 모델이 없습니다.".to_string()
            } else {
                last_error
            })
        }
        OPENROUTER_PROVIDER => {
            if !policy.openrouter_enabled {
                return Err("PROVIDER_DISABLED|openrouter_api|OpenRouter 무료 모델이 꺼져 있습니다.".to_string());
            }
            if openrouter_api_key().is_none() {
                return Err("PROVIDER_NOT_CONFIGURED|openrouter_api|OPENROUTER_API_KEY 환경변수가 없습니다.".to_string());
            }
            if openrouter_candidates(1).is_empty() {
                let _ = refresh_openrouter_models(false).await;
            }
            let candidates = openrouter_candidates(MAX_FREE_MODEL_ATTEMPTS);
            if candidates.is_empty() {
                return Err("PROVIDER_LIMITED|openrouter_api|확인된 무료 모델이 없습니다.".to_string());
            }
            let mut last_error = String::new();
            for model in candidates {
                let free = env_key("OPENROUTER_MODEL").is_none()
                    || usage_ledger::open_ledger()
                        .map(|connection| usage_ledger::model_is_free(&connection, OPENROUTER_PROVIDER, &model))
                        .unwrap_or(false);
                if !free {
                    policy_engine::require_paid_approval(OPENROUTER_PROVIDER, context.session_id.as_deref())?;
                }
                let class = if free { "free" } else { "paid" };
                match call_model(OPENROUTER_PROVIDER, &model, class, &prompt, context, &policy).await {
                    Ok(text) => return Ok(text),
                    Err(error) if is_limited(&error) => last_error = error,
                    Err(error) => return Err(error),
                }
            }
            Err(last_error)
        }
        OPENAI_PROVIDER => {
            if !settings.allow_paid_openai_api {
                return Err("PROVIDER_DISABLED|openai_api|OpenAI 유료 API 사용 허용이 꺼져 있습니다.".to_string());
            }
            policy_engine::require_paid_approval(OPENAI_PROVIDER, context.session_id.as_deref())?;
            call_model(OPENAI_PROVIDER, &openai_model(), "paid", &prompt, context, &policy).await
        }
        FREE_POOL_PROVIDER => run_free_pool(&prompt, context, &policy).await,
        other => Err(format!("PROVIDER_FAILED|{other}|지원하지 않는 자동 Provider입니다.")),
    }
}

/// Errors that must end the whole pool instead of moving on to the next service.
fn stops_free_pool(error: &str) -> bool {
    error.starts_with("BUDGET_EXCEEDED|") || error.starts_with("PAID_APPROVAL_REQUIRED|")
}

async fn run_free_pool(prompt: &str, context: &CallContext, policy: &PolicySettings) -> Result<String, String> {
    let mut last_error: Option<String> = None;
    for service in FREE_SERVICES.iter().filter(|service| free_service_configured(service)) {
        let models = local_models(service).await;
        for model in models.iter().take(MAX_MODELS_PER_FREE_SERVICE) {
            match call_model(service.id, model, "free", prompt, context, policy).await {
                Ok(text) => return Ok(text),
                Err(error) if stops_free_pool(&error) => return Err(error),
                Err(error) => {
                    let skip_service = error.starts_with("PROVIDER_AUTH|") || error.starts_with("PROVIDER_NOT_CONFIGURED|");
                    last_error = Some(error);
                    if skip_service {
                        break;
                    }
                }
            }
        }
    }
    Err(match last_error {
        Some(error) if error.starts_with("PROVIDER_LIMITED|") => error,
        Some(error) => format!("PROVIDER_LIMITED|{FREE_POOL_PROVIDER}|추가 무료 AI가 모두 실패했습니다. 마지막 오류: {error}"),
        None => format!("PROVIDER_NOT_CONFIGURED|{FREE_POOL_PROVIDER}|추가 무료 AI 키가 없고 Ollama도 실행 중이 아닙니다."),
    })
}

/// Keeps only models whose prompt and completion prices are both exactly zero.
pub fn parse_openrouter_free_models(value: &Value) -> Vec<(String, i64)> {
    let Some(models) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let zero = |value: Option<&Value>| match value {
        Some(Value::String(text)) => text.trim().parse::<f64>().map(|v| v == 0.0).unwrap_or(false),
        Some(Value::Number(number)) => number.as_f64() == Some(0.0),
        _ => false,
    };
    models
        .iter()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?.to_string();
            let pricing = model.get("pricing")?;
            if !(zero(pricing.get("prompt")) && zero(pricing.get("completion"))) {
                return None;
            }
            if pricing.get("request").is_some() && !zero(pricing.get("request")) {
                return None;
            }
            let context = model.get("context_length").and_then(Value::as_i64).unwrap_or(0);
            Some((id, context))
        })
        .collect()
}

pub async fn refresh_openrouter_models(force: bool) -> Result<usize, String> {
    let connection = usage_ledger::open_ledger()?;
    if !force {
        if let Some(at) = usage_ledger::models_refreshed_at(&connection, OPENROUTER_PROVIDER) {
            if usage_ledger::now_millis() - at < MODEL_REFRESH_MS {
                return Ok(0);
            }
        }
    }
    drop(connection);
    let client = http_client(30)?;
    let text = client
        .get("https://openrouter.ai/api/v1/models")
        .send()
        .await
        .map_err(|error| format!("OpenRouter 모델 목록 요청 실패: {error}"))?
        .text()
        .await
        .map_err(|error| format!("OpenRouter 모델 목록 읽기 실패: {error}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| format!("OpenRouter 모델 목록 해석 실패: {error}"))?;
    let free = parse_openrouter_free_models(&value);
    if free.is_empty() {
        return Err("OpenRouter에서 무료 모델을 찾지 못해 기존 목록을 유지합니다.".to_string());
    }
    let connection = usage_ledger::open_ledger()?;
    let ids = free.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    for (id, context) in &free {
        usage_ledger::upsert_model(&connection, OPENROUTER_PROVIDER, id, true, "openrouter_pricing", *context)?;
    }
    usage_ledger::deactivate_missing_models(&connection, OPENROUTER_PROVIDER, &ids)?;
    Ok(free.len())
}

pub async fn refresh_gemini_models() -> Result<usize, String> {
    let Some(api_key) = gemini_api_key() else {
        return Ok(0);
    };
    let client = http_client(30)?;
    let text = client
        .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200")
        .header("x-goog-api-key", api_key)
        .send()
        .await
        .map_err(|error| format!("Gemini 모델 목록 요청 실패: {}", mask_secrets(&error.to_string())))?
        .text()
        .await
        .map_err(|error| format!("Gemini 모델 목록 읽기 실패: {error}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| format!("Gemini 모델 목록 해석 실패: {error}"))?;
    let free_list = gemini_free_models();
    let mut ids = Vec::new();
    let connection = usage_ledger::open_ledger()?;
    for model in value.get("models").and_then(Value::as_array).cloned().unwrap_or_default() {
        let supports = model
            .get("supportedGenerationMethods")
            .and_then(Value::as_array)
            .map(|methods| methods.iter().any(|m| m.as_str() == Some("generateContent")))
            .unwrap_or(false);
        let Some(name) = model.get("name").and_then(Value::as_str) else { continue };
        if !supports {
            continue;
        }
        let id = name.trim_start_matches("models/").to_string();
        let context = model.get("inputTokenLimit").and_then(Value::as_i64).unwrap_or(0);
        let is_free = free_list.iter().any(|free| free == &id);
        usage_ledger::upsert_model(&connection, GEMINI_PROVIDER, &id, is_free, "gemini_free_models_setting", context)?;
        ids.push(id);
    }
    if ids.is_empty() {
        return Err("Gemini 모델 목록이 비어 있어 기존 목록을 유지합니다.".to_string());
    }
    usage_ledger::deactivate_missing_models(&connection, GEMINI_PROVIDER, &ids)?;
    Ok(ids.len())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeAutoReadiness {
    pub gemini_api_configured: bool,
    pub openrouter_api_configured: bool,
    pub jina_api_configured: bool,
    pub claude_cli_ready: bool,
    pub cradle_enabled: bool,
    pub auto_web_search: bool,
    pub gemini_api_enabled: bool,
    pub hands_free_ready: bool,
    pub keys_env_path: Option<String>,
    pub message: String,
    pub next_steps: Vec<String>,
}

fn jina_api_configured() -> bool {
    env_key("JINA_API_KEY").is_some()
}

pub fn free_auto_readiness(settings: &AppSettings, claude_cli_ready: bool) -> FreeAutoReadiness {
    let gemini_api_configured = gemini_api_key().is_some();
    let openrouter_api_configured = openrouter_api_key().is_some();
    let jina_api_configured = jina_api_configured();
    let policy = policy_settings(settings);
    let free_pool_ready = FREE_SERVICES.iter().any(free_service_configured);
    let free_api_ready = (settings.gemini_api_enabled && gemini_api_configured)
        || (policy.openrouter_enabled && openrouter_api_configured)
        || free_pool_ready;
    let hands_free_ready = settings.cradle_enabled && free_api_ready;
    let keys_env_path = crate::local_env::loaded_keys_path()
        .or_else(|| Some(crate::local_env::preferred_keys_path().to_string_lossy().into_owned()));

    let mut next_steps = Vec::new();
    if !settings.cradle_enabled || !settings.auto_web_search || !settings.gemini_api_enabled {
        next_steps.push("아래 '무료 자동 모드 켜기'를 누르면 추천 설정이 한 번에 켜집니다.".to_string());
    }
    if !gemini_api_configured && !openrouter_api_configured && !free_pool_ready {
        next_steps.push(
            "설정에서 '키 파일 열기'로 keys.env에 GEMINI_API_KEY=... 또는 OPENROUTER_API_KEY=... 를 넣고 앱을 다시 실행하세요."
                .to_string(),
        );
    } else if !openrouter_api_configured {
        next_steps.push("OPENROUTER_API_KEY를 넣으면 Gemini 한도 초과 시 무료 대체 경로가 생깁니다.".to_string());
    }
    if !jina_api_configured {
        next_steps.push(
            "웹 자동검색은 같은 keys.env에 JINA_API_KEY=... 를 넣으면 됩니다. (없어도 채팅은 동작)"
                .to_string(),
        );
    }
    if !claude_cli_ready {
        next_steps.push("로컬 파일 수정/CLI 총괄이 필요하면 Claude CLI를 설치·로그인하세요.".to_string());
    }

    let message = if hands_free_ready && jina_api_configured && claude_cli_ready {
        "준비 완료 — 채팅만 치면 자동으로 검색·분배·답변합니다.".to_string()
    } else if hands_free_ready {
        "자동 답변 준비됨 — 웹검색/CLI는 있으면 더 강력해집니다.".to_string()
    } else if gemini_api_configured || openrouter_api_configured || free_pool_ready {
        "무료 API 키는 있습니다. 무료 자동 모드만 켜면 됩니다.".to_string()
    } else {
        "아직 자동 모드 준비가 안 됐습니다. 키 파일만 채우면 됩니다.".to_string()
    };

    FreeAutoReadiness {
        gemini_api_configured,
        openrouter_api_configured,
        jina_api_configured,
        claude_cli_ready,
        cradle_enabled: settings.cradle_enabled,
        auto_web_search: settings.auto_web_search,
        gemini_api_enabled: settings.gemini_api_enabled,
        hands_free_ready,
        keys_env_path,
        message,
        next_steps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_lines_survive_chunk_boundaries_and_multibyte_text() {
        let mut lines = SseLines::default();
        let event = "data: {\"t\":\"안녕\"}\r\n\r\n: keep-alive\n";
        let bytes = event.as_bytes();
        let split = 12;
        assert!(lines.push(&bytes[..split]).is_empty());
        assert_eq!(lines.push(&bytes[split..]), vec!["{\"t\":\"안녕\"}".to_string()]);
        assert!(lines.push(b"data: [DONE]\n").is_empty());
        assert!(lines.push(b"data: {\"last\":1}").is_empty());
        assert_eq!(lines.finish(), Some("{\"last\":1}".to_string()));
    }

    #[test]
    fn gemini_delta_keeps_spacing() {
        let value = json!({"candidates": [{"content": {"parts": [{"text": "Hello"}, {"text": " world "}]}}]});
        assert_eq!(gemini_delta(&value), "Hello world ");
        assert_eq!(gemini_delta(&json!({"usageMetadata": {}})), "");
    }

    #[test]
    fn only_zero_priced_openrouter_models_are_free() {
        let value = json!({"data": [
            {"id": "a/free:free", "context_length": 32000, "pricing": {"prompt": "0", "completion": "0"}},
            {"id": "b/paid", "context_length": 128000, "pricing": {"prompt": "0.000001", "completion": "0.000002"}},
            {"id": "c/half", "pricing": {"prompt": "0", "completion": "0.00001"}},
            {"id": "d/request-fee", "pricing": {"prompt": "0", "completion": "0", "request": "0.01"}},
            {"id": "e/no-pricing"}
        ]});
        let free = parse_openrouter_free_models(&value);
        assert_eq!(free, vec![("a/free:free".to_string(), 32000)]);
    }

    #[test]
    fn backoff_grows_and_respects_retry_after_cap() {
        assert_eq!(backoff_delay(0, None), Duration::from_secs(1));
        assert_eq!(backoff_delay(2, None), Duration::from_secs(4));
        assert_eq!(backoff_delay(10, None), Duration::from_secs(MAX_BACKOFF_SECS));
        assert_eq!(backoff_delay(0, Some(7)), Duration::from_secs(7));
        assert_eq!(backoff_delay(0, Some(999)), Duration::from_secs(MAX_BACKOFF_SECS));
    }

    #[test]
    fn limited_errors_are_classified_and_masked() {
        let error = limited_error("gemini_api", 429, "quota exceeded for AIzaSyA1234567890abcdefghijklmnopqrs");
        assert!(error.starts_with("PROVIDER_LIMITED|gemini_api|"));
        assert!(!error.contains("AIzaSy"));
        assert!(limited_error("x", 401, "no").starts_with("PROVIDER_AUTH|"));
        assert!(limited_error("x", 500, "boom").starts_with("PROVIDER_FAILED|"));
    }

    #[test]
    fn provider_errors_read_in_korean_with_a_short_detail() {
        let auth = limited_error("openai_api", 401, "{\"error\":{\"message\":\"Incorrect API key\"}}");
        assert!(auth.contains("API 키가 맞지 않거나") && auth.contains("(HTTP 401)") && auth.contains("자세히: "));
        let server = limited_error("openai_api", 503, &"x".repeat(5000));
        assert!(server.contains("서버에 문제") && server.contains("(HTTP 503)"));
        assert!(server.chars().count() < 400);
        assert!(is_limited(&server));
        assert!(!limited_error("x", 500, "").contains("자세히"));
    }

    #[test]
    fn paid_spend_is_priced_by_model_and_counts_billable_failures() {
        let reply = ProviderReply { input_tokens: 1_000_000, output_tokens: 1_000_000, ..Default::default() };
        assert!((estimated_spend("paid", "gpt-4o", "", &reply, None, 0.003) - 12.5).abs() < 1e-9);
        let failed = ProviderReply::default();
        let prompt = "a".repeat(2000);
        let billed = estimated_spend("paid", "gpt-4o", &prompt, &failed, Some("PROVIDER_FAILED|openai_api|서버 (HTTP 502)"), 0.003);
        assert!(billed > 0.0);
        assert_eq!(estimated_spend("paid", "gpt-4o", &prompt, &failed, Some("PROVIDER_AUTH|openai_api|키 (HTTP 401)"), 0.003), 0.0);
        assert_eq!(estimated_spend("free", "gpt-4o", &prompt, &failed, Some("PROVIDER_FAILED|x|(HTTP 502)"), 0.003), 0.0);
    }

    #[test]
    fn cache_key_depends_on_all_inputs() {
        let a = cache_key("p", "m", "prompt");
        assert_eq!(a, cache_key("p", "m", "prompt"));
        assert_ne!(a, cache_key("p", "m2", "prompt"));
        assert_ne!(a, cache_key("p2", "m", "prompt"));
    }

    #[test]
    fn free_services_have_unique_ids_urls_and_end_with_local() {
        let mut ids = std::collections::HashSet::new();
        for service in FREE_SERVICES {
            assert!(ids.insert(service.id), "duplicate {}", service.id);
            if !matches!(service.id, "cloudflare_api" | REMOTE_OLLAMA_PROVIDER) {
                assert!(free_service_url(service).is_some(), "url for {}", service.id);
            }
            assert_eq!(service.key_env.is_none(), is_local_service(service.id), "{}", service.id);
        }
        let first_local = FREE_SERVICES.iter().position(|service| is_local_service(service.id)).unwrap();
        assert!(FREE_SERVICES[first_local..].iter().all(|service| is_local_service(service.id)));
        assert!(free_service(FREE_POOL_PROVIDER).is_none());
    }

    #[test]
    fn factual_fallback_skips_code_and_media_models() {
        assert!(!factual_chat_model("cohere/north-mini-code:free"));
        assert!(!factual_chat_model("google/lyria-3-pro-preview"));
        assert!(!factual_chat_model("nvidia/nemotron-3.5-content-safety:free"));
        assert!(factual_chat_model("google/gemma-4-31b-it:free"));
        assert!(factual_rank("google/gemma-4-31b-it:free") < factual_rank("dots-studio/dots-3-note-preview:free"));
        assert_eq!(gemini_model(), "gemini-3.8-flash");
        assert_eq!(gemini_candidates()[0], "gemini-3.8-flash");
        assert!(gemini_candidates().contains(&"gemini-3.5-flash-lite".to_string()));
    }

    #[test]
    fn free_korean_and_chinese_services_lock_to_free_models() {
        assert_eq!(free_service_models(free_service("skt_ax_api").unwrap()), vec!["ax4"]);
        assert_eq!(free_service_models(free_service("hunyuan_api").unwrap()), vec!["hunyuan-lite"]);
        assert!(free_service("hasa_api").unwrap().model_env.is_some());
    }

    #[test]
    fn locked_services_ignore_model_overrides() {
        let zai = free_service("zai_api").unwrap();
        assert!(zai.locked && zai.model_env.is_none());
        assert_eq!(free_service_models(zai), vec!["glm-4.7-flash", "glm-4.5-flash"]);
        let silicon = free_service("siliconflow_api").unwrap();
        assert!(silicon.locked && silicon.model_env.is_none());
    }

    #[test]
    fn cloudflare_url_needs_a_clean_account_id() {
        let cloudflare = free_service("cloudflare_api").unwrap();
        crate::process_util::set_secret_value("CLOUDFLARE_ACCOUNT_ID", None);
        assert!(free_service_url(cloudflare).is_none());
        crate::process_util::set_secret_value("CLOUDFLARE_ACCOUNT_ID", Some("abc/../x".into()));
        assert!(free_service_url(cloudflare).is_none());
        crate::process_util::set_secret_value("CLOUDFLARE_ACCOUNT_ID", Some("0123abcd".into()));
        assert_eq!(
            free_service_url(cloudflare).unwrap(),
            "https://api.cloudflare.com/client/v4/accounts/0123abcd/ai/v1/chat/completions"
        );
        crate::process_util::set_secret_value("CLOUDFLARE_ACCOUNT_ID", None);
    }

    #[test]
    fn ollama_models_skip_embeddings() {
        let value = json!({"models": [{"name": "qwen3:8b"}, {"name": "nomic-embed-text:latest"}, {"name": "llama3.2"}]});
        assert_eq!(parse_ollama_models(&value), vec!["qwen3:8b", "llama3.2"]);
        assert!(parse_ollama_models(&json!({})).is_empty());
    }

    #[test]
    fn compat_errors_accept_numeric_and_text_codes() {
        let limited = compat_error("groq_api", &json!({"error": {"code": "429", "message": "rate"}})).unwrap();
        assert!(limited.starts_with("PROVIDER_LIMITED|groq_api|"));
        assert!(compat_error("groq_api", &json!({"error": null})).is_none());
        assert!(compat_error("groq_api", &json!({"choices": []})).is_none());
        assert!(stops_free_pool("BUDGET_EXCEEDED|policy|x"));
        assert!(!stops_free_pool("PROVIDER_LIMITED|groq_api|x"));
    }
}
