//! The models each AI program can use, for the chat's program/model menu. Read from the
//! programs themselves so the list matches what the user's account can actually run:
//! Codex's own model cache, `cursor-agent models`, `agy models`. Claude Code takes short
//! names (opus, sonnet, haiku) that always mean the newest model of that tier.

use crate::agent_core::{resolve_agent_binary, AgentKind};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    /// What goes to `--model`; empty means "the program's own default".
    pub id: String,
    pub label: String,
    /// A short hint for beginners (빠름, 균형, 가장 똑똑함 …), may be empty.
    pub note: String,
}

fn model(id: &str, label: &str, note: &str) -> AgentModel {
    AgentModel { id: id.into(), label: label.into(), note: note.into() }
}

fn default_entry() -> AgentModel {
    model("", "기본값", "프로그램이 알아서 고릅니다")
}

fn claude_models() -> Vec<AgentModel> {
    vec![
        default_entry(),
        model("opus", "Opus", "가장 똑똑함 · 느리고 한도를 많이 씀"),
        model("sonnet", "Sonnet", "균형 · 대부분의 일에 추천"),
        model("haiku", "Haiku", "가장 빠름 · 간단한 질문용"),
    ]
}

/// Codex keeps the models the signed-in account may use in ~/.codex/models_cache.json.
fn codex_models_from(cache: &Value) -> Vec<AgentModel> {
    let mut listed: Vec<(i64, AgentModel)> = cache
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("visibility").and_then(Value::as_str).unwrap_or("list") == "list")
        .filter_map(|entry| {
            let slug = entry.get("slug").and_then(Value::as_str)?;
            let label = entry.get("display_name").and_then(Value::as_str).unwrap_or(slug);
            let note = entry.get("description").and_then(Value::as_str).unwrap_or_default();
            let priority = entry.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX);
            Some((priority, model(slug, label, note)))
        })
        .collect();
    listed.sort_by_key(|(priority, _)| *priority);
    std::iter::once(default_entry()).chain(listed.into_iter().map(|(_, entry)| entry)).collect()
}

fn codex_models() -> Vec<AgentModel> {
    let cache = crate::codex_model::codex_home()
        .and_then(|dir| std::fs::read_to_string(dir.join("models_cache.json")).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    match cache {
        Some(cache) => codex_models_from(&cache),
        None => vec![default_entry()],
    }
}

/// `cursor-agent models`: "id - Label" lines under a heading.
fn cursor_models_from(output: &str) -> Vec<AgentModel> {
    let listed = output.lines().filter_map(|line| {
        let (id, label) = line.trim().split_once(" - ")?;
        let id = id.trim();
        (!id.is_empty() && !id.contains(' ') && id != "auto").then(|| model(id, label.trim(), ""))
    });
    std::iter::once(model("", "Auto", "Cursor가 알아서 고릅니다")).chain(listed).collect()
}

/// `agy models`: "id<TAB>Label" lines after "Fetching available models...".
fn antigravity_models_from(output: &str) -> Vec<AgentModel> {
    let listed = output.lines().filter_map(|line| {
        let (id, label) = line.trim().split_once('\t')?;
        let id = id.trim();
        (!id.is_empty() && !id.contains(' ')).then(|| model(id, label.trim(), ""))
    });
    std::iter::once(default_entry()).chain(listed).collect()
}

fn ask_cli(agent: AgentKind, args: &[&str]) -> Option<String> {
    let saved = crate::settings::load_settings().ok();
    let saved_path = saved.as_ref().and_then(|settings| settings.agent_path(agent).map(PathBuf::as_path));
    let binary = resolve_agent_binary(agent, saved_path).ok()?;
    crate::login_status::run_with_timeout(&binary, args, Duration::from_secs(30))
}

fn fetch(agent: AgentKind) -> Vec<AgentModel> {
    match agent {
        AgentKind::Claude => claude_models(),
        AgentKind::Codex => codex_models(),
        AgentKind::Cursor => ask_cli(agent, &["models"]).map(|out| cursor_models_from(&out)).unwrap_or_else(|| vec![model("", "Auto", "")]),
        AgentKind::Antigravity => ask_cli(agent, &["models"]).map(|out| antigravity_models_from(&out)).unwrap_or_else(|| vec![default_entry()]),
    }
}

/// Lists change rarely and asking Cursor/Antigravity takes seconds, so an answer is reused for
/// ten minutes unless `refresh`.
const FRESH_FOR: Duration = Duration::from_secs(600);
/// A program that could not be asked (signed out, offline, slow) is not asked again on every
/// menu open; it gets another try after this.
const RETRY_AFTER: Duration = Duration::from_secs(45);
static CACHE: Mutex<Option<HashMap<AgentKind, (Instant, Vec<AgentModel>)>>> = Mutex::new(None);
/// One lookup per program at a time: a caller that waited takes the answer just fetched.
static FETCHING: [Mutex<()>; 4] = [Mutex::new(()), Mutex::new(()), Mutex::new(()), Mutex::new(())];

fn fetch_lock(agent: AgentKind) -> &'static Mutex<()> {
    &FETCHING[match agent {
        AgentKind::Claude => 0,
        AgentKind::Codex => 1,
        AgentKind::Cursor => 2,
        AgentKind::Antigravity => 3,
    }]
}

fn cached(agent: AgentKind, since: Option<Instant>) -> Option<Vec<AgentModel>> {
    let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let (at, models) = cache.as_ref()?.get(&agent)?;
    let max_age = if models.len() > 1 { FRESH_FOR } else { RETRY_AFTER };
    (at.elapsed() < max_age && since.is_none_or(|since| *at >= since)).then(|| models.clone())
}

pub fn agent_models(agent: AgentKind, refresh: bool) -> Vec<AgentModel> {
    let asked = Instant::now();
    if !refresh {
        if let Some(models) = cached(agent, None) {
            return models;
        }
    }
    let _fetching = fetch_lock(agent).lock().unwrap_or_else(|e| e.into_inner());
    // Fetched by the caller this one waited for (after this call was made, for a refresh).
    if let Some(models) = cached(agent, refresh.then_some(asked)) {
        return models;
    }
    let models = fetch(agent);
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(agent, (Instant::now(), models.clone()));
    models
}

#[tauri::command]
pub async fn list_agent_models(agent: String, refresh: Option<bool>) -> Result<Vec<AgentModel>, String> {
    let agent = AgentKind::parse(&agent)?;
    crate::process_util::off_ui_thread("모델 목록을 불러오지 못했습니다", move || agent_models(agent, refresh == Some(true))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_lists_visible_models_by_priority() {
        let cache = json!({ "models": [
            { "slug": "b", "display_name": "B", "visibility": "list", "priority": 5 },
            { "slug": "hidden", "visibility": "hide", "priority": 1 },
            { "slug": "a", "display_name": "A", "description": "fast", "visibility": "list", "priority": 2 },
        ]});
        let ids: Vec<String> = codex_models_from(&cache).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["", "a", "b"]);
    }

    #[test]
    fn cursor_and_antigravity_outputs_are_parsed() {
        let cursor = cursor_models_from("Available models\n\nauto - Auto (default)\ngpt-5.2 - GPT-5.2\ncomposer-2.5 - Composer 2.5\n");
        assert_eq!(cursor.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["", "gpt-5.2", "composer-2.5"]);
        let agy = antigravity_models_from("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n");
        assert_eq!(agy[1].id, "gemini-3.8-flash-high");
        assert_eq!(agy[1].label, "Gemini 3.8 Flash (High)");
    }
}
