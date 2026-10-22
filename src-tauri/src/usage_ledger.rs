use crate::chat_state::open_state_db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_USAGE_ROWS: i64 = 5_000;
const MAX_HISTORY_ROWS: i64 = 500;

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

pub fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS api_usage (\n\
               id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
               session_id TEXT,\n\
               task_id TEXT,\n\
               role TEXT,\n\
               provider TEXT NOT NULL,\n\
               model TEXT NOT NULL,\n\
               cost_class TEXT NOT NULL,\n\
               input_tokens INTEGER NOT NULL DEFAULT 0,\n\
               output_tokens INTEGER NOT NULL DEFAULT 0,\n\
               cached_tokens INTEGER NOT NULL DEFAULT 0,\n\
               cost_usd REAL NOT NULL DEFAULT 0,\n\
               estimated_paid_usd REAL NOT NULL DEFAULT 0,\n\
               latency_ms INTEGER NOT NULL DEFAULT 0,\n\
               retries INTEGER NOT NULL DEFAULT 0,\n\
               cache_hit INTEGER NOT NULL DEFAULT 0,\n\
               status TEXT NOT NULL,\n\
               error TEXT,\n\
               created_at INTEGER NOT NULL\n\
             );\n\
             CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at DESC);\n\
             CREATE TABLE IF NOT EXISTS provider_models (\n\
               provider TEXT NOT NULL,\n\
               model_id TEXT NOT NULL,\n\
               is_free INTEGER NOT NULL DEFAULT 0,\n\
               source TEXT NOT NULL,\n\
               context_length INTEGER NOT NULL DEFAULT 0,\n\
               verified_at INTEGER NOT NULL,\n\
               success_count INTEGER NOT NULL DEFAULT 0,\n\
               failure_count INTEGER NOT NULL DEFAULT 0,\n\
               last_error TEXT,\n\
               active INTEGER NOT NULL DEFAULT 1,\n\
               PRIMARY KEY(provider, model_id)\n\
             );\n\
             CREATE TABLE IF NOT EXISTS paid_approvals (\n\
               id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
               provider TEXT NOT NULL,\n\
               session_id TEXT,\n\
               reason TEXT NOT NULL,\n\
               approved INTEGER NOT NULL,\n\
               max_calls INTEGER NOT NULL DEFAULT 0,\n\
               used_calls INTEGER NOT NULL DEFAULT 0,\n\
               created_at INTEGER NOT NULL,\n\
               expires_at INTEGER NOT NULL\n\
             );\n\
             CREATE TABLE IF NOT EXISTS prompt_cache (\n\
               cache_key TEXT PRIMARY KEY,\n\
               provider TEXT NOT NULL,\n\
               model TEXT NOT NULL,\n\
               source_fingerprint TEXT NOT NULL,\n\
               response TEXT NOT NULL,\n\
               hits INTEGER NOT NULL DEFAULT 0,\n\
               created_at INTEGER NOT NULL,\n\
               last_hit_at INTEGER\n\
             );\n\
             CREATE TABLE IF NOT EXISTS update_history (\n\
               id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
               category TEXT NOT NULL,\n\
               target TEXT NOT NULL,\n\
               from_version TEXT,\n\
               to_version TEXT,\n\
               status TEXT NOT NULL,\n\
               message TEXT,\n\
               created_at INTEGER NOT NULL\n\
             );\n\
             CREATE TABLE IF NOT EXISTS test_results (\n\
               id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
               session_id TEXT,\n\
               task_id TEXT,\n\
               agent TEXT,\n\
               command TEXT NOT NULL,\n\
               passed INTEGER NOT NULL,\n\
               duration_ms INTEGER NOT NULL,\n\
               summary TEXT,\n\
               created_at INTEGER NOT NULL\n\
             );\n\
             CREATE TABLE IF NOT EXISTS scheduled_jobs (\n\
               id TEXT PRIMARY KEY,\n\
               kind TEXT NOT NULL,\n\
               title TEXT NOT NULL,\n\
               interval_minutes INTEGER NOT NULL,\n\
               enabled INTEGER NOT NULL DEFAULT 1,\n\
               config TEXT NOT NULL DEFAULT '{}',\n\
               last_run_at INTEGER,\n\
               last_status TEXT,\n\
               last_output TEXT\n\
             );\n\
             CREATE TABLE IF NOT EXISTS job_runs (\n\
               id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
               job_id TEXT NOT NULL,\n\
               status TEXT NOT NULL,\n\
               output TEXT,\n\
               started_at INTEGER NOT NULL,\n\
               duration_ms INTEGER NOT NULL DEFAULT 0\n\
             );\n\
             CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, id DESC);",
        )
        .map_err(|error| format!("사용량 DB 초기화 실패: {error}"))
}

