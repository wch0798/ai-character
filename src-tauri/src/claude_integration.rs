use crate::policy_engine::{classify_command, mask_secrets, CommandRisk};
use crate::process_util::{find_tool, run_command};
use crate::settings::{load_settings, save_settings, AppSettings};
use crate::test_runner::{detect_test_commands, run_commands, TestCommand};
use crate::usage_ledger::{self, UsageEntry};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MANAGED_MARKER: &str = "<!-- ai-character:managed -->";
const PLUGIN_NAME: &str = "ai-character-cradle";
const LINT_TIMEOUT: Duration = Duration::from_secs(180);
const STOP_TEST_TIMEOUT: Duration = Duration::from_secs(600);
const LINT_DEBOUNCE_SECS: u64 = 45;
const HOOK_LOG_CHARS: usize = 4_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeIntegrationSettings {
    pub claude_md: bool,
    pub skills: bool,
    pub subagents: bool,
    pub hooks: bool,
    pub mcp: bool,
    pub mcp_playwright: bool,
    pub mcp_github: bool,
    pub json_output: bool,
}

pub fn integration_settings(settings: &AppSettings) -> ClaudeIntegrationSettings {
    ClaudeIntegrationSettings {
        claude_md: settings.extra_bool("claude.claude_md", true),
        skills: settings.extra_bool("claude.skills", true),
        subagents: settings.extra_bool("claude.subagents", true),
        hooks: settings.extra_bool("claude.hooks", true),
        mcp: settings.extra_bool("claude.mcp", true),
        mcp_playwright: settings.extra_bool("claude.mcp_playwright", true),
        mcp_github: settings.extra_bool("claude.mcp_github", true),
        json_output: settings.extra_bool("claude.json_output", true),
    }
}

fn apply_integration_settings(settings: &mut AppSettings, value: &ClaudeIntegrationSettings) {
    for (key, enabled) in [
        ("claude.claude_md", value.claude_md),
        ("claude.skills", value.skills),
        ("claude.subagents", value.subagents),
        ("claude.hooks", value.hooks),
        ("claude.mcp", value.mcp),
        ("claude.mcp_playwright", value.mcp_playwright),
        ("claude.mcp_github", value.mcp_github),
        ("claude.json_output", value.json_output),
    ] {
        settings.set_extra(key, Some(enabled.to_string()));
    }
}

/// `<project>/.ai-character/conversations/<id>` for a snapshot or Coder worktree.
pub fn conversation_dir_for(working_dir: &Path) -> Option<PathBuf> {
    let mut current = working_dir;
    while let Some(parent) = current.parent() {
        if parent.file_name().and_then(|name| name.to_str()) == Some("conversations")
            && parent.parent().and_then(|p| p.file_name()).and_then(|name| name.to_str()) == Some(".ai-character")
        {
            return Some(current.to_path_buf());
        }
        current = parent;
    }
    None
}

fn project_root_for(conversation_dir: &Path) -> Option<PathBuf> {
    conversation_dir.parent()?.parent()?.parent().map(Path::to_path_buf)
}

fn write_if_changed(path: &Path, contents: &str) -> Result<(), String> {
    if fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("폴더 생성 실패: {} ({error})", parent.display()))?;
    }
    fs::write(path, contents).map_err(|error| format!("파일 기록 실패: {} ({error})", path.display()))
}

fn remove_dir(path: &Path) {
    if path.exists() {
        let _ = fs::remove_dir_all(path);
    }
}

