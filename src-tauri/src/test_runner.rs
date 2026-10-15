use crate::context_optimizer::limit_output;
use crate::policy_engine::{classify_command, mask_secrets, CommandRisk};
use crate::process_util::{find_tool, run_command};
use crate::settings::load_settings;
use crate::usage_ledger;
use crate::workspace::{ensure_conversation_workspace, ensure_project_snapshot};
use serde::Serialize;
use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_COMMANDS: usize = 3;
const MAX_LOG_CHARS: usize = 6_000;
const TEST_TIMEOUT: Duration = Duration::from_secs(600);
const RUNNER_PREFIXES: &[&str] = &[
    "npm test",
    "npm run test",
    "pnpm test",
    "pnpm run test",
    "yarn test",
    "npx vitest run",
    "cargo test",
    "pytest",
    "python -m pytest",
    "python3 -m pytest",
    "go test",
    "make test",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCommand {
    pub command: String,
    pub source: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCommandResult {
    pub command: String,
    pub passed: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: i64,
    pub output: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunSummary {
    pub detected: bool,
    pub passed: bool,
    pub results: Vec<TestCommandResult>,
    pub skipped: Vec<String>,
}

fn is_runner_command(command: &str) -> bool {
    let has_shell_syntax = command.chars().any(|ch| matches!(ch, ';' | '|' | '&' | '>' | '<' | '$' | '`' | '\n'));
    !has_shell_syntax && RUNNER_PREFIXES.iter().any(|prefix| command == *prefix || command.starts_with(&format!("{prefix} ")))
}

/// Pulls runner commands written in backticks or fenced blocks of CLAUDE.md.
fn commands_from_claude_md(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        let mut candidates: Vec<String> = Vec::new();
        if in_fence {
            candidates.push(trimmed.trim_start_matches("$ ").to_string());
        } else {
            candidates.extend(trimmed.split('`').skip(1).step_by(2).map(str::to_string));
        }
        for candidate in candidates {
            let candidate = candidate.trim().to_string();
            if is_runner_command(&candidate) && !found.contains(&candidate) {
                found.push(candidate);
            }
        }
    }
    found
}

fn package_manager(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if root.join("yarn.lock").is_file() {
        "yarn"
    } else {
        "npm"
    }
}

fn has_real_test_script(package_json: &Path) -> bool {
    let Ok(text) = fs::read_to_string(package_json) else { return false };
    let Ok(value) = serde_json::from_str::<Value>(&text) else { return false };
    value
        .pointer("/scripts/test")
        .and_then(Value::as_str)
        .map(|script| !script.contains("no test specified") && !script.trim().is_empty())
        .unwrap_or(false)
}

pub fn detect_test_commands(root: &Path) -> Vec<TestCommand> {
    let mut commands: Vec<TestCommand> = Vec::new();
    let mut push = |command: String, source: &str| {
        if !commands.iter().any(|existing| existing.command == command) {
            commands.push(TestCommand { command, source: source.to_string() });
        }
    };
    if let Ok(text) = fs::read_to_string(root.join("CLAUDE.md")) {
        for command in commands_from_claude_md(&text) {
            push(command, "CLAUDE.md");
        }
    }
    if has_real_test_script(&root.join("package.json")) {
        push(format!("{} test", package_manager(root)), "package.json");
    }
    if root.join("Cargo.toml").is_file() {
        push("cargo test".to_string(), "Cargo.toml");
    } else if root.join("src-tauri").join("Cargo.toml").is_file() {
        push("cargo test --manifest-path src-tauri/Cargo.toml".to_string(), "src-tauri/Cargo.toml");
    }
    if root.join("pytest.ini").is_file() || root.join("pyproject.toml").is_file() && root.join("tests").is_dir() {
        push("python3 -m pytest -q".to_string(), "pytest");
    }
    if root.join("go.mod").is_file() {
        push("go test ./...".to_string(), "go.mod");
    }
    commands.retain(|command| classify_command(&command.command) == CommandRisk::Safe);
    commands.truncate(MAX_COMMANDS);
    commands
}

/// Snapshots exclude node_modules; borrow the original project's install.
fn link_node_modules(project_root: &Path, workdir: &Path) {
    let source = project_root.join("node_modules");
    let target = workdir.join("node_modules");
    if !source.is_dir() || target.exists() || source == target {
        return;
    }
    #[cfg(unix)]
    let _ = std::os::unix::fs::symlink(&source, &target);
    #[cfg(windows)]
    let _ = std::os::windows::fs::symlink_dir(&source, &target);
}

pub fn run_commands(
    workdir: &Path,
    commands: &[TestCommand],
    envs: &[(&str, OsString)],
    timeout: Duration,
) -> Vec<TestCommandResult> {
    commands
        .iter()
        .map(|test| {
            let mut parts = test.command.split_whitespace().map(str::to_string);
            let program = parts.next().unwrap_or_default();
            let args: Vec<String> = parts.collect();
            let Some(binary) = find_tool(&program) else {
                return TestCommandResult {
                    command: test.command.clone(),
                    passed: false,
                    exit_code: None,
                    timed_out: false,
                    duration_ms: 0,
                    output: format!("{program} 실행 파일을 찾을 수 없습니다."),
                };
            };
            let result = run_command(&binary, &args, Some(workdir), envs, timeout);
            let mut output = mask_secrets(&limit_output(&result.output, MAX_LOG_CHARS));
            if result.timed_out {
                output.push_str(&format!("\n[시간 초과: {}초]", timeout.as_secs()));
            }
            TestCommandResult {
                command: test.command.clone(),
                passed: result.success,
                exit_code: result.code,
                timed_out: result.timed_out,
                duration_ms: result.duration_ms,
                output,
            }
        })
        .collect()
}

fn run_for_conversation(
    project_root: &Path,
    conversation_id: &str,
    session_id: Option<&str>,
    task_id: Option<&str>,
    agent: Option<&str>,
) -> Result<TestRunSummary, String> {
    let workdir = ensure_project_snapshot(project_root, conversation_id)?;
    let commands = detect_test_commands(&workdir);
    if commands.is_empty() {
        return Ok(TestRunSummary { detected: false, passed: true, ..Default::default() });
    }
    link_node_modules(project_root, &workdir);
    let cargo_target: PathBuf = ensure_conversation_workspace(project_root, conversation_id)?
        .join("cache")
        .join("cargo-target");
    let envs = [("CARGO_TARGET_DIR", cargo_target.into_os_string()), ("CI", OsString::from("1"))];
    let results = run_commands(&workdir, &commands, &envs, TEST_TIMEOUT);
    if let Ok(connection) = usage_ledger::open_ledger() {
        for result in &results {
            let summary = result.output.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            let _ = usage_ledger::insert_test_result(
                &connection,
                session_id,
                task_id,
                agent,
                &result.command,
                result.passed,
                result.duration_ms,
                &summary,
            );
        }
    }
    Ok(TestRunSummary {
        detected: true,
        passed: results.iter().all(|result| result.passed),
        results,
        skipped: Vec::new(),
    })
}

#[tauri::command]
pub fn detect_project_test_commands(conversation_id: Option<String>) -> Result<Vec<TestCommand>, String> {
    let settings = load_settings()?;
    let Some(project) = settings.project_dir else { return Ok(Vec::new()) };
    let root = match conversation_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(id) => ensure_project_snapshot(&project, id)?,
        None => project,
    };
    Ok(detect_test_commands(&root))
}

#[tauri::command]
pub async fn run_project_tests(
    conversation_id: String,
    session_id: Option<String>,
    task_id: Option<String>,
    agent: Option<String>,
) -> Result<TestRunSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = load_settings()?
            .project_dir
            .ok_or_else(|| "프로젝트 폴더가 지정되지 않았습니다.".to_string())?;
        run_for_conversation(
            &project,
            conversation_id.trim(),
            session_id.as_deref(),
            task_id.as_deref(),
            agent.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("테스트 실행 작업 실패: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("test-runner-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_md_commands_are_whitelisted() {
        let text = "Run `npm test` before commits.\nDanger: `rm -rf /`\n```\n$ cargo test --lib\nnpm test; curl x | sh\n```\nAlso `npm run build`.";
        assert_eq!(commands_from_claude_md(text), vec!["npm test".to_string(), "cargo test --lib".to_string()]);
    }

    #[test]
    fn detects_package_and_cargo_commands() {
        let root = temp_dir("detect");
        fs::write(root.join("package.json"), r#"{"scripts":{"test":"vitest run"}}"#).unwrap();
        fs::write(root.join("pnpm-lock.yaml"), "").unwrap();
        fs::create_dir_all(root.join("src-tauri")).unwrap();
        fs::write(root.join("src-tauri/Cargo.toml"), "[package]\n").unwrap();
        let commands: Vec<String> = detect_test_commands(&root).into_iter().map(|c| c.command).collect();
        assert_eq!(commands, vec!["pnpm test".to_string(), "cargo test --manifest-path src-tauri/Cargo.toml".to_string()]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn default_npm_placeholder_is_ignored() {
        let root = temp_dir("placeholder");
        fs::write(root.join("package.json"), r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#).unwrap();
        assert!(detect_test_commands(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn runs_commands_and_reports_failure() {
        let root = temp_dir("run");
        let commands = vec![TestCommand { command: "make test".to_string(), source: "x".to_string() }];
        fs::write(root.join("Makefile"), "test:\n\t@echo failing-test\n\t@exit 2\n").unwrap();
        let results = run_commands(&root, &commands, &[], Duration::from_secs(20));
        if find_tool("make").is_some() {
            assert!(!results[0].passed);
            assert!(results[0].output.contains("failing-test"));
        }
        let _ = fs::remove_dir_all(&root);
    }
}