pub fn open_ledger() -> Result<Connection, String> {
    let connection = open_state_db()?;
    ensure_schema(&connection)?;
    Ok(connection)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub role: Option<String>,
    pub provider: String,
    pub model: String,
    pub cost_class: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub cost_usd: f64,
    pub estimated_paid_usd: f64,
    pub latency_ms: i64,
    pub retries: i64,
    pub cache_hit: bool,
    pub status: String,
    pub error: Option<String>,
}

pub fn insert_usage(connection: &Connection, entry: &UsageEntry) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO api_usage(session_id, task_id, role, provider, model, cost_class,\n\
               input_tokens, output_tokens, cached_tokens, cost_usd, estimated_paid_usd,\n\
               latency_ms, retries, cache_hit, status, error, created_at)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                entry.session_id,
                entry.task_id,
                entry.role,
                entry.provider,
                entry.model,
                entry.cost_class,
                entry.input_tokens,
                entry.output_tokens,
                entry.cached_tokens,
                entry.cost_usd,
                entry.estimated_paid_usd,
                entry.latency_ms,
                entry.retries,
                entry.cache_hit as i64,
                entry.status,
                entry.error.as_deref().map(crate::policy_engine::mask_secrets),
                now_millis(),
            ],
        )
        .map_err(|error| format!("사용량 기록 실패: {error}"))?;
    connection
        .execute(
            "DELETE FROM api_usage WHERE id NOT IN (SELECT id FROM api_usage ORDER BY id DESC LIMIT ?1)",
            params![MAX_USAGE_ROWS],
        )
        .map_err(|error| format!("오래된 사용량 정리 실패: {error}"))?;
    Ok(())
}

/// Set while the last usage write failed. Paid calls are refused meanwhile, since spending that
/// is not recorded would never count toward the daily limit.
static WRITE_FAILED: AtomicBool = AtomicBool::new(false);

pub fn last_write_failed() -> bool {
    WRITE_FAILED.load(Ordering::Relaxed)
}

