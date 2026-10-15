//! Usage report built in Rust so it works in the installed app without the Node dashboard:
//! the app's own ledger plus token totals from the local Claude Code and Codex session logs.

use crate::usage_ledger::{list_usage_rows, open_ledger, usage_summary};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DAY_MS: i64 = 86_400_000;
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// Seconds east of UTC, taken from SQLite so it matches how the ledger buckets days.
fn local_offset_secs(connection: Option<&Connection>) -> i64 {
    connection
        .and_then(|conn| {
            conn.query_row("SELECT CAST(strftime('%s','now','localtime') AS INTEGER) - CAST(strftime('%s','now') AS INTEGER)", [], |row| row.get(0))
                .ok()
        })
        .unwrap_or(0)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, month, day)
}

/// Parses the UTC timestamps the CLIs write (`2026-10-14T03:04:05.678Z`) into epoch milliseconds.
fn parse_iso_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| value.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let millis = if bytes.get(19) == Some(&b'.') {
        let digits: String = value[20..].chars().take_while(char::is_ascii_digit).take(3).collect();
        format!("{digits:0<3}").parse::<i64>().unwrap_or(0)
    } else {
        0
    };
    Some(((days_from_civil(year, month, day) * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

fn local_day(ms: i64, offset_secs: i64) -> String {
    let (y, m, d) = civil_from_days((ms + offset_secs * 1000).div_euclid(DAY_MS));
    format!("{y:04}-{m:02}-{d:02}")
}

fn jsonl_files(root: &Path, since: SystemTime, out: &mut Vec<PathBuf>, depth: usize) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() && depth > 0 {
            jsonl_files(&path, since, out, depth - 1);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") && meta.modified().map_or(false, |time| time >= since) {
            out.push(path);
        }
    }
}

fn for_each_json_line(path: &Path, needle: &str, mut visit: impl FnMut(Value)) {
    let Ok(file) = File::open(path) else {
        return;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.len() > MAX_LINE_BYTES || !line.contains(needle) {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            visit(value);
        }
    }
}

#[derive(Default, Clone)]
struct Tokens {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    count: i64,
}

impl Tokens {
    fn total(&self) -> i64 {
        self.input + self.output + self.cache_read + self.cache_write
    }

    fn json(&self) -> Value {
        json!({ "input": self.input, "output": self.output, "cacheRead": self.cache_read, "cacheWrite": self.cache_write, "count": self.count, "total": self.total() })
    }
}

fn int(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn claude_usage(since_ms: i64, offset: i64, today: &str) -> Value {
    let Some(root) = home_dir().map(|home| home.join(".claude").join("projects")) else {
        return json!({ "available": false });
    };
    if !root.is_dir() {
        return json!({ "available": false });
    }
    let mut files = Vec::new();
    jsonl_files(&root, UNIX_EPOCH + Duration::from_millis(since_ms.max(0) as u64), &mut files, 3);
    let mut seen = HashSet::new();
    let mut by_day: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut by_model: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut last_activity = 0;
    for file in files {
        for_each_json_line(&file, "\"usage\"", |row| {
            if row.get("type").and_then(Value::as_str) != Some("assistant") {
                return;
            }
            let Some(message) = row.get("message") else { return };
            let Some(usage) = message.get("usage") else { return };
            let model = message.get("model").and_then(Value::as_str).unwrap_or("unknown");
            if model == "<synthetic>" {
                return;
            }
            let key = message.get("id").or_else(|| row.get("uuid")).and_then(Value::as_str).map(str::to_string);
            if let Some(key) = key {
                if !seen.insert(key) {
                    return;
                }
            }
            let Some(ts) = row.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms) else { return };
            if ts < since_ms {
                return;
            }
            last_activity = last_activity.max(ts);
            let add = |bucket: &mut Tokens| {
                bucket.input += int(usage, "input_tokens");
                bucket.output += int(usage, "output_tokens");
                bucket.cache_read += int(usage, "cache_read_input_tokens");
                bucket.cache_write += int(usage, "cache_creation_input_tokens");
                bucket.count += 1;
            };
            add(by_day.entry(local_day(ts, offset)).or_default());
            add(by_model.entry(model.to_string()).or_default());
        });
    }
    let total: Tokens = by_model.values().fold(Tokens::default(), |mut acc, t| {
        acc.input += t.input;
        acc.output += t.output;
        acc.cache_read += t.cache_read;
        acc.cache_write += t.cache_write;
        acc.count += t.count;
        acc
    });
    json!({
        "available": true,
        "total": total.json(),
        "today": by_day.get(today).cloned().unwrap_or_default().json(),
        "days": by_day.iter().map(|(day, t)| json!({ "day": day, "tokens": t.total(), "count": t.count })).collect::<Vec<_>>(),
        "models": by_model.iter().map(|(model, t)| { let mut v = t.json(); v["model"] = json!(model); v }).collect::<Vec<_>>(),
        "lastActivity": (last_activity > 0).then_some(last_activity),
    })
}

fn codex_usage(since_ms: i64, offset: i64, today: &str) -> Value {
    let Some(root) = home_dir().map(|home| home.join(".codex").join("sessions")) else {
        return json!({ "available": false });
    };
    if !root.is_dir() {
        return json!({ "available": false });
    }
    let mut files = Vec::new();
    jsonl_files(&root, UNIX_EPOCH + Duration::from_millis(since_ms.max(0) as u64), &mut files, 4);
    let mut by_day: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut by_model: BTreeMap<String, Tokens> = BTreeMap::new();
    let mut latest_limits: Option<Value> = None;
    let mut latest_ts = 0;
    for file in files {
        let mut model = "unknown".to_string();
        let mut last: Option<(Value, i64)> = None;
        for_each_json_line(&file, "\"payload\"", |row| {
            let Some(payload) = row.get("payload") else { return };
            if row.get("type").and_then(Value::as_str) == Some("turn_context") {
                if let Some(name) = payload.get("model").and_then(Value::as_str) {
                    model = name.to_string();
                }
            }
            if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                return;
            }
            let ts = row.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(0);
            if let Some(total) = payload.get("info").and_then(|info| info.get("total_token_usage")) {
                last = Some((total.clone(), ts));
            }
            if let Some(limits) = payload.get("rate_limits").filter(|value| !value.is_null()) {
                if ts >= latest_ts {
                    latest_ts = ts;
                    latest_limits = Some(limits.clone());
                }
            }
        });
        let Some((usage, ts)) = last else { continue };
        if ts < since_ms {
            continue;
        }
        let add = |bucket: &mut Tokens| {
            bucket.input += int(&usage, "input_tokens");
            bucket.output += int(&usage, "output_tokens");
            bucket.cache_read += int(&usage, "cached_input_tokens");
            bucket.count += 1;
        };
        add(by_day.entry(local_day(ts, offset)).or_default());
        add(by_model.entry(model.clone()).or_default());
    }
    let meter = |key: &str, label: &str| {
        latest_limits.as_ref().and_then(|limits| limits.get(key)).filter(|v| !v.is_null()).map(|limit| {
            json!({
                "label": label,
                "pct": limit.get("used_percent").and_then(Value::as_f64).unwrap_or(0.0),
                "windowMin": limit.get("window_minutes").and_then(Value::as_i64),
                "resetsAt": limit.get("resets_at").and_then(Value::as_i64),
            })
        })
    };
    let meters: Vec<Value> = [meter("primary", "단기 한도"), meter("secondary", "주간 한도")].into_iter().flatten().collect();
    let total_sessions: i64 = by_model.values().map(|t| t.count).sum();
    json!({
        "available": true,
        "sessions": total_sessions,
        "today": by_day.get(today).cloned().unwrap_or_default().json(),
        "days": by_day.iter().map(|(day, t)| json!({ "day": day, "tokens": t.input + t.output, "count": t.count })).collect::<Vec<_>>(),
        "models": by_model.iter().map(|(model, t)| { let mut v = t.json(); v["model"] = json!(model); v }).collect::<Vec<_>>(),
        "meters": meters,
        "metersAt": (latest_ts > 0).then_some(latest_ts),
    })
}

