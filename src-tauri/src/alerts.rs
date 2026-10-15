use crate::settings::{load_settings, save_settings};
use crate::usage_ledger;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

pub const USAGE_ALERT_EVENT: &str = "ai-character:usage-alert";

static APP: OnceLock<AppHandle> = OnceLock::new();
/// (local day start, highest level already announced) so each level fires once per day.
static ANNOUNCED: Mutex<(i64, u8)> = Mutex::new((0, 0));

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlertSettings {
    pub desktop: bool,
    pub daily_cost_limit_usd: f64,
    pub daily_call_warn: u64,
    #[serde(default = "default_true")]
    pub block_paid_over_limit: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageAlerts {
    pub calls: u64,
    pub paid_calls: u64,
    pub cost_usd: f64,
    pub daily_cost_limit_usd: f64,
    pub daily_call_warn: u64,
    pub level: String,
    pub message: String,
    pub paid_blocked: bool,
}

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn alert_settings() -> AlertSettings {
    let settings = load_settings().unwrap_or_default();
    AlertSettings {
        desktop: settings.extra_bool("notify.desktop", true),
        daily_cost_limit_usd: settings.extra_f64("usage.daily_cost_limit_usd", 1.0).max(0.0),
        daily_call_warn: settings.extra_u64("usage.daily_call_warn", 300),
        block_paid_over_limit: settings.extra_bool("usage.block_paid_over_limit", true),
    }
}

fn block_reason(cost_usd: f64, settings: &AlertSettings) -> Option<String> {
    let limit = settings.daily_cost_limit_usd;
    (settings.block_paid_over_limit && limit > 0.0 && cost_usd >= limit).then(|| {
        format!(
            "오늘 유료 사용액(${cost_usd:.2})이 하루 한도 ${limit:.2}에 도달해 유료 API 호출을 막았습니다. 무료 경로로 진행하거나 설정 → 자동화에서 한도를 올리세요."
        )
    })
}

/// Why paid calls are refused right now, or None when they may proceed.
pub fn paid_block_reason(connection: &Connection) -> Option<String> {
    let settings = alert_settings();
    if !settings.block_paid_over_limit || settings.daily_cost_limit_usd <= 0.0 {
        return None;
    }
    let (_, _, cost) = today_usage(connection, day_start(connection)).ok()?;
    block_reason(cost, &settings)
}

/// Shows an OS notification when the user has them enabled; failures are silent.
pub fn notify(title: &str, body: &str) {
    if !alert_settings().desktop {
        return;
    }
    if let Some(app) = APP.get() {
        let body: String = body.chars().take(240).collect();
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn level_rank(level: &str) -> u8 {
    match level {
        "over" => 2,
        "warn" => 1,
        _ => 0,
    }
}

fn day_start(connection: &Connection) -> i64 {
    connection
        .query_row(
            "SELECT CAST(strftime('%s', 'now', 'localtime', 'start of day', 'utc') AS INTEGER) * 1000",
            [],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| usage_ledger::now_millis() - usage_ledger::now_millis() % 86_400_000)
}

/// Thresholds: warn at 80% of the cost limit or at the call count, over at 100% of the cost limit.
pub fn evaluate(calls: u64, paid_calls: u64, cost_usd: f64, settings: &AlertSettings) -> UsageAlerts {
    let limit = settings.daily_cost_limit_usd;
    let paid_blocked = block_reason(cost_usd, settings).is_some();
    let (level, message) = if limit > 0.0 && cost_usd >= limit {
        let tail = if paid_blocked { " 오늘은 유료 API 호출을 막습니다." } else { "" };
        ("over", format!("오늘 유료 사용액이 한도 ${limit:.2}에 도달했습니다 (${cost_usd:.2}).{tail}"))
    } else if limit > 0.0 && cost_usd >= limit * 0.8 {
        ("warn", format!("오늘 유료 사용액이 한도의 80%를 넘었습니다 (${cost_usd:.2} / ${limit:.2})."))
    } else if settings.daily_call_warn > 0 && calls >= settings.daily_call_warn {
        ("warn", format!("오늘 AI 호출이 {calls}회로 경고 기준({}회)을 넘었습니다.", settings.daily_call_warn))
    } else {
        ("ok", String::new())
    };
    UsageAlerts {
        calls,
        paid_calls,
        cost_usd: cost_usd + 0.0,
        daily_cost_limit_usd: limit,
        daily_call_warn: settings.daily_call_warn,
        level: level.to_string(),
        message,
        paid_blocked,
    }
}

fn today_usage(connection: &Connection, since: i64) -> Result<(u64, u64, f64), String> {
    connection
        .query_row(
            "SELECT COUNT(*),\n\
               COALESCE(SUM(CASE WHEN cost_class = 'paid' THEN 1 ELSE 0 END), 0),\n\
               COALESCE(SUM(CASE WHEN cost_class = 'paid' THEN MAX(cost_usd, estimated_paid_usd) ELSE cost_usd END), 0)\n\
             FROM api_usage WHERE created_at >= ?1 AND cache_hit = 0",
            [since],
            |row| Ok((row.get::<_, i64>(0)?.max(0) as u64, row.get::<_, i64>(1)?.max(0) as u64, row.get::<_, f64>(2)?)),
        )
        .map_err(|error| format!("오늘 사용량 조회 실패: {error}"))
}

fn usage_alerts_from(connection: &Connection) -> Result<(i64, UsageAlerts), String> {
    let since = day_start(connection);
    let (calls, paid, cost) = today_usage(connection, since)?;
    Ok((since, evaluate(calls, paid, cost, &alert_settings())))
}

const ANNOUNCED_KEY: &str = "usage.announced";

fn parse_announced(value: &str) -> Option<(i64, u8)> {
    let (since, rank) = value.split_once(':')?;
    Some((since.parse().ok()?, rank.parse().ok()?))
}

/// Survives restarts so the same level is not announced twice in one day.
fn load_announced() -> (i64, u8) {
    load_settings()
        .ok()
        .and_then(|settings| settings.extra(ANNOUNCED_KEY).and_then(parse_announced))
        .unwrap_or((0, 0))
}

fn save_announced(since: i64, rank: u8) {
    if let Ok(mut settings) = load_settings() {
        settings.set_extra(ANNOUNCED_KEY, Some(format!("{since}:{rank}")));
        let _ = save_settings(&settings);
    }
}

/// Called after each recorded call; announces a level the first time it is reached today.
pub fn check_usage(connection: &Connection) {
    let Ok((since, alerts)) = usage_alerts_from(connection) else {
        return;
    };
    let rank = level_rank(&alerts.level);
    let fresh = {
        let Ok(mut announced) = ANNOUNCED.lock() else {
            return;
        };
        if announced.0 == 0 {
            *announced = load_announced();
        }
        if announced.0 != since {
            *announced = (since, 0);
        }
        let fresh = rank > announced.1;
        if fresh {
            announced.1 = rank;
        }
        fresh
    };
    if !fresh {
        return;
    }
    save_announced(since, rank);
    if let Some(app) = APP.get() {
        let _ = app.emit(USAGE_ALERT_EVENT, &alerts);
    }
    notify(
        if alerts.level == "over" { "사용량 한도 도달" } else { "사용량 경고" },
        &alerts.message,
    );
}

#[tauri::command]
pub fn get_usage_alerts() -> Result<UsageAlerts, String> {
    Ok(usage_alerts_from(&usage_ledger::open_ledger()?)?.1)
}

#[tauri::command]
pub fn get_alert_settings() -> AlertSettings {
    alert_settings()
}

#[tauri::command]
pub fn set_alert_settings(value: AlertSettings) -> Result<AlertSettings, String> {
    let mut settings = load_settings()?;
    settings.set_extra("notify.desktop", Some(value.desktop.to_string()));
    let limit = if value.daily_cost_limit_usd.is_finite() { value.daily_cost_limit_usd.clamp(0.0, 10_000.0) } else { 1.0 };
    settings.set_extra("usage.daily_cost_limit_usd", Some(format!("{limit}")));
    settings.set_extra("usage.daily_call_warn", Some(value.daily_call_warn.min(1_000_000).to_string()));
    settings.set_extra("usage.block_paid_over_limit", Some(value.block_paid_over_limit.to_string()));
    settings.set_extra(ANNOUNCED_KEY, None);
    save_settings(&settings)?;
    if let Ok(mut announced) = ANNOUNCED.lock() {
        *announced = (0, 0);
    }
    Ok(alert_settings())
}

#[tauri::command]
pub fn notify_desktop(title: String, body: String) {
    notify(&title, &body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_ledger::{ensure_schema, insert_usage, UsageEntry};

    fn settings(limit: f64, calls: u64) -> AlertSettings {
        AlertSettings { desktop: true, daily_cost_limit_usd: limit, daily_call_warn: calls, block_paid_over_limit: true }
    }

    #[test]
    fn paid_calls_are_blocked_only_at_the_limit_when_enabled() {
        assert!(block_reason(0.99, &settings(1.0, 0)).is_none());
        assert!(block_reason(1.0, &settings(1.0, 0)).unwrap().contains("막았습니다"));
        assert!(block_reason(9.0, &settings(0.0, 0)).is_none());
        let off = AlertSettings { block_paid_over_limit: false, ..settings(1.0, 0) };
        assert!(block_reason(9.0, &off).is_none());
        assert!(evaluate(1, 1, 1.5, &settings(1.0, 0)).paid_blocked);
        assert!(!evaluate(1, 1, 1.5, &off).paid_blocked);
    }

    #[test]
    fn levels_follow_cost_then_call_thresholds() {
        assert_eq!(evaluate(10, 0, 0.0, &settings(1.0, 300)).level, "ok");
        assert_eq!(evaluate(10, 2, 0.85, &settings(1.0, 300)).level, "warn");
        assert_eq!(evaluate(10, 2, 1.0, &settings(1.0, 300)).level, "over");
        assert_eq!(evaluate(300, 0, 0.0, &settings(1.0, 300)).level, "warn");
        assert_eq!(evaluate(5_000, 9, 50.0, &settings(0.0, 0)).level, "ok");
    }

    #[test]
    fn parses_stored_announcement() {
        assert_eq!(parse_announced("1700000000000:2"), Some((1_700_000_000_000, 2)));
        assert_eq!(parse_announced("garbage"), None);
    }

    #[test]
    fn paid_rows_count_the_larger_of_billed_and_estimated_cost() {
        let connection = Connection::open_in_memory().unwrap();
        ensure_schema(&connection).unwrap();
        let mut entry = UsageEntry {
            provider: "x".into(),
            model: "m".into(),
            cost_class: "paid".into(),
            cost_usd: 0.1,
            estimated_paid_usd: 0.3,
            status: "ok".into(),
            ..Default::default()
        };
        insert_usage(&connection, &entry).unwrap();
        entry.cost_class = "free_first".into();
        entry.cost_usd = 0.0;
        insert_usage(&connection, &entry).unwrap();
        entry.cache_hit = true;
        insert_usage(&connection, &entry).unwrap();
        let (calls, paid, cost) = today_usage(&connection, day_start(&connection)).unwrap();
        assert_eq!((calls, paid), (2, 1));
        assert!((cost - 0.3).abs() < 1e-9);
        assert!(today_usage(&connection, usage_ledger::now_millis() + 60_000).unwrap().0 == 0);
    }
}