pub fn claude_md_contents(tests: &[TestCommand]) -> String {
    let test_lines = if tests.is_empty() {
        "- 자동으로 찾은 테스트 명령이 없습니다. 바꾼 부분은 직접 실행해 확인하세요.".to_string()
    } else {
        tests.iter().map(|test| format!("- `{}` ({})", test.command, test.source)).collect::<Vec<_>>().join("\n")
    };
    format!(
        "{MANAGED_MARKER}\n# AI-Character CRADLE 작업 규칙\n\n\
이 폴더는 AI-Character가 관리하는 대화 작업공간입니다. 원본 프로젝트에는 사용자가 검토한 뒤에만 반영됩니다.\n\n\
## 규칙\n\
- 요청받은 작업만 하고, 바꾼 내용은 최소한으로 유지합니다.\n\
- 비밀키, 토큰, `.env`, `keys.env`는 읽거나 출력하거나 파일에 적지 않습니다.\n\
- push, 배포, 대량 삭제, `git reset --hard` 같은 위험한 명령은 실행하지 않습니다. 필요하면 사용자에게 요청합니다.\n\
- 결과는 짧은 요약과 바꾼 파일 목록으로 보고합니다.\n\n\
## 테스트 명령\n{test_lines}\n\n\
## 하위 에이전트\n\
- `reviewer`: 바꾼 코드의 정확성·보안 검토\n\
- `tester`: 테스트 실행과 실패 원인 분석\n\
- `documenter`: 변경 보고서 작성\n"
    )
}

fn skill(name: &str, description: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}\n")
}

fn skills() -> Vec<(&'static str, String)> {
    vec![
        (
            "review",
            skill(
                "review",
                "바꾼 코드를 정확성, 회귀, 보안 관점에서 검토할 때 사용합니다.",
                "1. `git diff`로 바뀐 부분만 확인합니다.\n2. 버그, 경계 조건, 보안 문제(비밀키 노출, 위험한 명령)를 찾습니다.\n3. 파일:줄 단위로 구체적인 문제와 고치는 방법을 짧게 적습니다.\n4. 문제가 없으면 없다고만 말합니다.",
            ),
        ),
        (
            "test",
            skill(
                "test",
                "프로젝트 테스트를 실행하고 실패 원인을 찾을 때 사용합니다.",
                "1. CLAUDE.md의 테스트 명령을 실행합니다.\n2. 실패하면 로그에서 첫 번째 실제 오류를 찾습니다.\n3. 가장 작은 수정을 제안하거나 적용한 뒤 다시 실행합니다.\n4. 통과/실패 개수와 남은 문제를 보고합니다.",
            ),
        ),
        (
            "report",
            skill(
                "report",
                "작업이 끝난 뒤 변경 보고서를 만들 때 사용합니다.",
                "다음 형식으로 짧게 씁니다.\n- 무엇을 바꿨는지 (파일 목록)\n- 왜 바꿨는지\n- 테스트 결과\n- 사용자가 확인해야 할 점",
            ),
        ),
    ]
}

fn agent(name: &str, description: &str, tools: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\ntools: {tools}\n---\n\n{body}\n")
}

fn subagents() -> Vec<(&'static str, String)> {
    vec![
        (
            "reviewer",
            agent(
                "reviewer",
                "코드 변경을 검토합니다. 구현이 끝난 뒤 정확성과 보안을 확인할 때 사용합니다.",
                "Read, Grep, Glob, Bash",
                "당신은 꼼꼼한 코드 리뷰어입니다. 바뀐 부분만 읽고 버그, 회귀, 보안 문제를 파일:줄과 함께 보고합니다. 파일은 수정하지 않습니다.",
            ),
        ),
        (
            "tester",
            agent(
                "tester",
                "테스트를 실행하고 실패를 분석합니다. 코드를 바꾼 뒤 확인할 때 사용합니다.",
                "Read, Grep, Glob, Bash, Edit",
                "당신은 테스트 담당입니다. CLAUDE.md의 테스트 명령을 실행하고, 실패하면 원인을 찾아 가장 작은 수정을 합니다. 결과는 통과/실패 요약으로 보고합니다.",
            ),
        ),
        (
            "documenter",
            agent(
                "documenter",
                "변경 보고서와 문서를 씁니다. 작업이 끝난 뒤 정리할 때 사용합니다.",
                "Read, Grep, Glob",
                "당신은 문서 담당입니다. 바뀐 내용, 이유, 테스트 결과, 사용자가 확인할 점을 짧고 정확하게 정리합니다.",
            ),
        ),
    ]
}

