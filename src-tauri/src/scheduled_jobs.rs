use crate::context_optimizer::limit_output;
use crate::policy_engine::{ask_risky_approval_blocking, classify_command, mask_secrets, CommandRisk};
use crate::process_util::{find_tool, run_command_cancellable, CommandOutput};
use crate::settings::load_settings;
use crate::usage_ledger::{self, now_millis};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(180);
const CHECK_INTERVAL: Duration = Duration::from_secs(600);
const MAX_OUTPUT_CHARS: usize = 6000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const SKIP_PREFIX: &str = "SKIP|";
const NEEDS_APPROVAL_PREFIX: &str = "APPROVAL|";
const CANCELLED_PREFIX: &str = "CANCELLED|";
/// Set only by the backend after the user confirms the exact command in a native dialog.
const APPROVED_COMMAND_KEY: &str = "approvedCommand";

static RUNNING_JOBS: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);
const CANCELLED_MESSAGE: &str = "사용자가 실행을 중지했습니다.";
const MAX_RUNS_PER_JOB: i64 = 20;
static NEXT_SCAN_MS: AtomicI64 = AtomicI64::new(0);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobRuntime {
    pub running: Vec<String>,
    pub next_scan_at: Option<i64>,
    pub paused_for_cradle: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJob {
    pub id: String,
    /// usage_report | gh_pr_summary | shell
    pub kind: String,
    pub title: String,
    pub interval_minutes: i64,
    pub enabled: bool,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    #[serde(default)]
    pub last_status: Option<String>,
    #[serde(default)]
    pub last_output: Option<String>,
}

fn default_jobs() -> Vec<ScheduledJob> {
    let job = |id: &str, kind: &str, title: &str, interval: i64, config: serde_json::Value| ScheduledJob {
        id: id.to_string(),
        kind: kind.to_string(),
        title: title.to_string(),
        interval_minutes: interval,
        enabled: true,
        config,
        last_run_at: None,
        last_status: None,
        last_output: None,
    };
    vec![
        job("daily-report", "usage_report", "일일 변경 보고서", 24 * 60, serde_json::json!({ "days": 1 })),
        job("weekly-report", "usage_report", "주간 변경 보고서", 7 * 24 * 60, serde_json::json!({ "days": 7 })),
        job("pr-summary", "gh_pr_summary", "열린 PR 요약 (gh)", 24 * 60, serde_json::json!({ "limit": 20 })),
    ]
}

pub fn ensure_default_jobs(connection: &Connection) -> Result<(), String> {
    for job in default_jobs() {
        connection
            .execute(
                "INSERT OR IGNORE INTO scheduled_jobs(id, kind, title, interval_minutes, enabled, config)\n\
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![job.id, job.kind, job.title, job.interval_minutes, job.enabled as i64, job.config.to_string()],
            )
            .map_err(|error| format!("기본 예약 작업 등록 실패: {error}"))?;
    }
    Ok(())
}

pub fn list_jobs(connection: &Connection) -> Result<Vec<ScheduledJob>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, kind, title, interval_minutes, enabled, config, last_run_at, last_status, last_output\n\
             FROM scheduled_jobs ORDER BY id",
        )
        .map_err(|error| format!("예약 작업 조회 준비 실패: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let config: String = row.get(5)?;
            Ok(ScheduledJob {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                interval_minutes: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                config: serde_json::from_str(&config).unwrap_or(serde_json::Value::Null),
                last_run_at: row.get(6)?,
                last_status: row.get(7)?,
                last_output: row.get(8)?,
            })
        })
        .map_err(|error| format!("예약 작업 조회 실패: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("예약 작업 변환 실패: {error}"))
}

fn validate_job(job: &ScheduledJob) -> Result<(), String> {
    let id_ok = !job.id.is_empty()
        && job.id.len() <= 64
        && job.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !id_ok {
        return Err("작업 ID는 영문, 숫자, -, _ 로 64자 이내여야 합니다.".to_string());
    }
    if !matches!(job.kind.as_str(), "usage_report" | "gh_pr_summary" | "shell") {
        return Err(format!("지원하지 않는 작업 종류입니다: {}", job.kind));
    }
    if let Some(default) = default_jobs().into_iter().find(|default| default.id == job.id) {
        if default.kind != job.kind {
            return Err("기본 작업의 종류는 바꿀 수 없습니다.".to_string());
        }
    }
    if !(5..=60 * 24 * 31).contains(&job.interval_minutes) {
        return Err("실행 간격은 5분에서 31일 사이여야 합니다.".to_string());
    }
    if job.kind == "shell" {
        let command = job.config.get("command").and_then(|value| value.as_str()).unwrap_or("").trim();
        if command.is_empty() {
            return Err("셸 작업에는 command가 필요합니다.".to_string());
        }
        if classify_command(command) == CommandRisk::Blocked {
            return Err("차단된 명령은 예약할 수 없습니다.".to_string());
        }
    }
    Ok(())
}

pub fn save_job(connection: &Connection, job: &ScheduledJob) -> Result<(), String> {
    validate_job(job)?;
    connection
        .execute(
            "INSERT INTO scheduled_jobs(id, kind, title, interval_minutes, enabled, config)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)\n\
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title,\n\
               interval_minutes = excluded.interval_minutes, enabled = excluded.enabled, config = excluded.config",
            params![
                job.id,
                job.kind,
                job.title.trim(),
                job.interval_minutes,
                job.enabled as i64,
                job.config.to_string()
            ],
        )
        .map_err(|error| format!("예약 작업 저장 실패: {error}"))?;
    Ok(())
}

pub fn is_due(job: &ScheduledJob, now: i64) -> bool {
    job.enabled
        && match job.last_run_at {
            None => true,
            Some(last) => now - last >= job.interval_minutes * 60_000,
        }
}

fn record_run(connection: &Connection, id: &str, status: &str, output: &str, started_at: i64) -> Result<(), String> {
    let finished_at = now_millis();
    let output = limit_output(&mask_secrets(output), MAX_OUTPUT_CHARS);
    connection
        .execute(
            "UPDATE scheduled_jobs SET last_run_at = ?1, last_status = ?2, last_output = ?3 WHERE id = ?4",
            params![finished_at, status, output, id],
        )
        .map_err(|error| format!("예약 작업 결과 기록 실패: {error}"))?;
    connection
        .execute(
            "INSERT INTO job_runs(job_id, status, output, started_at, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, status, output, started_at, (finished_at - started_at).max(0)],
        )
        .map_err(|error| format!("예약 작업 기록 저장 실패: {error}"))?;
    connection
        .execute(
            "DELETE FROM job_runs WHERE job_id = ?1 AND id NOT IN \
             (SELECT id FROM job_runs WHERE job_id = ?1 ORDER BY id DESC LIMIT ?2)",
            params![id, MAX_RUNS_PER_JOB],
        )
        .map_err(|error| format!("오래된 예약 작업 기록 정리 실패: {error}"))?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobRun {
    pub status: String,
    pub output: String,
    pub started_at: i64,
    pub duration_ms: i64,
}

fn list_runs(connection: &Connection, id: &str, limit: i64) -> Result<Vec<JobRun>, String> {
    let mut statement = connection
        .prepare(
            "SELECT status, output, started_at, duration_ms FROM job_runs WHERE job_id = ?1 ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|error| format!("예약 작업 기록 조회 실패: {error}"))?;
    let rows = statement
        .query_map(params![id, limit], |row| {
            Ok(JobRun {
                status: row.get(0)?,
                output: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                started_at: row.get(2)?,
                duration_ms: row.get(3)?,
            })
        })
        .map_err(|error| format!("예약 작업 기록 조회 실패: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("예약 작업 기록 읽기 실패: {error}"))
}

fn open() -> Result<Connection, String> {
    let connection = usage_ledger::open_ledger()?;
    ensure_default_jobs(&connection)?;
    Ok(connection)
}

#[derive(Default)]
pub struct ReportData {
    pub days: i64,
    pub summary: usage_ledger::UsageSummary,
    pub agents: Vec<usage_ledger::AgentSuccessRate>,
    pub updates: Vec<usage_ledger::UpdateRecord>,
    pub approvals: Vec<usage_ledger::PaidApproval>,
}

fn percent(passed: i64, total: i64) -> String {
    if total <= 0 {
        "-".to_string()
    } else {
        format!("{:.0}%", passed as f64 * 100.0 / total as f64)
    }
}

pub fn render_report(data: &ReportData) -> String {
    let mut out = String::new();
    let period = if data.days >= 7 { "주간" } else { "일일" };
    out.push_str(&format!("# AI Character {period} 보고서 (최근 {}일)\n\n", data.days));
    out.push_str("## 비용\n");
    out.push_str(&format!("- 실제 청구 비용: ${:.4}\n", data.summary.total_cost_usd));
    out.push_str(&format!(
        "- 절감 추정치(유료 API였다면 들었을 비용, 가정 기반): ${:.4}\n\n",
        data.summary.estimated_savings_usd
    ));
    out.push_str("## 모델/제공자별 호출\n");
    if data.summary.providers.is_empty() {
        out.push_str("- 호출 기록 없음\n");
    }
    for provider in &data.summary.providers {
        out.push_str(&format!(
            "- {}: {}회, 성공률 {}, 재시도 {}회, 캐시 적중 {}회, 비용 ${:.4}\n",
            provider.provider,
            provider.calls,
            percent(provider.calls - provider.errors, provider.calls),
            provider.retries,
            provider.cache_hits,
            provider.cost_usd
        ));
    }
    out.push_str(&format!(
        "\n## 테스트\n- 전체 통과율: {} ({} / {})\n",
        percent(data.summary.tests_passed, data.summary.tests_run),
        data.summary.tests_passed,
        data.summary.tests_run
    ));
    for agent in &data.agents {
        out.push_str(&format!("- {}: {} ({} / {})\n", agent.agent, percent(agent.passed, agent.runs), agent.passed, agent.runs));
    }
    out.push_str("\n## 승인 내역\n");
    if data.approvals.is_empty() {
        out.push_str("- 없음\n");
    }
    for approval in &data.approvals {
        out.push_str(&format!(
            "- {} {}: {}\n",
            if approval.approved { "승인" } else { "거절" },
            approval.provider,
            approval.reason
        ));
    }
    out.push_str("\n## 업데이트\n");
    if data.updates.is_empty() {
        out.push_str("- 없음\n");
    }
    for update in &data.updates {
        let versions = match (&update.from_version, &update.to_version) {
            (Some(from), Some(to)) => format!(" {from} → {to}"),
            _ => String::new(),
        };
        out.push_str(&format!("- [{}] {}{versions}: {}\n", update.category, update.target, update.status));
    }
    out
}

fn usage_report(connection: &Connection, job: &ScheduledJob) -> Result<String, String> {
    let days = job.config.get("days").and_then(|value| value.as_i64()).unwrap_or(1).clamp(1, 90);
    let since = now_millis() - days * DAY_MS;
    let data = ReportData {
        days,
        summary: usage_ledger::usage_summary(connection, since)?,
        agents: usage_ledger::test_success_by_agent(connection, since)?,
        updates: usage_ledger::list_updates(connection, 200)?
            .into_iter()
            .filter(|record| record.created_at >= since)
            .collect(),
        approvals: usage_ledger::list_approvals(connection, 200)?
            .into_iter()
            .filter(|record| record.created_at >= since)
            .collect(),
    };
    let report = render_report(&data);
    let dir = crate::chat_state::app_support_dir()?.join("reports");
    fs::create_dir_all(&dir).map_err(|error| format!("보고서 폴더 생성 실패: {error}"))?;
    let path = dir.join(format!("{}-{}.md", job.id, now_millis()));
    fs::write(&path, &report).map_err(|error| format!("보고서 저장 실패: {error}"))?;
    Ok(format!("보고서: {}\n\n{report}", path.display()))
}

fn project_dir() -> Option<PathBuf> {
    load_settings().ok().and_then(|settings| settings.project_dir)
}

pub fn render_pr_summary(json: &str) -> Result<String, String> {
    let prs: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|error| format!("gh 출력 해석 실패: {error}"))?;
    if prs.is_empty() {
        return Ok("열린 PR이 없습니다.".to_string());
    }
    let mut out = format!("열린 PR {}개\n", prs.len());
    for pr in prs {
        let text = |key: &str| pr.get(key).and_then(|value| value.as_str()).unwrap_or("").to_string();
        let author = pr
            .get("author")
            .and_then(|author| author.get("login"))
            .and_then(|value| value.as_str())
            .unwrap_or("?");
        let draft = if pr.get("isDraft").and_then(|value| value.as_bool()).unwrap_or(false) { " (초안)" } else { "" };
        let review = match text("reviewDecision").as_str() {
            "APPROVED" => " · 승인됨",
            "CHANGES_REQUESTED" => " · 수정 요청",
            "REVIEW_REQUIRED" => " · 리뷰 필요",
            _ => "",
        };
        out.push_str(&format!(
            "- #{} {}{draft} — @{author}{review}\n  {}\n",
            pr.get("number").and_then(|value| value.as_i64()).unwrap_or(0),
            text("title"),
            text("url")
        ));
    }
    Ok(out)
}

fn cancelled_error(output: &CommandOutput) -> String {
    let partial = output.output.trim();
    if partial.is_empty() {
        format!("{CANCELLED_PREFIX}{CANCELLED_MESSAGE}")
    } else {
        format!("{CANCELLED_PREFIX}{CANCELLED_MESSAGE}\n{partial}")
    }
}

fn gh_pr_summary(job: &ScheduledJob, cancel: &AtomicBool) -> Result<String, String> {
    let gh = find_tool("gh").ok_or_else(|| format!("{SKIP_PREFIX}gh CLI가 설치되어 있지 않습니다."))?;
    let limit = job.config.get("limit").and_then(|value| value.as_i64()).unwrap_or(20).clamp(1, 100);
    let mut args: Vec<String> = [
        "pr", "list", "--state", "open", "--limit", &limit.to_string(),
        "--json", "number,title,author,isDraft,reviewDecision,updatedAt,url",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    if let Some(repo) = job.config.get("repo").and_then(|value| value.as_str()).filter(|value| !value.trim().is_empty()) {
        args.push("--repo".to_string());
        args.push(repo.trim().to_string());
    }
    let cwd = project_dir();
    let has_repo = args.iter().any(|arg| arg == "--repo");
    let in_git_repo = cwd
        .as_deref()
        .map(|dir| dir.ancestors().any(|ancestor| ancestor.join(".git").exists()))
        .unwrap_or(false);
    if !has_repo && !in_git_repo {
        return Err(format!(
            "{SKIP_PREFIX}프로젝트 폴더가 git 저장소가 아니라 PR 요약을 건너뜁니다. 작업 설정에 repo(예: owner/name)를 지정하면 실행됩니다."
        ));
    }
    let output = run_command_cancellable(&gh, &args, cwd.as_deref(), false, Duration::from_secs(60), cancel);
    if output.cancelled {
        return Err(cancelled_error(&output));
    }
    if !output.success {
        return Err(format!("gh 실행 실패: {}", output.output.trim()));
    }
    render_pr_summary(output.output.trim())
}

fn job_command(job: &ScheduledJob) -> String {
    job.config
        .get("command")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn approved_command(job: &ScheduledJob) -> Option<&str> {
    job.config.get(APPROVED_COMMAND_KEY).and_then(|value| value.as_str())
}

/// `interactive` is true only when the user pressed "run now"; unattended runs never open dialogs.
fn shell_job(app: Option<&AppHandle>, job: &ScheduledJob, interactive: bool, cancel: &AtomicBool) -> Result<String, String> {
    let command = job_command(job);
    if approved_command(job) != Some(command.as_str()) {
        return Err(format!(
            "{NEEDS_APPROVAL_PREFIX}등록 승인을 받지 않은 명령이라 실행하지 않았습니다. 작업을 다시 저장해 승인하세요."
        ));
    }
    match classify_command(&command) {
        CommandRisk::Blocked => return Err("차단된 명령이라 실행하지 않았습니다.".to_string()),
        CommandRisk::NeedsApproval => {
            let Some(app) = app.filter(|_| interactive) else {
                return Err(format!(
                    "{NEEDS_APPROVAL_PREFIX}위험할 수 있는 명령이라 자동 실행하지 않았습니다. '지금 실행'으로 승인 후 실행하세요."
                ));
            };
            if !ask_risky_approval_blocking(app, &format!("예약 작업 '{}'", job.title), &command) {
                return Err("사용자가 실행을 취소했습니다.".to_string());
            }
        }
        CommandRisk::Safe => {}
    }
    let (program, args): (PathBuf, Vec<String>) = if cfg!(windows) {
        (PathBuf::from("cmd"), vec!["/C".to_string(), command.clone()])
    } else {
        (PathBuf::from("/bin/sh"), vec!["-c".to_string(), command.clone()])
    };
    let cwd = project_dir();
    let output = run_command_cancellable(&program, &args, cwd.as_deref(), true, Duration::from_secs(900), cancel);
    if output.cancelled {
        Err(cancelled_error(&output))
    } else if output.success {
        Ok(output.output)
    } else if output.timed_out {
        Err(format!("시간 초과\n{}", output.output))
    } else {
        Err(output.output)
    }
}

fn execute(
    app: Option<&AppHandle>,
    connection: &Connection,
    job: &ScheduledJob,
    interactive: bool,
    cancel: &AtomicBool,
) -> (String, String) {
    let result = match job.kind.as_str() {
        "usage_report" => usage_report(connection, job),
        "gh_pr_summary" => gh_pr_summary(job, cancel),
        "shell" => shell_job(app, job, interactive, cancel),
        other => Err(format!("지원하지 않는 작업 종류: {other}")),
    };
    match result {
        Ok(output) => ("ok".to_string(), output),
        Err(error) => {
            if let Some(reason) = error.strip_prefix(CANCELLED_PREFIX) {
                ("cancelled".to_string(), reason.to_string())
            } else if let Some(reason) = error.strip_prefix(SKIP_PREFIX) {
                ("skipped".to_string(), reason.to_string())
            } else if let Some(reason) = error.strip_prefix(NEEDS_APPROVAL_PREFIX) {
                ("needs_approval".to_string(), reason.to_string())
            } else {
                ("failed".to_string(), error)
            }
        }
    }
}

struct JobLock {
    id: String,
    cancel: Arc<AtomicBool>,
}

impl JobLock {
    fn acquire(id: &str) -> Option<Self> {
        let mut guard = RUNNING_JOBS.lock().ok()?;
        let running = guard.get_or_insert_with(HashMap::new);
        if running.contains_key(id) {
            return None;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        running.insert(id.to_string(), cancel.clone());
        Some(Self { id: id.to_string(), cancel })
    }
}

/// Signals a running job to stop; returns false when it is not running.
fn request_cancel(id: &str) -> bool {
    RUNNING_JOBS
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|running| running.get(id).cloned()))
        .map(|flag| flag.store(true, Ordering::SeqCst))
        .is_some()
}

impl Drop for JobLock {
    fn drop(&mut self) {
        if let Ok(mut guard) = RUNNING_JOBS.lock() {
            if let Some(running) = guard.as_mut() {
                running.remove(&self.id);
            }
        }
    }
}

fn run_and_record(app: Option<&AppHandle>, job: &ScheduledJob, interactive: bool) -> Result<ScheduledJob, String> {
    let lock = JobLock::acquire(&job.id).ok_or("이 작업은 이미 실행 중입니다.")?;
    let connection = open()?;
    let started_at = now_millis();
    let (status, output) = execute(app, &connection, job, interactive, &lock.cancel);
    record_run(&connection, &job.id, &status, &output, started_at)?;
    list_jobs(&connection)?
        .into_iter()
        .find(|candidate| candidate.id == job.id)
        .ok_or_else(|| "예약 작업을 찾지 못했습니다.".to_string())
}

fn notify(app: &AppHandle, jobs: &[ScheduledJob]) {
    let lines: Vec<String> = jobs
        .iter()
        .map(|job| {
            let status = match job.last_status.as_deref() {
                Some("ok") => "완료",
                Some("skipped") => "건너뜀",
                Some("needs_approval") => "승인 필요",
                Some("cancelled") => "중지됨",
                _ => "실패",
            };
            let first = job
                .last_output
                .as_deref()
                .and_then(|text| text.lines().find(|line| !line.trim().is_empty()))
                .unwrap_or("")
                .chars()
                .take(120)
                .collect::<String>();
            format!("{}: {status} — {first}", job.title)
        })
        .collect();
    if !lines.is_empty() {
        let _ = app.emit(
            crate::updates::UPDATE_NOTICE_EVENT,
            serde_json::json!({ "title": "예약 작업", "lines": lines }),
        );
    }
    let attention: Vec<&str> = jobs
        .iter()
        .filter(|job| matches!(job.last_status.as_deref(), Some("failed") | Some("needs_approval")))
        .map(|job| job.title.as_str())
        .collect();
    if !attention.is_empty() {
        crate::alerts::notify("예약 작업 확인 필요", &format!("{} — 실패했거나 승인이 필요합니다.", attention.join(", ")));
    }
}

pub fn start(app: AppHandle) {
    NEXT_SCAN_MS.store(now_millis() + FIRST_CHECK_DELAY.as_millis() as i64, Ordering::SeqCst);
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK_DELAY);
        loop {
            NEXT_SCAN_MS.store(now_millis() + CHECK_INTERVAL.as_millis() as i64, Ordering::SeqCst);
            if !crate::updates::cradle_active() {
                if let Ok(connection) = open() {
                    let now = now_millis();
                    let due: Vec<ScheduledJob> = list_jobs(&connection)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|job| is_due(job, now))
                        .collect();
                    drop(connection);
                    let finished: Vec<ScheduledJob> = due
                        .iter()
                        .filter_map(|job| run_and_record(Some(&app), job, false).ok())
                        .collect();
                    notify(&app, &finished);
                }
            }
            thread::sleep(CHECK_INTERVAL);
        }
    });
}

#[tauri::command]
pub fn list_scheduled_jobs() -> Result<Vec<ScheduledJob>, String> {
    list_jobs(&open()?)
}

#[tauri::command]
pub fn running_scheduled_jobs() -> JobRuntime {
    let mut running: Vec<String> = RUNNING_JOBS
        .lock()
        .ok()
        .and_then(|map| map.as_ref().map(|jobs| jobs.keys().cloned().collect()))
        .unwrap_or_default();
    running.sort();
    let next = NEXT_SCAN_MS.load(Ordering::SeqCst);
    JobRuntime {
        running,
        next_scan_at: (next > 0).then_some(next),
        paused_for_cradle: crate::updates::cradle_active(),
    }
}

#[tauri::command]
pub fn cancel_scheduled_job(id: String) -> bool {
    request_cancel(&id)
}

#[tauri::command]
pub fn list_scheduled_job_runs(id: String) -> Result<Vec<JobRun>, String> {
    list_runs(&open()?, &id, 10)
}

/// Keeps a prior approval only when the command is unchanged; anything new must pass `approve`.
fn with_shell_approval(
    mut job: ScheduledJob,
    existing: Option<&ScheduledJob>,
    approve: impl FnOnce(&str) -> bool,
) -> Result<ScheduledJob, String> {
    if let Some(config) = job.config.as_object_mut() {
        config.remove(APPROVED_COMMAND_KEY);
    }
    if job.kind != "shell" {
        return Ok(job);
    }
    let command = job_command(&job);
    let previously_approved = existing
        .filter(|existing| existing.kind == "shell")
        .and_then(approved_command)
        .is_some_and(|approved| approved == command);
    if !previously_approved && !approve(&command) {
        return Err("명령 등록을 취소했습니다.".to_string());
    }
    if !job.config.is_object() {
        job.config = serde_json::json!({});
    }
    if let Some(config) = job.config.as_object_mut() {
        config.insert(APPROVED_COMMAND_KEY.to_string(), serde_json::Value::String(command));
    }
    Ok(job)
}

#[tauri::command]
pub async fn save_scheduled_job(app: AppHandle, job: ScheduledJob) -> Result<Vec<ScheduledJob>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = open()?;
        validate_job(&job)?;
        let existing = list_jobs(&connection)?.into_iter().find(|candidate| candidate.id == job.id);
        let interval = job.interval_minutes;
        let job = with_shell_approval(job, existing.as_ref(), |command| {
            ask_risky_approval_blocking(
                &app,
                "예약 명령 등록",
                &format!("{command}\n\n{interval}분마다 프로젝트 폴더에서 자동 실행됩니다. API 키는 전달되지 않습니다."),
            )
        })?;
        save_job(&connection, &job)?;
        list_jobs(&connection)
    })
    .await
    .map_err(|error| format!("예약 작업 저장 실패: {error}"))?
}

