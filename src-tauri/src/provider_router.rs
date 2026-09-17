use crate::settings::AppSettings;
use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::time::Duration;

const GEMINI_PROVIDER: &str = "gemini_api";
const OPENAI_PROVIDER: &str = "openai_api";
const DEFAULT_GEMINI_MODEL: &str = "gemini-2.5-flash";
const DEFAULT_OPENAI_MODEL: &str = "gpt-5-mini";
const MAX_PROMPT_CHARS: usize = 80_000;

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

fn env_key(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn gemini_api_key() -> Option<String> {
    env::var("GEMINI_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn openai_api_key() -> Option<String> {
    env::var("OPENAI_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn gemini_model() -> String {
    env_key("GEMINI_MODEL").unwrap_or_else(|| DEFAULT_GEMINI_MODEL.to_string())
}

fn openai_model() -> String {
    env_key("OPENAI_MODEL").unwrap_or_else(|| DEFAULT_OPENAI_MODEL.to_string())
}

pub fn provider_statuses(settings: &AppSettings) -> Vec<AutomaticProviderStatus> {
    let gemini_configured = gemini_api_key().is_some();
    let openai_configured = openai_api_key().is_some();

    vec![
        AutomaticProviderStatus {
            provider: GEMINI_PROVIDER.to_string(),
            enabled: settings.gemini_api_enabled,
            configured: gemini_configured,
            available: settings.gemini_api_enabled && gemini_configured,
            model: gemini_model(),
            cost_class: "free_first".to_string(),
            reason: if !settings.gemini_api_enabled {
                Some("설정에서 Gemini 자동 Provider가 꺼져 있습니다.".to_string())
            } else if !gemini_configured {
                Some("GEMINI_API_KEY 환경변수가 없습니다.".to_string())
            } else {
                None
            },
        },
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
                None
            },
        },
    ]
}

fn validate_prompt(prompt: &str) -> Result<String, String> {
    let clean = prompt.trim();
    if clean.is_empty() {
        return Err("PROVIDER_FAILED|common|프롬프트가 비어 있습니다.".to_string());
    }
    if clean.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "PROVIDER_FAILED|common|프롬프트는 {MAX_PROMPT_CHARS}자 이하여야 합니다."
        ));
    }
    Ok(clean.to_string())
}

fn limited_error(provider: &str, status: u16, body: &str) -> String {
    let lower = body.to_lowercase();
    if status == 429
        || lower.contains("resource_exhausted")
        || lower.contains("quota")
        || lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("usage limit")
    {
        return format!("PROVIDER_LIMITED|{provider}|HTTP {status}: {body}");
    }
    if status == 401 || status == 403 {
        return format!("PROVIDER_AUTH|{provider}|HTTP {status}: {body}");
    }
    format!("PROVIDER_FAILED|{provider}|HTTP {status}: {body}")
}

async fn request_gemini(prompt: &str) -> Result<String, String> {
    let api_key = gemini_api_key()
        .ok_or_else(|| "PROVIDER_NOT_CONFIGURED|gemini_api|GEMINI_API_KEY 환경변수가 없습니다.".to_string())?;
    let model = gemini_model();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    );
    let body = json!({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2}
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent("AI-Character/0.1 automatic-provider-router")
        .build()
        .map_err(|error| format!("PROVIDER_FAILED|gemini_api|클라이언트 생성 실패: {error}"))?;
    let response = client
        .post(url)
        .header("x-goog-api-key", api_key)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| format!("PROVIDER_FAILED|gemini_api|요청 실패: {error}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| format!("PROVIDER_FAILED|gemini_api|응답 읽기 실패: {error}"))?;
    if !(200..300).contains(&status) {
        return Err(limited_error(GEMINI_PROVIDER, status, &text.chars().take(1000).collect::<String>()));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("PROVIDER_FAILED|gemini_api|JSON 해석 실패: {error}"))?;
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
        return Err("PROVIDER_FAILED|gemini_api|Gemini 응답에서 텍스트를 찾지 못했습니다.".to_string());
    }
    Ok(parts.join("\n"))
}