fn hook_command(kind: &str) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(format!("\"{}\" --cradle-hook {kind}", exe.to_string_lossy()))
}

/// The workspace guard (PreToolUse) is always on; `quality` adds the lint and test hooks the
/// user can switch off in settings.
pub fn hooks_json(quality: bool) -> Option<Value> {
    let mut hooks = json!({
        "PreToolUse": [{
            "matcher": GUARDED_TOOLS,
            "hooks": [{ "type": "command", "command": hook_command("pre-tool")?, "timeout": 10 }]
        }]
    });
    if quality {
        hooks["PostToolUse"] = json!([{
            "matcher": "Edit|Write|MultiEdit",
            "hooks": [{ "type": "command", "command": hook_command("post-edit")?, "timeout": LINT_TIMEOUT.as_secs() + 20 }]
        }]);
        hooks["Stop"] = json!([{
            "hooks": [{ "type": "command", "command": hook_command("stop")?, "timeout": STOP_TEST_TIMEOUT.as_secs() + 30 }]
        }]);
    }
    Some(json!({ "hooks": hooks }))
}

/// Every Claude tool that touches files or runs commands, and every MCP tool (Playwright can
/// open file:// pages and upload files; GitHub can write to the repository).
const GUARDED_TOOLS: &str = "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead|Glob|Grep|LS|mcp__.*";

/// GitHub's token is referenced as `${GITHUB_TOKEN}` and expanded by Claude at
/// runtime, so it never lands in the file.
pub fn mcp_config(settings: &ClaudeIntegrationSettings, npx: Option<&Path>, github_token_present: bool) -> Option<Value> {
    let mut servers = serde_json::Map::new();
    if settings.mcp_playwright {
        if let Some(npx) = npx {
            servers.insert(
                "playwright".to_string(),
                json!({ "command": npx.to_string_lossy(), "args": ["-y", "@playwright/mcp@latest"] }),
            );
        }
    }
    if settings.mcp_github && github_token_present {
        servers.insert(
            "github".to_string(),
            json!({
                "type": "http",
                "url": "https://api.githubcopilot.com/mcp/",
                "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
            }),
        );
    }
    (!servers.is_empty()).then(|| json!({ "mcpServers": servers }))
}

/// Whether Claude runs get the GitHub connection, the only reason it may see GITHUB_TOKEN.
pub fn github_mcp_enabled() -> bool {
    load_settings()
        .map(|settings| integration_settings(&settings))
        .map(|settings| settings.mcp && settings.mcp_github)
        .unwrap_or(false)
}

fn github_token_present() -> bool {
    crate::process_util::secret_value("GITHUB_TOKEN").is_some()
}