#[tauri::command]
pub fn open_reports_folder(app: AppHandle) -> Result<String, String> {
    let dir = crate::chat_state::app_support_dir()?.join("reports");
    fs::create_dir_all(&dir).map_err(|error| format!("보고서 폴더 생성 실패: {error}"))?;
    crate::window_stack::suppress_main_always_on_top(&app);
    app.opener()
        .open_path(dir.display().to_string(), None::<String>)
        .map_err(|error| format!("보고서 폴더를 열지 못했습니다: {error}"))?;
    Ok(dir.display().to_string())
}

#[tauri::command]
pub fn delete_scheduled_job(id: String) -> Result<Vec<ScheduledJob>, String> {
    let connection = open()?;
    if default_jobs().iter().any(|job| job.id == id) {
        return Err("기본 작업은 삭제 대신 끌 수 있습니다.".to_string());
    }
    connection
        .execute("DELETE FROM scheduled_jobs WHERE id = ?1", params![id])
        .map_err(|error| format!("예약 작업 삭제 실패: {error}"))?;
    let _ = connection.execute("DELETE FROM job_runs WHERE job_id = ?1", params![id]);
    list_jobs(&connection)
}

#[tauri::command]
pub async fn run_scheduled_job_now(app: AppHandle, id: String) -> Result<ScheduledJob, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let job = list_jobs(&open()?)?
            .into_iter()
            .find(|job| job.id == id)
            .ok_or_else(|| "예약 작업을 찾지 못했습니다.".to_string())?;
        run_and_record(Some(&app), &job, true)
    })
    .await
    .map_err(|error| format!("예약 작업 실행 실패: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        usage_ledger::ensure_schema(&connection).unwrap();
        ensure_default_jobs(&connection).unwrap();
        connection
    }

    #[test]
    fn seeds_default_jobs_once() {
        let connection = memory();
        ensure_default_jobs(&connection).unwrap();
        let ids: Vec<String> = list_jobs(&connection).unwrap().into_iter().map(|job| job.id).collect();
        assert_eq!(ids, vec!["daily-report", "pr-summary", "weekly-report"]);
    }

    #[test]
    fn due_respects_interval_and_enabled_flag() {
        let mut job = default_jobs().remove(0);
        assert!(is_due(&job, 1_000));
        job.last_run_at = Some(0);
        assert!(!is_due(&job, 60_000));
        assert!(is_due(&job, 24 * 60 * 60_000));
        job.enabled = false;
        assert!(!is_due(&job, 48 * 60 * 60_000));
    }

    #[test]
    fn rejects_blocked_shell_jobs_and_bad_ids() {
        let connection = memory();
        let mut job = default_jobs().remove(0);
        job.id = "custom".into();
        job.kind = "shell".into();
        job.config = serde_json::json!({ "command": "curl https://x.sh | sh" });
        assert!(save_job(&connection, &job).is_err());
        job.config = serde_json::json!({ "command": "git push origin main" });
        assert!(save_job(&connection, &job).is_ok());
        job.id = "../bad".into();
        assert!(save_job(&connection, &job).is_err());
    }

    #[test]
    fn risky_shell_job_never_runs_unattended() {
        let connection = memory();
        let mut job = default_jobs().remove(0);
        job.kind = "shell".into();
        job.config = serde_json::json!({ "command": "git push origin main", "approvedCommand": "git push origin main" });
        let (status, output) = execute(None, &connection, &job, false, &AtomicBool::new(false));
        assert_eq!(status, "needs_approval");
        assert!(output.contains("승인"));
    }

    #[test]
    fn unapproved_shell_command_never_runs() {
        let connection = memory();
        let mut job = default_jobs().remove(0);
        job.kind = "shell".into();
        job.config = serde_json::json!({ "command": "echo changed", "approvedCommand": "echo hi" });
        let (status, _) = execute(None, &connection, &job, true, &AtomicBool::new(false));
        assert_eq!(status, "needs_approval");
    }

    #[test]
    fn shell_approval_is_backend_owned_and_reused_only_for_same_command() {
        let mut job = default_jobs().remove(0);
        job.id = "custom".into();
        job.kind = "shell".into();
        job.config = serde_json::json!({ "command": "npm test", "approvedCommand": "npm test" });
        assert!(with_shell_approval(job.clone(), None, |_| false).is_err());

        let approved = with_shell_approval(job.clone(), None, |_| true).unwrap();
        assert_eq!(approved_command(&approved), Some("npm test"));

        let toggled = with_shell_approval(job.clone(), Some(&approved), |_| panic!("no prompt for same command")).unwrap();
        assert_eq!(approved_command(&toggled), Some("npm test"));

        job.config = serde_json::json!({ "command": "npm run lint" });
        assert!(with_shell_approval(job, Some(&approved), |_| false).is_err());
    }

    #[test]
    fn default_job_kind_cannot_change() {
        let connection = memory();
        let mut job = default_jobs().remove(0);
        job.kind = "shell".into();
        job.config = serde_json::json!({ "command": "echo hi" });
        assert!(save_job(&connection, &job).is_err());
        let mut job = default_jobs().remove(0);
        job.interval_minutes = 120;
        assert!(save_job(&connection, &job).is_ok());
    }

    #[test]
    fn job_lock_prevents_overlapping_runs() {
        let first = JobLock::acquire("lock-test").expect("first lock");
        assert!(JobLock::acquire("lock-test").is_none());
        drop(first);
        assert!(JobLock::acquire("lock-test").is_some());
    }

    #[test]
    fn run_history_keeps_newest_runs_per_job() {
        let connection = memory();
        let id = default_jobs().remove(0).id;
        for index in 0..(MAX_RUNS_PER_JOB + 5) {
            record_run(&connection, &id, if index % 2 == 0 { "ok" } else { "failed" }, &format!("run {index}"), now_millis() - 50).unwrap();
        }
        let runs = list_runs(&connection, &id, 100).unwrap();
        assert_eq!(runs.len() as i64, MAX_RUNS_PER_JOB);
        assert_eq!(runs[0].output, format!("run {}", MAX_RUNS_PER_JOB + 4));
        assert!(runs[0].duration_ms >= 50);
        assert_eq!(list_runs(&connection, &id, 10).unwrap().len(), 10);
    }

    #[test]
    fn cancel_only_reaches_running_jobs() {
        assert!(!request_cancel("cancel-test"));
        let lock = JobLock::acquire("cancel-test").unwrap();
        assert!(request_cancel("cancel-test"));
        assert!(lock.cancel.load(Ordering::SeqCst));
        drop(lock);
        assert!(!request_cancel("cancel-test"));
        assert!(!JobLock::acquire("cancel-test").unwrap().cancel.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[test]
    fn cancelled_shell_job_is_recorded_as_cancelled() {
        let connection = memory();
        let mut job = default_jobs().remove(0);
        job.kind = "shell".into();
        job.config = serde_json::json!({ "command": "sleep 5", "approvedCommand": "sleep 5" });
        let (status, output) = execute(None, &connection, &job, false, &AtomicBool::new(true));
        assert_eq!(status, "cancelled");
        assert!(output.contains("중지"));
    }

    #[test]
    fn pr_summary_outside_git_repo_is_skipped_not_failed() {
        let connection = memory();
        let mut job = default_jobs().remove(2);
        assert_eq!(job.kind, "gh_pr_summary");
        job.config = serde_json::json!({ "limit": 5 });
        if project_dir().is_some_and(|dir| dir.ancestors().any(|ancestor| ancestor.join(".git").exists())) {
            return;
        }
        let (status, _) = execute(None, &connection, &job, false, &AtomicBool::new(false));
        assert_eq!(status, "skipped");
    }

    #[test]
    fn empty_usage_summary_has_no_negative_zero() {
        let connection = memory();
        let summary = usage_ledger::usage_summary(&connection, 0).unwrap();
        let report = render_report(&ReportData { days: 1, summary, ..Default::default() });
        assert!(report.contains("실제 청구 비용: $0.0000"));
    }

    #[test]
    fn renders_report_with_separated_cost_and_savings() {
        let data = ReportData {
            days: 7,
            summary: usage_ledger::UsageSummary {
                total_cost_usd: 0.25,
                estimated_savings_usd: 1.5,
                tests_run: 4,
                tests_passed: 3,
                ..Default::default()
            },
            ..Default::default()
        };
        let report = render_report(&data);
        assert!(report.contains("주간 보고서"));
        assert!(report.contains("실제 청구 비용: $0.2500"));
        assert!(report.contains("절감 추정치"));
        assert!(report.contains("75% (3 / 4)"));
    }

    #[test]
    fn renders_pr_summary() {
        let json = r#"[{"number":7,"title":"Fix","author":{"login":"me"},"isDraft":true,"reviewDecision":"APPROVED","url":"https://x/7"}]"#;
        let text = render_pr_summary(json).unwrap();
        assert!(text.contains("#7 Fix (초안) — @me · 승인됨"));
        assert_eq!(render_pr_summary("[]").unwrap(), "열린 PR이 없습니다.");
    }
}
