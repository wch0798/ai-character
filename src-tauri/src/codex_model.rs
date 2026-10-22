//! Codex reads its model from the user's `~/.codex/config.toml`. When that names a model
//! Codex no longer offers (e.g. `gpt-5-codex-mini` after an update), every run fails with
//! "model is not supported". The user's file is left alone; the app passes Codex's current
//! top model for its own runs instead.

use serde_json::Value;
use std::path::PathBuf;

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(|home| PathBuf::from(home).join(".codex")))
}

/// The top-level `model = "..."` line (before any `[section]`).
pub fn configured_model(config: &str) -> Option<String> {
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        let Some(rest) = line.strip_prefix("model") else { continue };
        let Some(value) = rest.trim_start().strip_prefix('=') else { continue };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// `Some(replacement)` only when the configured model is missing from Codex's own model list.
pub fn replacement(configured: Option<&str>, cache: &Value) -> Option<String> {
    let configured = configured?;
    let models = cache.get("models")?.as_array()?;
    if models.iter().any(|model| model.get("slug").and_then(Value::as_str) == Some(configured)) {
        return None;
    }
    models
        .iter()
        .filter(|model| model.get("visibility").and_then(Value::as_str) == Some("list"))
        .min_by_key(|model| model.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX))
        .and_then(|model| model.get("slug").and_then(Value::as_str))
        .map(str::to_string)
}

pub fn replacement_for_retired_model() -> Option<String> {
    let home = codex_home()?;
    let config = std::fs::read_to_string(home.join("config.toml")).ok()?;
    let cache: Value = serde_json::from_str(&std::fs::read_to_string(home.join("models_cache.json")).ok()?).ok()?;
    let replacement = replacement(configured_model(&config).as_deref(), &cache)?;
    eprintln!("Codex 설정의 모델이 더 이상 제공되지 않아 이번 실행은 {replacement} 모델을 씁니다.");
    Some(replacement)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_only_the_top_level_model() {
        assert_eq!(configured_model("model = \"gpt-5-codex-mini\"\nmodel_reasoning_effort = \"medium\"").as_deref(), Some("gpt-5-codex-mini"));
        assert_eq!(configured_model("[profiles.x]\nmodel = \"o3\""), None);
        assert_eq!(configured_model("personality = \"pragmatic\""), None);
    }

    #[test]
    fn replaces_only_a_model_codex_no_longer_lists() {
        let cache = json!({ "models": [
            { "slug": "gpt-6-sol", "visibility": "list", "priority": 4 },
            { "slug": "gpt-6-astra", "visibility": "list", "priority": 2 },
            { "slug": "gpt-reserve", "visibility": "hide", "priority": 1 },
        ]});
        assert_eq!(replacement(Some("gpt-5-codex-mini"), &cache).as_deref(), Some("gpt-6-astra"));
        assert_eq!(replacement(Some("gpt-6-sol"), &cache), None);
        assert_eq!(replacement(None, &cache), None);
    }
}