/// Writes CLAUDE.md, the CRADLE plugin (skills, subagents, hooks) and MCP
/// config next to the managed workspace, never inside the project snapshot,
/// so none of it is offered for apply to the user's project.
pub fn prepare_claude_workspace(working_dir: &Path) -> Result<Vec<String>, String> {
    let Some(conversation_dir) = conversation_dir_for(working_dir) else { return Ok(Vec::new()) };
    let settings = integration_settings(&load_settings()?);
    let integration_dir = conversation_dir.join("claude-integration");
    let mut args = Vec::new();

    let claude_md = conversation_dir.join("CLAUDE.md");
    if settings.claude_md {
        write_if_changed(&claude_md, &claude_md_contents(&detect_test_commands(working_dir)))?;
    } else if fs::read_to_string(&claude_md).map(|text| text.contains(MANAGED_MARKER)).unwrap_or(false) {
        let _ = fs::remove_file(&claude_md);
    }

    // Claude runs here with `--setting-sources user` (no project hooks), which also stops it
    // from reading CLAUDE.md files, so they are handed over directly: the app's guide, then
    // the project's own.
    let mut instructions = Vec::new();
    for path in [claude_md.clone(), working_dir.join("CLAUDE.md"), working_dir.join(".claude").join("CLAUDE.md")] {
        if let Ok(text) = fs::read_to_string(&path) {
            if !text.trim().is_empty() {
                instructions.push(text);
            }
        }
    }
    let instructions_path = integration_dir.join("instructions.md");
    if instructions.is_empty() {
        let _ = fs::remove_file(&instructions_path);
    } else {
        write_if_changed(&instructions_path, &instructions.join("\n\n---\n\n"))?;
        args.push("--append-system-prompt-file".to_string());
        args.push(instructions_path.to_string_lossy().into_owned());
    }

    let plugin = integration_dir.join("plugin");
    write_if_changed(
        &plugin.join(".claude-plugin").join("plugin.json"),
        &serde_json::to_string_pretty(&json!({
            "name": PLUGIN_NAME,
            "version": env!("CARGO_PKG_VERSION"),
            "description": "AI-Character CRADLE skills, subagents and safety hooks"
        }))
        .unwrap_or_default(),
    )?;
    if settings.skills {
        for (name, body) in skills() {
            write_if_changed(&plugin.join("skills").join(name).join("SKILL.md"), &body)?;
        }
    } else {
        remove_dir(&plugin.join("skills"));
    }
    if settings.subagents {
        for (name, body) in subagents() {
            write_if_changed(&plugin.join("agents").join(format!("{name}.md")), &body)?;
        }
    } else {
        remove_dir(&plugin.join("agents"));
    }
    // Written even with quality hooks off: it carries the workspace guard.
    match hooks_json(settings.hooks) {
        Some(hooks) => {
            write_if_changed(&plugin.join("hooks").join("hooks.json"), &serde_json::to_string_pretty(&hooks).unwrap_or_default())?
        }
        None => return Err("작업 폴더 보호 설정을 만들지 못해 Claude 실행을 멈췄습니다.".to_string()),
    }
    args.push("--plugin-dir".to_string());
    args.push(plugin.to_string_lossy().into_owned());

    let mcp_path = integration_dir.join("mcp.json");
    match settings.mcp.then(|| mcp_config(&settings, find_tool("npx").as_deref(), github_token_present())).flatten() {
        Some(config) => {
            write_if_changed(&mcp_path, &serde_json::to_string_pretty(&config).unwrap_or_default())?;
            args.push("--mcp-config".to_string());
            args.push(mcp_path.to_string_lossy().into_owned());
        }
        None => {
            let _ = fs::remove_file(&mcp_path);
        }
    }

    if settings.json_output {
        args.push("--output-format".to_string());
        args.push("json".to_string());
    }
    Ok(args)
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeJsonResult {
    pub text: String,
    pub is_error: bool,
    pub total_cost_usd: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub model: String,
    pub duration_ms: i64,
}

pub fn parse_claude_json(raw: &str) -> Option<ClaudeJsonResult> {
    let value: Value = serde_json::from_str(raw.trim()).ok()?;
    let value = match value {
        Value::Array(items) => items.into_iter().rev().find(|item| item.get("type").and_then(Value::as_str) == Some("result"))?,
        other => other,
    };
    if value.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    let usage = value.get("usage").cloned().unwrap_or(Value::Null);
    let int = |key: &str| usage.get(key).and_then(Value::as_i64).unwrap_or(0);
    let model = value
        .get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|models| models.keys().next().cloned())
        .unwrap_or_else(|| "claude".to_string());
    Some(ClaudeJsonResult {
        text: value.get("result").and_then(Value::as_str).unwrap_or_default().to_string(),
        is_error: value.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        total_cost_usd: value.get("total_cost_usd").and_then(Value::as_f64).unwrap_or(0.0),
        input_tokens: int("input_tokens") + int("cache_creation_input_tokens"),
        output_tokens: int("output_tokens"),
        cached_tokens: int("cache_read_input_tokens"),
        model,
        duration_ms: value.get("duration_ms").and_then(Value::as_i64).unwrap_or(0),
    })
}

