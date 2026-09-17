use crate::chat_state::open_state_db;
use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_RUN_RECORDS: usize = 200;
pub const MAX_ERROR_DETAIL_CHARS: usize = 2_000;
const MAX_ERROR_SUMMARY_CHARS: usize = 280;

#[derive(Clone, Copy, Debug)]
pub enum RunStatus {
    Completed,
    Cancelled,
    Failed,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecord {
    pub id: i64,
    pub task_id: String,
    pub conversation_id: Option<String>,
    pub agent: String,
    pub model: Option<String>,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error_summary: Option<String>,
    pub error_detail: Option<String>,
}

fn now_millis() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("시스템 시간 확인 실패: {error}"))?;
    Ok(duration.as_millis().min(i64::MAX as u128) as i64)
}

pub fn make_history_task_id() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("history-{millis}-{sequence}")
}

fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_runs (\n\
               id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
               task_id TEXT NOT NULL UNIQUE,\n\
               conversation_id TEXT,\n\
               agent TEXT NOT NULL,\n\
               model TEXT,\n\
               status TEXT NOT NULL,\n\
               started_at INTEGER NOT NULL,\n\
               finished_at INTEGER,\n\
               duration_ms INTEGER,\n\
               error_summary TEXT,\n\
               error_detail TEXT\n\
             );\n\
             CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at\n\
               ON agent_runs(started_at DESC, id DESC);",
        )
        .map_err(|error| format!("Agent 실행 기록 DB 초기화 실패: {error}"))
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn summarize_error(detail: &str) -> String {
    let lower = detail.to_lowercase();
    let summary = if detail.contains("취소") || lower.contains("cancel") {
        "Agent 실행이 취소되었습니다.".to_string()
    } else if detail.contains("시간") && detail.contains("초과")
        || lower.contains("timeout")
        || lower.contains("timed out")
    {
        "Agent 실행 시간이 제한을 초과했습니다.".to_string()
    } else if detail.contains("CLI를 찾을 수 없습니다")
        || detail.contains("실행 파일을 찾을 수 없습니다")
        || lower.contains("enoent")
    {
        "Agent CLI 또는 실행 파일을 찾을 수 없습니다.".to_string()
    } else if detail.contains("권한")
        || lower.contains("permission denied")
        || lower.contains("eacces")
    {
        "파일 또는 실행 파일 접근 권한 오류입니다.".to_string()
    } else {
        detail
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Agent 실행 중 오류가 발생했습니다.")
            .trim()
            .to_string()
    };
    truncate_chars(&summary, MAX_ERROR_SUMMARY_CHARS)
}

fn prune_old_runs(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM agent_runs\n\
             WHERE id NOT IN (\n\
               SELECT id FROM agent_runs\n\
               ORDER BY started_at DESC, id DESC\n\
               LIMIT ?1\n\
             )",
            params![MAX_RUN_RECORDS as i64],
        )
        .map_err(|error| format!("오래된 Agent 실행 기록 정리 실패: {error}"))?;
    Ok(())
}

pub fn record_run_start(
    task_id: &str,
    conversation_id: Option<&str>,
    agent: &str,
    model: Option<&str>,
) -> Result<(), String> {
    let connection = open_state_db()?;
    ensure_schema(&connection)?;
    let started_at = now_millis()?;
    connection
        .execute(
            "INSERT INTO agent_runs(\n\
               task_id, conversation_id, agent, model, status, started_at\n\
             ) VALUES (?1, ?2, ?3, ?4, 'running', ?5)\n\
             ON CONFLICT(task_id) DO UPDATE SET\n\
               conversation_id = excluded.conversation_id,\n\
               agent = excluded.agent,\n\
               model = excluded.model,\n\
               status = 'running',\n\
               started_at = excluded.started_at,\n\
               finished_at = NULL,\n\
               duration_ms = NULL,\n\
               error_summary = NULL,\n\
               error_detail = NULL",
            params![task_id, conversation_id, agent, model, started_at],
        )
        .map_err(|error| format!("Agent 실행 시작 기록 실패: {error}"))?;
    prune_old_runs(&connection)
}

pub fn record_run_finish(
    task_id: &str,
    status: RunStatus,
    duration_ms: u128,
    error_detail: Option<&str>,
) -> Result<(), String> {
    let connection = open_state_db()?;
    ensure_schema(&connection)?;
    let finished_at = now_millis()?;
    let duration_ms = duration_ms.min(i64::MAX as u128) as i64;
    let (summary, detail) = match error_detail {
        Some(value) if !value.trim().is_empty() => (
            Some(summarize_error(value)),
            Some(truncate_chars(value.trim(), MAX_ERROR_DETAIL_CHARS)),
        ),
        _ => (None, None),
    };
    connection
        .execute(
            "UPDATE agent_runs SET\n\
               status = ?2,\n\
               finished_at = ?3,\n\
               duration_ms = ?4,\n\
               error_summary = ?5,\n\
               error_detail = ?6\n\
             WHERE task_id = ?1",
            params![
                task_id,
                status.as_str(),
                finished_at,
                duration_ms,
                summary,
                detail,
            ],
        )
        .map_err(|error| format!("Agent 실행 완료 기록 실패: {error}"))?;
    prune_old_runs(&connection)
}

pub fn list_agent_runs(limit: Option<u32>) -> Result<Vec<AgentRunRecord>, String> {
    let connection = open_state_db()?;
    ensure_schema(&connection)?;
    let limit = limit.unwrap_or(30).clamp(1, 100) as i64;
    let mut statement = connection
        .prepare(
            "SELECT id, task_id, conversation_id, agent, model, status,\n\
                    started_at, finished_at, duration_ms, error_summary, error_detail\n\
             FROM agent_runs\n\
             ORDER BY started_at DESC, id DESC\n\
             LIMIT ?1",
        )
        .map_err(|error| format!("Agent 실행 기록 조회 준비 실패: {error}"))?;
    let rows = statement
        .query_map(params![limit], |row| {
            Ok(AgentRunRecord {
                id: row.get(0)?,
                task_id: row.get(1)?,
                conversation_id: row.get(2)?,
                agent: row.get(3)?,
                model: row.get(4)?,
                status: row.get(5)?,
                started_at: row.get(6)?,
                finished_at: row.get(7)?,
                duration_ms: row.get(8)?,
                error_summary: row.get(9)?,
                error_detail: row.get(10)?,
            })
        })
        .map_err(|error| format!("Agent 실행 기록 조회 실패: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Agent 실행 기록 변환 실패: {error}"))
}
