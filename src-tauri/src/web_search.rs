use serde::Serialize;
use std::time::Duration;

const SEARCH_ENDPOINT: &str = "https://s.jina.ai/";
const DEFAULT_MAX_CHARS: usize = 18_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResponse {
    pub query: String,
    pub provider: String,
    pub content: String,
    pub source_urls: Vec<String>,
    pub truncated: bool,
}

fn truncate_chars(value: &str, limit: usize) -> (String, bool) {
    let count = value.chars().count();
    if count <= limit {
        return (value.to_string(), false);
    }
    (value.chars().take(limit).collect(), true)
}

fn collect_source_urls(content: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for token in content.split_whitespace() {
        let trimmed = token
            .trim_matches(|ch: char| matches!(ch, '<' | '>' | '(' | ')' | '[' | ']' | '"' | '\'' | ',' | ';'))
            .trim_end_matches(|ch: char| matches!(ch, '.' | ':'));
        if (trimmed.starts_with("https://") || trimmed.starts_with("http://"))
            && !urls.iter().any(|url| url == trimmed)
        {
            urls.push(trimmed.to_string());
            if urls.len() >= 12 {
                break;
            }
        }
    }
    urls
}

#[tauri::command]
pub async fn search_web_background(
    query: String,
    max_chars: Option<usize>,
) -> Result<WebSearchResponse, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("웹 검색어가 비어 있습니다.".to_string());
    }
    if query.chars().count() > 800 {
        return Err("웹 검색어는 800자 이하여야 합니다.".to_string());
    }

    let api_key = crate::process_util::secret_value("JINA_API_KEY")
        .ok_or_else(|| "JINA_API_KEY가 없습니다. 설정 → 시작 → API 키에서 무료 Jina 키를 저장하면 자동 검색을 쓸 수 있습니다.".to_string())?;

    let max_chars = max_chars.unwrap_or(DEFAULT_MAX_CHARS).clamp(4_000, 32_000);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("AI-Character/0.1 background-web-research")
        .build()
        .map_err(|error| format!("웹 검색 클라이언트 생성 실패: {error}"))?;

    let mut url = reqwest::Url::parse(SEARCH_ENDPOINT)
        .map_err(|error| format!("웹 검색 주소 구성 실패: {error}"))?;
    url.query_pairs_mut().append_pair("q", &query);

    let response = client
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "text/plain")
        .send()
        .await
        .map_err(|error| format!("백그라운드 웹 검색 요청 실패: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body = body.chars().take(600).collect::<String>();
        if status.as_u16() == 429 {
            return Err(format!("Jina Search 무료 사용량/속도 제한에 도달했습니다 (HTTP 429). {body}"));
        }
        return Err(format!("Jina Search 오류 (HTTP {}): {body}", status.as_u16()));
    }

    let body = response
        .text()
        .await
        .map_err(|error| format!("웹 검색 결과 읽기 실패: {error}"))?;
    let source_urls = collect_source_urls(&body);
    let (content, truncated) = truncate_chars(&body, max_chars);

    Ok(WebSearchResponse {
        query,
        provider: "jina_search".to_string(),
        content,
        source_urls,
        truncated,
    })
}