/// Subscription runs are recorded with zero billed cost; the CLI's own cost
/// figure is kept only as a reference estimate.
pub fn record_claude_usage(result: &ClaudeJsonResult, session_id: Option<&str>, task_id: Option<&str>) {
    usage_ledger::record_usage(&UsageEntry {
        session_id: session_id.map(str::to_string),
        task_id: task_id.map(str::to_string),
        role: Some("claude_cli".to_string()),
        provider: "claude_cli".to_string(),
        model: result.model.clone(),
        cost_class: "subscription".to_string(),
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        cached_tokens: result.cached_tokens,
        cost_usd: 0.0,
        estimated_paid_usd: result.total_cost_usd,
        latency_ms: result.duration_ms,
        retries: 0,
        cache_hit: false,
        status: if result.is_error { "error" } else { "ok" }.to_string(),
        error: result.is_error.then(|| mask_secrets(&result.text)),
    });
}

// ---- hook handlers (run as `ai-character --cradle-hook <kind>`) ----

fn read_hook_input() -> Value {
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    serde_json::from_str(&raw).unwrap_or(Value::Null)
}

fn hook_cwd(input: &Value) -> PathBuf {
    input
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDE_PROJECT_DIR").map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn state_file(cwd: &Path, name: &str) -> PathBuf {
    let digest = format!("{:x}", Sha256::digest(cwd.to_string_lossy().as_bytes()));
    std::env::temp_dir().join("ai-character-hooks").join(format!("{}-{name}", &digest[..16]))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn touch(path: &Path, value: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, value);
}

pub fn pre_bash_decision(command: &str) -> Result<(), String> {
    match classify_command(command) {
        CommandRisk::Safe => Ok(()),
        CommandRisk::Blocked => Err(format!("AI-Character 안전 규칙: 위험한 명령이라 차단했습니다: {command}")),
        CommandRisk::NeedsApproval => Err(format!(
            "AI-Character 안전 규칙: push·배포·삭제 같은 명령은 사용자 승인이 필요해 실행하지 않았습니다: {command}. 필요한 이유를 결과에 적어 사용자에게 요청하세요."
        )),
    }
}

/// The PreToolUse check: the command safety rules for Bash, and for every tool, nothing
/// outside the workspace copy (see workspace_guard).
fn pre_tool_decision(input: &Value) -> Result<(), String> {
    use crate::workspace_guard::{check_file_tool, check_mcp_tool, check_shell, WORKSPACE_ENV};
    let cwd = hook_cwd(input);
    let workspace = std::env::var_os(WORKSPACE_ENV).map(PathBuf::from).unwrap_or_else(|| cwd.clone());
    let temp = std::env::temp_dir();
    let home = crate::agent_core::user_home_dir();
    let tool = input.get("tool_name").and_then(Value::as_str).unwrap_or_default();
    let tool_input = input.get("tool_input").cloned().unwrap_or(Value::Null);
    let refusal = if tool == "Bash" {
        let command = tool_input.get("command").and_then(Value::as_str).unwrap_or_default();
        pre_bash_decision(command)?;
        // Commands may name tools in Program Files or Windows; those folders need admin to change.
        let system: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "SystemRoot"]
            .iter()
            .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
            .collect();
        check_shell(command, &cwd, &workspace, &temp, home.as_deref(), &system)
    } else if tool.starts_with("mcp__") {
        check_mcp_tool(tool, &tool_input, &cwd, &workspace, &temp, home.as_deref())
    } else {
        check_file_tool(tool, &tool_input, &cwd, &workspace, &temp, home.as_deref())
    };
    refusal.map_or(Ok(()), Err)
}

fn hook_envs(cwd: &Path) -> Vec<(&'static str, OsString)> {
    let mut envs = vec![("CI", OsString::from("1"))];
    if let Some(conversation) = conversation_dir_for(cwd) {
        envs.push(("CARGO_TARGET_DIR", conversation.join("cache").join("cargo-target").into_os_string()));
    }
    envs
}