pub fn record_usage(entry: &UsageEntry) {
    let result = open_ledger().and_then(|connection| {
        insert_usage(&connection, entry)?;
        Ok(connection)
    });
    match result {
        Ok(connection) => {
            WRITE_FAILED.store(false, Ordering::Relaxed);
            crate::alerts::check_usage(&connection);
        }
        Err(error) => {
            WRITE_FAILED.store(true, Ordering::Relaxed);
            eprintln!("{error}");
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub id: i64,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub role: Option<String>,
    pub provider: String,
    pub model: String,
    pub cost_class: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub cost_usd: f64,
    pub estimated_paid_usd: f64,
    pub latency_ms: i64,
    pub retries: i64,
    pub cache_hit: bool,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
}

pub fn list_usage_rows(connection: &Connection, limit: i64) -> Result<Vec<UsageRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, task_id, role, provider, model, cost_class, input_tokens,\n\
               output_tokens, cached_tokens, cost_usd, estimated_paid_usd, latency_ms, retries,\n\
               cache_hit, status, error, created_at\n\
             FROM api_usage ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|error| format!("사용량 조회 준비 실패: {error}"))?;
    let rows = statement
        .query_map(params![limit.clamp(1, 500)], |row| {
            Ok(UsageRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                task_id: row.get(2)?,
                role: row.get(3)?,
                provider: row.get(4)?,
                model: row.get(5)?,
                cost_class: row.get(6)?,
                input_tokens: row.get(7)?,
                output_tokens: row.get(8)?,
                cached_tokens: row.get(9)?,
                cost_usd: row.get(10)?,
                estimated_paid_usd: row.get(11)?,
                latency_ms: row.get(12)?,
                retries: row.get(13)?,
                cache_hit: row.get::<_, i64>(14)? != 0,
                status: row.get(15)?,
                error: row.get(16)?,
                created_at: row.get(17)?,
            })
        })
        .map_err(|error| format!("사용량 조회 실패: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("사용량 변환 실패: {error}"))
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageSummary {
    pub provider: String,
    pub calls: i64,
    pub errors: i64,
    pub retries: i64,
    pub cache_hits: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub estimated_paid_usd: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub since: i64,
    pub providers: Vec<ProviderUsageSummary>,
    pub total_cost_usd: f64,
    pub estimated_savings_usd: f64,
    pub tests_run: i64,
    pub tests_passed: i64,
}

pub fn usage_summary(connection: &Connection, since: i64) -> Result<UsageSummary, String> {
    let mut statement = connection
        .prepare(
            "SELECT provider, COUNT(*), SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END),\n\
               SUM(retries), SUM(cache_hit), SUM(input_tokens), SUM(output_tokens),\n\
               SUM(cost_usd), SUM(estimated_paid_usd)\n\
             FROM api_usage WHERE created_at >= ?1 GROUP BY provider ORDER BY provider",
        )
        .map_err(|error| format!("사용량 요약 준비 실패: {error}"))?;
    let providers = statement
        .query_map(params![since], |row| {
            Ok(ProviderUsageSummary {
                provider: row.get(0)?,
                calls: row.get(1)?,
                errors: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                retries: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                cache_hits: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                input_tokens: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                output_tokens: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                cost_usd: row.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
                estimated_paid_usd: row.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
            })
        })
        .map_err(|error| format!("사용량 요약 실패: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("사용량 요약 변환 실패: {error}"))?;
    // An empty f64 sum is -0.0, which formats as "-0.0000".
    let total_cost_usd = providers.iter().map(|row| row.cost_usd).sum::<f64>() + 0.0;
    let estimated_paid = providers.iter().map(|row| row.estimated_paid_usd).sum::<f64>() + 0.0;
    let (tests_run, tests_passed): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(passed), 0) FROM test_results WHERE created_at >= ?1",
            params![since],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("테스트 요약 실패: {error}"))?;
    Ok(UsageSummary {
        since,
        providers,
        total_cost_usd,
        estimated_savings_usd: (estimated_paid - total_cost_usd).max(0.0),
        tests_run,
        tests_passed,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub provider: String,
    pub model_id: String,
    pub is_free: bool,
    pub source: String,
    pub context_length: i64,
    pub verified_at: i64,
    pub success_count: i64,
    pub failure_count: i64,
    pub last_error: Option<String>,
    pub active: bool,
}

pub fn upsert_model(
    connection: &Connection,
    provider: &str,
    model_id: &str,
    is_free: bool,
    source: &str,
    context_length: i64,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO provider_models(provider, model_id, is_free, source, context_length, verified_at, active)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)\n\
             ON CONFLICT(provider, model_id) DO UPDATE SET\n\
               is_free = excluded.is_free, source = excluded.source,\n\
               context_length = excluded.context_length, verified_at = excluded.verified_at, active = 1",
            params![provider, model_id, is_free as i64, source, context_length, now_millis()],
        )
        .map_err(|error| format!("모델 목록 저장 실패: {error}"))?;
    Ok(())
}

pub fn deactivate_missing_models(
    connection: &Connection,
    provider: &str,
    keep: &[String],
) -> Result<(), String> {
    let rows = list_models(connection, Some(provider))?;
    for row in rows {
        if !keep.iter().any(|id| id == &row.model_id) {
            connection
                .execute(
                    "UPDATE provider_models SET active = 0 WHERE provider = ?1 AND model_id = ?2",
                    params![provider, row.model_id],
                )
                .map_err(|error| format!("모델 비활성화 실패: {error}"))?;
        }
    }
    Ok(())
}

pub fn record_model_result(
    connection: &Connection,
    provider: &str,
    model_id: &str,
    ok: bool,
    error: Option<&str>,
) -> Result<(), String> {
    let sql = if ok {
        "UPDATE provider_models SET success_count = success_count + 1, last_error = NULL\n\
         WHERE provider = ?1 AND model_id = ?2"
    } else {
        "UPDATE provider_models SET failure_count = failure_count + 1, last_error = ?3\n\
         WHERE provider = ?1 AND model_id = ?2"
    };
    let masked = error.map(crate::policy_engine::mask_secrets);
    let result = if ok {
        connection.execute(sql, params![provider, model_id])
    } else {
        connection.execute(sql, params![provider, model_id, masked])
    };
    result.map_err(|error| format!("모델 결과 기록 실패: {error}"))?;
    Ok(())
}

pub fn list_models(connection: &Connection, provider: Option<&str>) -> Result<Vec<ProviderModel>, String> {
    let mut statement = connection
        .prepare(
            "SELECT provider, model_id, is_free, source, context_length, verified_at,\n\
               success_count, failure_count, last_error, active\n\
             FROM provider_models WHERE (?1 IS NULL OR provider = ?1)\n\
             ORDER BY provider, active DESC, is_free DESC,\n\
               (success_count + 1.0) / (success_count + failure_count + 2.0) DESC, model_id",
        )
        .map_err(|error| format!("모델 목록 조회 준비 실패: {error}"))?;
    let rows = statement
        .query_map(params![provider], |row| {
            Ok(ProviderModel {
                provider: row.get(0)?,
                model_id: row.get(1)?,
                is_free: row.get::<_, i64>(2)? != 0,
                source: row.get(3)?,
                context_length: row.get(4)?,
                verified_at: row.get(5)?,
                success_count: row.get(6)?,
                failure_count: row.get(7)?,
                last_error: row.get(8)?,
                active: row.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(|error| format!("모델 목록 조회 실패: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("모델 목록 변환 실패: {error}"))
}

pub fn model_is_free(connection: &Connection, provider: &str, model_id: &str) -> bool {
    connection
        .query_row(
            "SELECT is_free FROM provider_models WHERE provider = ?1 AND model_id = ?2 AND active = 1",
            params![provider, model_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .map(|value| value != 0)
        .unwrap_or(false)
}

pub fn models_refreshed_at(connection: &Connection, provider: &str) -> Option<i64> {
    connection
        .query_row(
            "SELECT MAX(verified_at) FROM provider_models WHERE provider = ?1",
            params![provider],
            |row| row.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaidApproval {
    pub id: i64,
    pub provider: String,
    pub session_id: Option<String>,
    pub reason: String,
    pub approved: bool,
    pub max_calls: i64,
    pub used_calls: i64,
    pub created_at: i64,
    pub expires_at: i64,
}

pub fn insert_approval(
    connection: &Connection,
    provider: &str,
    session_id: Option<&str>,
    reason: &str,
    approved: bool,
    max_calls: i64,
    ttl_ms: i64,
) -> Result<i64, String> {
    let now = now_millis();
    connection
        .execute(
            "INSERT INTO paid_approvals(provider, session_id, reason, approved, max_calls, created_at, expires_at)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![provider, session_id, reason, approved as i64, max_calls, now, now + ttl_ms],
        )
        .map_err(|error| format!("승인 기록 실패: {error}"))?;
    Ok(connection.last_insert_rowid())
}

/// Consumes one call from an active approval. Returns false when none is usable.
pub fn consume_approval(connection: &Connection, provider: &str, session_id: Option<&str>) -> Result<bool, String> {
    let changed = connection
        .execute(
            "UPDATE paid_approvals SET used_calls = used_calls + 1\n\
             WHERE used_calls < max_calls AND id = (\n\
               SELECT id FROM paid_approvals\n\
               WHERE provider = ?1 AND approved = 1 AND expires_at > ?2 AND used_calls < max_calls\n\
                 AND (session_id IS NULL OR session_id = ?3)\n\
               ORDER BY id DESC LIMIT 1)",
            params![provider, now_millis(), session_id],
        )
        .map_err(|error| format!("승인 사용 기록 실패: {error}"))?;
    Ok(changed == 1)
}

pub fn list_approvals(connection: &Connection, limit: i64) -> Result<Vec<PaidApproval>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, provider, session_id, reason, approved, max_calls, used_calls, created_at, expires_at\n\
             FROM paid_approvals ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|error| format!("승인 내역 조회 준비 실패: {error}"))?;
    let rows = statement
        .query_map(params![limit.clamp(1, 200)], |row| {
            Ok(PaidApproval {
                id: row.get(0)?,
                provider: row.get(1)?,
                session_id: row.get(2)?,
                reason: row.get(3)?,
                approved: row.get::<_, i64>(4)? != 0,
                max_calls: row.get(5)?,
                used_calls: row.get(6)?,
                created_at: row.get(7)?,
                expires_at: row.get(8)?,
            })
        })
        .map_err(|error| format!("승인 내역 조회 실패: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("승인 내역 변환 실패: {error}"))
}

pub fn cache_get(connection: &Connection, cache_key: &str, fingerprint: &str) -> Option<String> {
    let found: Option<(String, String)> = connection
        .query_row(
            "SELECT response, source_fingerprint FROM prompt_cache WHERE cache_key = ?1",
            params![cache_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    let (response, stored) = found?;
    if stored != fingerprint {
        let _ = connection.execute("DELETE FROM prompt_cache WHERE cache_key = ?1", params![cache_key]);
        return None;
    }
    let _ = connection.execute(
        "UPDATE prompt_cache SET hits = hits + 1, last_hit_at = ?2 WHERE cache_key = ?1",
        params![cache_key, now_millis()],
    );
    Some(response)
}

pub fn cache_put(
    connection: &Connection,
    cache_key: &str,
    provider: &str,
    model: &str,
    fingerprint: &str,
    response: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO prompt_cache(cache_key, provider, model, source_fingerprint, response, created_at)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)\n\
             ON CONFLICT(cache_key) DO UPDATE SET response = excluded.response,\n\
               source_fingerprint = excluded.source_fingerprint, created_at = excluded.created_at",
            params![cache_key, provider, model, fingerprint, response, now_millis()],
        )
        .map_err(|error| format!("프롬프트 캐시 저장 실패: {error}"))?;
    connection
        .execute(
            "DELETE FROM prompt_cache WHERE cache_key NOT IN\n\
             (SELECT cache_key FROM prompt_cache ORDER BY COALESCE(last_hit_at, created_at) DESC LIMIT 1000)",
            [],
        )
        .map_err(|error| format!("프롬프트 캐시 정리 실패: {error}"))?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecord {
    pub id: i64,
    pub category: String,
    pub target: String,
    pub from_version: Option<String>,
    pub to_version: Option<String>,
    pub status: String,
    pub message: Option<String>,
    pub created_at: i64,
}

pub fn insert_update(
    connection: &Connection,
    category: &str,
    target: &str,
    from_version: Option<&str>,
    to_version: Option<&str>,
    status: &str,
    message: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO update_history(category, target, from_version, to_version, status, message, created_at)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                category,
                target,
                from_version,
                to_version,
                status,
                message.map(crate::policy_engine::mask_secrets),
                now_millis()
            ],
        )
        .map_err(|error| format!("업데이트 이력 기록 실패: {error}"))?;
    connection
        .execute(
            "DELETE FROM update_history WHERE id NOT IN (SELECT id FROM update_history ORDER BY id DESC LIMIT ?1)",
            params![MAX_HISTORY_ROWS],
        )
        .map_err(|error| format!("업데이트 이력 정리 실패: {error}"))?;
    Ok(())
}

pub fn list_updates(connection: &Connection, limit: i64) -> Result<Vec<UpdateRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, category, target, from_version, to_version, status, message, created_at\n\
             FROM update_history ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|error| format!("업데이트 이력 조회 준비 실패: {error}"))?;
    let rows = statement
        .query_map(params![limit.clamp(1, 200)], |row| {
            Ok(UpdateRecord {
                id: row.get(0)?,
                category: row.get(1)?,
                target: row.get(2)?,
                from_version: row.get(3)?,
                to_version: row.get(4)?,
                status: row.get(5)?,
                message: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("업데이트 이력 조회 실패: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("업데이트 이력 변환 실패: {error}"))
}

pub fn insert_test_result(
    connection: &Connection,
    session_id: Option<&str>,
    task_id: Option<&str>,
    agent: Option<&str>,
    command: &str,
    passed: bool,
    duration_ms: i64,
    summary: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO test_results(session_id, task_id, agent, command, passed, duration_ms, summary, created_at)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                session_id,
                task_id,
                agent,
                command,
                passed as i64,
                duration_ms,
                crate::policy_engine::mask_secrets(summary),
                now_millis()
            ],
        )
        .map_err(|error| format!("테스트 결과 기록 실패: {error}"))?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSuccessRate {
    pub agent: String,
    pub runs: i64,
    pub passed: i64,
}

pub fn test_success_by_agent(connection: &Connection, since: i64) -> Result<Vec<AgentSuccessRate>, String> {
    let mut statement = connection
        .prepare(
            "SELECT COALESCE(agent, 'unknown'), COUNT(*), SUM(passed) FROM test_results\n\
             WHERE created_at >= ?1 GROUP BY COALESCE(agent, 'unknown') ORDER BY 1",
        )
        .map_err(|error| format!("에이전트 성공률 조회 준비 실패: {error}"))?;
    let rows = statement
        .query_map(params![since], |row| {
            Ok(AgentSuccessRate {
                agent: row.get(0)?,
                runs: row.get(1)?,
                passed: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            })
        })
        .map_err(|error| format!("에이전트 성공률 조회 실패: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("에이전트 성공률 변환 실패: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        ensure_schema(&connection).unwrap();
        connection
    }

    #[test]
    fn usage_summary_separates_billed_cost_and_estimated_savings() {
        let connection = memory();
        let mut entry = UsageEntry {
            provider: "gemini_api".into(),
            model: "gemini-2.5-flash".into(),
            cost_class: "free".into(),
            input_tokens: 100,
            output_tokens: 50,
            estimated_paid_usd: 0.5,
            status: "ok".into(),
            ..Default::default()
        };
        insert_usage(&connection, &entry).unwrap();
        entry.provider = "openai_api".into();
        entry.cost_class = "paid".into();
        entry.cost_usd = 0.2;
        entry.estimated_paid_usd = 0.2;
        entry.status = "error".into();
        entry.retries = 2;
        insert_usage(&connection, &entry).unwrap();

        let summary = usage_summary(&connection, 0).unwrap();
        assert_eq!(summary.providers.len(), 2);
        assert!((summary.total_cost_usd - 0.2).abs() < 1e-9);
        assert!((summary.estimated_savings_usd - 0.5).abs() < 1e-9);
        let openai = summary.providers.iter().find(|row| row.provider == "openai_api").unwrap();
        assert_eq!(openai.errors, 1);
        assert_eq!(openai.retries, 2);
    }

    #[test]
    fn approval_is_consumed_until_exhausted() {
        let connection = memory();
        assert!(!consume_approval(&connection, "openai_api", Some("s1")).unwrap());
        insert_approval(&connection, "openai_api", Some("s1"), "test", true, 2, 60_000).unwrap();
        assert!(consume_approval(&connection, "openai_api", Some("s1")).unwrap());
        assert!(consume_approval(&connection, "openai_api", Some("s1")).unwrap());
        assert!(!consume_approval(&connection, "openai_api", Some("s1")).unwrap());
    }

    #[test]
    fn session_approval_is_not_usable_by_other_callers() {
        let connection = memory();
        insert_approval(&connection, "openai_api", Some("s1"), "test", true, 5, 60_000).unwrap();
        assert!(!consume_approval(&connection, "openai_api", None).unwrap());
        assert!(!consume_approval(&connection, "openai_api", Some("s2")).unwrap());
        assert!(consume_approval(&connection, "openai_api", Some("s1")).unwrap());
        insert_approval(&connection, "openai_api", None, "global", true, 1, 60_000).unwrap();
        assert!(consume_approval(&connection, "openai_api", None).unwrap());
    }

    #[test]
    fn denied_approval_is_never_usable() {
        let connection = memory();
        insert_approval(&connection, "openai_api", None, "test", false, 5, 60_000).unwrap();
        assert!(!consume_approval(&connection, "openai_api", None).unwrap());
    }

    #[test]
    fn unknown_models_are_not_free() {
        let connection = memory();
        assert!(!model_is_free(&connection, "openrouter_api", "x/y:free"));
        upsert_model(&connection, "openrouter_api", "x/y:free", true, "openrouter_pricing", 32_000).unwrap();
        assert!(model_is_free(&connection, "openrouter_api", "x/y:free"));
        deactivate_missing_models(&connection, "openrouter_api", &[]).unwrap();
        assert!(!model_is_free(&connection, "openrouter_api", "x/y:free"));
    }

    #[test]
    fn prompt_cache_invalidates_on_fingerprint_change() {
        let connection = memory();
        cache_put(&connection, "k", "gemini_api", "m", "fp1", "answer").unwrap();
        assert_eq!(cache_get(&connection, "k", "fp1").as_deref(), Some("answer"));
        assert_eq!(cache_get(&connection, "k", "fp2"), None);
        assert_eq!(cache_get(&connection, "k", "fp1"), None);
    }
}