async fn request_openai(prompt: &str, settings: &AppSettings) -> Result<String, String> {
    if !settings.allow_paid_openai_api {
        return Err("PROVIDER_DISABLED|openai_api|OpenAI 유료 API 사용 허용이 꺼져 있습니다.".to_string());
    }
    let api_key = openai_api_key()
        .ok_or_else(|| "PROVIDER_NOT_CONFIGURED|openai_api|OPENAI_API_KEY 환경변수가 없습니다.".to_string())?;
    let model = openai_model();
    let body = json!({
        "model": model,
        "input": prompt,
        "text": {"verbosity": "low"}
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent("AI-Character/0.1 automatic-provider-router")
        .build()
        .map_err(|error| format!("PROVIDER_FAILED|openai_api|클라이언트 생성 실패: {error}"))?;
    let response = client
        .post("https://api.openai.com/v1/responses")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|error| format!("PROVIDER_FAILED|openai_api|요청 실패: {error}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| format!("PROVIDER_FAILED|openai_api|응답 읽기 실패: {error}"))?;
    if !(200..300).contains(&status) {
        return Err(limited_error(OPENAI_PROVIDER, status, &text.chars().take(1000).collect::<String>()));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("PROVIDER_FAILED|openai_api|JSON 해석 실패: {error}"))?;

    if let Some(output_text) = value.get("output_text").and_then(Value::as_str) {
        if !output_text.trim().is_empty() {
            return Ok(output_text.trim().to_string());
        }
    }

    let mut parts = Vec::new();
    if let Some(outputs) = value.get("output").and_then(Value::as_array) {
        for output in outputs {
            if let Some(contents) = output.get("content").and_then(Value::as_array) {
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
    if parts.is_empty() {
        return Err("PROVIDER_FAILED|openai_api|OpenAI 응답에서 텍스트를 찾지 못했습니다.".to_string());
    }
    Ok(parts.join("\n"))
}

pub async fn run_provider(
    provider: &str,
    prompt: &str,
    settings: &AppSettings,
) -> Result<String, String> {
    let prompt = validate_prompt(prompt)?;
    match provider.trim().to_ascii_lowercase().as_str() {
        GEMINI_PROVIDER => {
            if !settings.gemini_api_enabled {
                return Err("PROVIDER_DISABLED|gemini_api|Gemini 자동 Provider가 꺼져 있습니다.".to_string());
            }
            request_gemini(&prompt).await
        }
        OPENAI_PROVIDER => request_openai(&prompt, settings).await,
        other => Err(format!("PROVIDER_FAILED|{other}|지원하지 않는 자동 Provider입니다.")),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeAutoReadiness {
    pub gemini_api_configured: bool,
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
    let jina_api_configured = jina_api_configured();
    let hands_free_ready = settings.cradle_enabled
        && settings.gemini_api_enabled
        && gemini_api_configured;
    let keys_env_path = crate::local_env::loaded_keys_path()
        .or_else(|| Some(crate::local_env::preferred_keys_path().to_string_lossy().into_owned()));

    let mut next_steps = Vec::new();
    if !settings.cradle_enabled || !settings.auto_web_search || !settings.gemini_api_enabled {
        next_steps.push("아래 '무료 자동 모드 켜기'를 누르면 추천 설정이 한 번에 켜집니다.".to_string());
    }
    if !gemini_api_configured {
        next_steps.push(
            "설정에서 '키 파일 열기'로 .ai-character/keys.env에 GEMINI_API_KEY=... 를 넣고 앱을 다시 실행하세요."
                .to_string(),
        );
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
    } else if gemini_api_configured {
        "Gemini 키는 있습니다. 무료 자동 모드만 켜면 됩니다.".to_string()
    } else {
        "아직 자동 모드 준비가 안 됐습니다. 키 파일만 채우면 됩니다.".to_string()
    };

    FreeAutoReadiness {
        gemini_api_configured,
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