/// Borrows the project's node_modules only while a hook check runs, so agent installs never reach it.
struct NodeModulesLink(Option<PathBuf>);

impl Drop for NodeModulesLink {
    fn drop(&mut self) {
        if let Some(target) = self.0.take() {
            if fs::symlink_metadata(&target).is_ok_and(|meta| meta.file_type().is_symlink()) {
                #[cfg(unix)]
                let _ = fs::remove_file(&target);
                #[cfg(windows)]
                let _ = fs::remove_dir(&target);
            }
        }
    }
}

fn link_project_node_modules(cwd: &Path) -> NodeModulesLink {
    let Some(project) = conversation_dir_for(cwd).and_then(|dir| project_root_for(&dir)) else {
        return NodeModulesLink(None);
    };
    let source = project.join("node_modules");
    let target = cwd.join("node_modules");
    if !source.is_dir() || fs::symlink_metadata(&target).is_ok() {
        return NodeModulesLink(None);
    }
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&source, &target).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(&source, &target).is_ok();
    NodeModulesLink(linked.then_some(target))
}

pub fn lint_command_for(cwd: &Path, file: &str) -> Option<TestCommand> {
    let ext = Path::new(file).extension()?.to_str()?.to_ascii_lowercase();
    let command = match ext.as_str() {
        "ts" | "tsx" | "mts" | "cts" if cwd.join("tsconfig.json").is_file() => "npx tsc --noEmit -p .".to_string(),
        "rs" if cwd.join("Cargo.toml").is_file() => "cargo check --quiet".to_string(),
        "rs" if cwd.join("src-tauri/Cargo.toml").is_file() => "cargo check --quiet --manifest-path src-tauri/Cargo.toml".to_string(),
        "py" => format!("python3 -m py_compile {file}"),
        _ => return None,
    };
    Some(TestCommand { command, source: format!("lint:{ext}") })
}

fn trimmed_failures(results: &[crate::test_runner::TestCommandResult]) -> String {
    let text = results
        .iter()
        .filter(|result| !result.passed)
        .map(|result| format!("$ {}\n{}", result.command, result.output))
        .collect::<Vec<_>>()
        .join("\n\n");
    crate::context_optimizer::limit_output(&text, HOOK_LOG_CHARS)
}

fn post_edit(input: &Value) -> i32 {
    let cwd = hook_cwd(input);
    touch(&state_file(&cwd, "edited"), "1");
    let Some(file) = input.pointer("/tool_input/file_path").and_then(Value::as_str) else { return 0 };
    let relative = Path::new(file).strip_prefix(&cwd).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| file.to_string());
    if relative.contains(char::is_whitespace) {
        return 0;
    }
    let Some(lint) = lint_command_for(&cwd, &relative) else { return 0 };
    let stamp = state_file(&cwd, &lint.source.replace(':', "-"));
    let last = fs::read_to_string(&stamp).ok().and_then(|text| text.trim().parse::<u64>().ok()).unwrap_or(0);
    if now_secs().saturating_sub(last) < LINT_DEBOUNCE_SECS {
        return 0;
    }
    touch(&stamp, &now_secs().to_string());
    let _link = link_project_node_modules(&cwd);
    let results = run_commands(&cwd, &[lint], &hook_envs(&cwd), LINT_TIMEOUT);
    if results.iter().all(|result| result.passed || result.timed_out) {
        return 0;
    }
    eprintln!("AI-Character 자동 검사에서 오류가 났습니다. 고친 뒤 계속하세요.\n{}", trimmed_failures(&results));
    2
}