fn ledger_daily(conn: &Connection, since: i64) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare(
            "SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(*),\n\
               SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),\n\
               SUM(CASE WHEN cost_class LIKE 'paid%' THEN MAX(cost_usd, estimated_paid_usd) ELSE cost_usd END)\n\
             FROM api_usage WHERE created_at >= ?1 AND cache_hit = 0 GROUP BY day ORDER BY day",
        )
        .map_err(|error| format!("일별 사용량 준비 실패: {error}"))?;
    let rows = statement
        .query_map(params![since], |row| {
            Ok(json!({
                "day": row.get::<_, String>(0)?,
                "calls": row.get::<_, i64>(1)?,
                "errors": row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                "costUsd": row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
            }))
        })
        .map_err(|error| format!("일별 사용량 실패: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

fn ledger_models(conn: &Connection, since: i64) -> Result<Vec<Value>, String> {
    let mut statement = conn
        .prepare(
            "SELECT provider, model, cost_class, COUNT(*), SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END),\n\
               AVG(latency_ms), SUM(input_tokens), SUM(output_tokens), SUM(cost_usd)\n\
             FROM api_usage WHERE created_at >= ?1 GROUP BY provider, model, cost_class ORDER BY COUNT(*) DESC LIMIT 40",
        )
        .map_err(|error| format!("모델별 사용량 준비 실패: {error}"))?;
    let rows = statement
        .query_map(params![since], |row| {
            Ok(json!({
                "provider": row.get::<_, String>(0)?,
                "model": row.get::<_, String>(1)?,
                "costClass": row.get::<_, String>(2)?,
                "calls": row.get::<_, i64>(3)?,
                "ok": row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                "avgLatencyMs": row.get::<_, Option<f64>>(5)?.unwrap_or(0.0).round() as i64,
                "inputTokens": row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                "outputTokens": row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                "costUsd": row.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
            }))
        })
        .map_err(|error| format!("모델별 사용량 실패: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

fn ledger_recent(conn: &Connection) -> Result<Vec<Value>, String> {
    Ok(list_usage_rows(conn, 25)?
        .into_iter()
        .map(|row| {
            json!({
                "provider": row.provider,
                "model": row.model,
                "role": row.role,
                "costClass": row.cost_class,
                "status": row.status,
                "error": row.error.map(|error| crate::policy_engine::mask_secrets(&error).chars().take(200).collect::<String>()),
                "costUsd": row.cost_usd.max(row.estimated_paid_usd),
                "latencyMs": row.latency_ms,
                "cacheHit": row.cache_hit,
                "createdAt": row.created_at,
            })
        })
        .collect())
}

/// `days` is clamped to 1..=90; `include_cli` skips the log scan for the compact chat view.
pub fn report(days: i64, include_cli: bool) -> Result<Value, String> {
    let days = days.clamp(1, 90);
    let conn = open_ledger().ok();
    let offset = local_offset_secs(conn.as_ref());
    let now = now_ms();
    let today = local_day(now, offset);
    let day_start = now - (now + offset * 1000).rem_euclid(DAY_MS);
    let since = day_start - (days - 1) * DAY_MS;
    let app = match conn.as_ref() {
        Some(conn) => json!({
            "available": true,
            "summary": serde_json::to_value(usage_summary(conn, since)?).map_err(|e| e.to_string())?,
            "daily": ledger_daily(conn, since)?,
            "models": ledger_models(conn, since)?,
            "recent": ledger_recent(conn)?,
        }),
        None => json!({ "available": false }),
    };
    let (claude, codex) = if include_cli {
        (claude_usage(since, offset, &today), codex_usage(since, offset, &today))
    } else {
        (Value::Null, Value::Null)
    };
    Ok(json!({
        "days": days,
        "since": since,
        "today": today,
        "generatedAt": now,
        "alerts": crate::alerts::get_usage_alerts().ok(),
        "app": app,
        "claude": claude,
        "codex": codex,
    }))
}

#[tauri::command]
pub async fn get_usage_report(days: Option<i64>, include_cli: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || report(days.unwrap_or(1), include_cli.unwrap_or(true)))
        .await
        .map_err(|error| format!("사용량 집계 실패: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_timestamps() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("1970-01-02T00:00:01.5Z"), Some(DAY_MS + 1500));
        assert_eq!(parse_iso_ms("2026-10-14T03:04:05.678Z"), Some(1_791_947_045_678));
        assert_eq!(parse_iso_ms("not a date"), None);
    }

    #[test]
    fn buckets_days_in_local_time() {
        let ms = parse_iso_ms("2026-10-14T20:00:00Z").unwrap();
        assert_eq!(local_day(ms, 0), "2026-10-14");
        assert_eq!(local_day(ms, 9 * 3600), "2026-10-15");
        assert_eq!(local_day(ms, -21 * 3600), "2026-10-13");
    }

    #[test]
    fn civil_conversion_round_trips() {
        for days in [-1000, 0, 365, 10_957, 20_740, 30_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }

    #[test]
    fn report_has_app_section_without_cli_scan() {
        let value = report(1, false).expect("report");
        assert_eq!(value["days"], 1);
        assert!(value["claude"].is_null());
        assert!(value.get("app").is_some());
    }
}
