use crate::provider_router;
use crate::usage_ledger::{
    self, AgentSuccessRate, PaidApproval, ProviderModel, UpdateRecord, UsageRow, UsageSummary,
};
use serde::Serialize;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[tauri::command]
pub fn list_api_usage(limit: Option<i64>) -> Result<Vec<UsageRow>, String> {
    let connection = usage_ledger::open_ledger()?;
    usage_ledger::list_usage_rows(&connection, limit.unwrap_or(100))
}

#[tauri::command]
pub fn get_api_usage_summary(days: Option<i64>) -> Result<UsageSummary, String> {
    let connection = usage_ledger::open_ledger()?;
    let since = usage_ledger::now_millis() - days.unwrap_or(30).clamp(1, 365) * DAY_MS;
    usage_ledger::usage_summary(&connection, since)
}

#[tauri::command]
pub fn list_provider_models(provider: Option<String>) -> Result<Vec<ProviderModel>, String> {
    let connection = usage_ledger::open_ledger()?;
    usage_ledger::list_models(&connection, provider.as_deref())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRefreshResult {
    pub openrouter: Result<usize, String>,
    pub gemini: Result<usize, String>,
}

#[tauri::command]
pub async fn refresh_free_models(force: Option<bool>) -> Result<ModelRefreshResult, String> {
    let force = force.unwrap_or(true);
    Ok(ModelRefreshResult {
        openrouter: provider_router::refresh_openrouter_models(force).await,
        gemini: provider_router::refresh_gemini_models().await,
    })
}

#[tauri::command]
pub fn list_paid_approvals(limit: Option<i64>) -> Result<Vec<PaidApproval>, String> {
    let connection = usage_ledger::open_ledger()?;
    usage_ledger::list_approvals(&connection, limit.unwrap_or(50))
}

#[tauri::command]
pub fn list_update_history(limit: Option<i64>) -> Result<Vec<UpdateRecord>, String> {
    let connection = usage_ledger::open_ledger()?;
    usage_ledger::list_updates(&connection, limit.unwrap_or(50))
}

#[tauri::command]
pub fn get_agent_success_rates(days: Option<i64>) -> Result<Vec<AgentSuccessRate>, String> {
    let connection = usage_ledger::open_ledger()?;
    let since = usage_ledger::now_millis() - days.unwrap_or(30).clamp(1, 365) * DAY_MS;
    usage_ledger::test_success_by_agent(&connection, since)
}