fn stop(input: &Value) -> i32 {
    if input.get("stop_hook_active").and_then(Value::as_bool).unwrap_or(false) {
        return 0;
    }
    let cwd = hook_cwd(input);
    let edited = state_file(&cwd, "edited");
    if !edited.exists() {
        return 0;
    }
    let _ = fs::remove_file(&edited);
    let commands = detect_test_commands(&cwd);
    if commands.is_empty() {
        return 0;
    }
    let _link = link_project_node_modules(&cwd);
    let results = run_commands(&cwd, &commands, &hook_envs(&cwd), STOP_TEST_TIMEOUT);
    if let Ok(connection) = usage_ledger::open_ledger() {
        for result in &results {
            let _ = usage_ledger::insert_test_result(
                &connection,
                None,
                None,
                Some("claude_hook"),
                &result.command,
                result.passed,
                result.duration_ms,
                &crate::context_optimizer::limit_output(&result.output, 1_500),
            );
        }
    }
    if results.iter().all(|result| result.passed) {
        return 0;
    }
    eprintln!("AI-Character: 프로젝트 테스트가 실패했습니다. 원인을 고친 뒤 끝내세요.\n{}", trimmed_failures(&results));
    2
}

/// Entry point for hook subprocesses; returns the exit code when argv asks for a hook.
pub fn run_hook_from_args() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let index = args.iter().position(|arg| arg == "--cradle-hook")?;
    let kind = args.get(index + 1).cloned().unwrap_or_default();
    let input = read_hook_input();
    Some(match kind.as_str() {
        "pre-bash" => {
            let command = input.pointer("/tool_input/command").and_then(Value::as_str).unwrap_or_default();
            match pre_bash_decision(command) {
                Ok(()) => 0,
                Err(reason) => {
                    eprintln!("{reason}");
                    2
                }
            }
        }
        "pre-tool" => match pre_tool_decision(&input) {
            Ok(()) => 0,
            Err(reason) => {
                eprintln!("{reason}");
                2
            }
        },
        "post-edit" => post_edit(&input),
        "stop" => stop(&input),
        _ => 0,
    })
}

// ---- commands ----

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeIntegrationStatus {
    pub settings: ClaudeIntegrationSettings,
    pub playwright_available: bool,
    pub github_token_present: bool,
    pub mcp_list: String,
}

#[tauri::command]
pub fn get_claude_integration_settings() -> Result<ClaudeIntegrationSettings, String> {
    Ok(integration_settings(&load_settings()?))
}

#[tauri::command]
pub fn set_claude_integration_settings(value: ClaudeIntegrationSettings) -> Result<ClaudeIntegrationSettings, String> {
    let mut settings = load_settings()?;
    apply_integration_settings(&mut settings, &value);
    save_settings(&settings)?;
    Ok(integration_settings(&settings))
}

#[tauri::command]
pub async fn get_claude_integration_status() -> Result<ClaudeIntegrationStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let settings = integration_settings(&load_settings()?);
        let mcp_list = match find_tool("claude") {
            Some(claude) => {
                let result = run_command(&claude, &["mcp".into(), "list".into()], None, &[], Duration::from_secs(40));
                mask_secrets(&crate::context_optimizer::limit_output(result.output.trim(), 3_000))
            }
            None => "Claude CLI를 찾지 못했습니다.".to_string(),
        };
        Ok(ClaudeIntegrationStatus {
            settings,
            playwright_available: find_tool("npx").is_some(),
            github_token_present: github_token_present(),
            mcp_list,
        })
    })
    .await
    .map_err(|error| format!("Claude 통합 상태 확인 실패: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_on() -> ClaudeIntegrationSettings {
        ClaudeIntegrationSettings {
            claude_md: true,
            skills: true,
            subagents: true,
            hooks: true,
            mcp: true,
            mcp_playwright: true,
            mcp_github: true,
            json_output: true,
        }
    }

    #[test]
    fn finds_conversation_dir_for_snapshot_and_worktree() {
        let snapshot = Path::new("/p/.ai-character/conversations/c1/project");
        let worktree = Path::new("/p/.ai-character/conversations/c1/worktrees/t1");
        assert_eq!(conversation_dir_for(snapshot), Some(PathBuf::from("/p/.ai-character/conversations/c1")));
        assert_eq!(conversation_dir_for(worktree), Some(PathBuf::from("/p/.ai-character/conversations/c1")));
        assert_eq!(conversation_dir_for(Path::new("/p/src")), None);
        assert_eq!(project_root_for(Path::new("/p/.ai-character/conversations/c1")), Some(PathBuf::from("/p")));
    }

    #[test]
    fn mcp_config_never_contains_token_value() {
        let config = mcp_config(&all_on(), Some(Path::new("/usr/bin/npx")), true).unwrap();
        let text = config.to_string();
        assert!(text.contains("${GITHUB_TOKEN}"));
        assert!(text.contains("@playwright/mcp"));
        assert!(mcp_config(&all_on(), None, false).is_none());
    }

    #[test]
    fn hooks_cover_bash_guard_edit_lint_and_stop_tests() {
        let hooks = hooks_json(true).unwrap();
        let guarded = hooks.pointer("/hooks/PreToolUse/0/matcher").and_then(Value::as_str).unwrap();
        assert!(guarded.contains("Bash") && guarded.contains("Read") && guarded.contains("Write"));
        assert!(hooks.pointer("/hooks/PostToolUse/0/matcher").and_then(Value::as_str).unwrap().contains("Edit"));
        assert!(hooks.pointer("/hooks/Stop/0/hooks/0/command").and_then(Value::as_str).unwrap().contains("--cradle-hook stop"));
    }

    #[test]
    fn workspace_guard_stays_on_without_quality_hooks() {
        let hooks = hooks_json(false).unwrap();
        assert!(hooks.pointer("/hooks/PreToolUse/0/hooks/0/command").and_then(Value::as_str).unwrap().contains("--cradle-hook pre-tool"));
        assert!(hooks.pointer("/hooks/PostToolUse").is_none());
        assert!(hooks.pointer("/hooks/Stop").is_none());
    }

    #[test]
    fn pre_bash_blocks_dangerous_and_approval_commands() {
        assert!(pre_bash_decision("npm test").is_ok());
        assert!(pre_bash_decision("rm -rf /").is_err());
        assert!(pre_bash_decision("git push origin main").is_err());
        assert!(pre_bash_decision("cat keys.env").is_err());
    }

    #[test]
    fn parses_claude_json_result_and_usage() {
        let raw = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"result":"done","total_cost_usd":0.042,"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":20},"modelUsage":{"claude-sonnet-4-5":{}}}"#;
        let parsed = parse_claude_json(raw).unwrap();
        assert_eq!(parsed.text, "done");
        assert_eq!(parsed.input_tokens, 15);
        assert_eq!(parsed.cached_tokens, 100);
        assert_eq!(parsed.model, "claude-sonnet-4-5");
        assert!((parsed.total_cost_usd - 0.042).abs() < 1e-9);
        assert!(parse_claude_json("plain text answer").is_none());
    }

    #[test]
    fn claude_md_lists_detected_tests() {
        let text = claude_md_contents(&[TestCommand { command: "npm test".into(), source: "package.json".into() }]);
        assert!(text.starts_with(MANAGED_MARKER));
        assert!(text.contains("`npm test`"));
    }

    #[test]
    #[ignore = "writes a sample integration under $AI_CHARACTER_SAMPLE_DIR for manual CLI checks"]
    fn write_sample_integration() {
        let root = PathBuf::from(std::env::var("AI_CHARACTER_SAMPLE_DIR").unwrap());
        let snapshot = root.join(".ai-character/conversations/sample/project");
        fs::create_dir_all(&snapshot).unwrap();
        let args = prepare_claude_workspace(&snapshot).unwrap();
        println!("ARGS={}", serde_json::to_string(&args).unwrap());
    }

    #[test]
    fn lint_command_matches_file_type() {
        let dir = std::env::temp_dir().join(format!("lint-cmd-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("tsconfig.json"), "{}").unwrap();
        assert_eq!(lint_command_for(&dir, "src/a.ts").unwrap().command, "npx tsc --noEmit -p .");
        assert!(lint_command_for(&dir, "README.md").is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
