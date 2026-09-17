use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum AgentKind {
    Claude,
    Codex,
    Cursor,
    Antigravity,
}

impl AgentKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "cursor" | "agent" => Ok(Self::Cursor),
            "antigravity" | "agy" => Ok(Self::Antigravity),
            other => Err(format!("지원하지 않는 Agent입니다: {other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Antigravity => "antigravity",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor Agent",
            Self::Antigravity => "Antigravity",
        }
    }

    fn env_override_key(self) -> &'static str {
        match self {
            Self::Claude => "AI_CHARACTER_CLAUDE_BIN",
            Self::Codex => "AI_CHARACTER_CODEX_BIN",
            Self::Cursor => "AI_CHARACTER_CURSOR_BIN",
            Self::Antigravity => "AI_CHARACTER_ANTIGRAVITY_BIN",
        }
    }

    pub fn binary_names(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["claude"],
            Self::Codex => &["codex"],
            Self::Cursor => &["cursor-agent", "agent"],
            Self::Antigravity => &["agy"],
        }
    }
}

#[derive(Clone, Debug)]
pub struct AgentRequest {
    pub agent: AgentKind,
    pub prompt: String,
    pub working_dir: PathBuf,
    pub binary_path: PathBuf,
    pub extra_args: Vec<String>,
    pub model: Option<String>,
    pub task_id: Option<String>,
    pub timeout: Duration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentStreamKind {
    Stdout,
    Stderr,
}

impl AgentStreamKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

#[derive(Clone, Debug)]
pub struct AgentStreamChunk {
    pub kind: AgentStreamKind,
    pub text: String,
}


pub fn args_for(agent: AgentKind, prompt: &str) -> Vec<String> {
    match agent {
        AgentKind::Claude => vec!["-p".to_string(), prompt.to_string()],
        AgentKind::Codex => vec!["exec".to_string(), prompt.to_string()],
        AgentKind::Cursor | AgentKind::Antigravity => {
            vec!["-p".to_string(), prompt.to_string()]
        }
    }
}

pub fn model_args(_agent: AgentKind, model: Option<&str>) -> Vec<String> {
    let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    vec!["--model".to_string(), model.to_string()]
}

pub fn args_for_with_options(
    agent: AgentKind,
    prompt: &str,
    model: Option<&str>,
    extra_args: &[String],
) -> Vec<String> {
    let mut args = Vec::with_capacity(extra_args.len() + 6);
    args.extend(model_args(agent, model));

    if agent == AgentKind::Codex {
        // Flags that belong to `codex exec`, not the root command.
        let mut exec_flags = Vec::new();
        let mut root_args = Vec::new();
        for arg in extra_args {
            if matches!(
                arg.as_str(),
                "--skip-git-repo-check"
                    | "--full-auto"
                    | "--dangerously-bypass-approvals-and-sandbox"
            ) {
                if !exec_flags.iter().any(|existing: &String| existing == arg) {
                    exec_flags.push(arg.clone());
                }
            } else {
                root_args.push(arg.clone());
            }
        }
        args.extend(root_args);
        args.push("exec".to_string());
        args.extend(exec_flags);
        args.push(prompt.to_string());
        return args;
    }

    args.extend(extra_args.iter().cloned());
    args.extend(args_for(agent, prompt));
    args
}

pub fn managed_workspace_permission_args(agent: AgentKind) -> Vec<String> {
    match agent {
        AgentKind::Claude => vec![
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
        ],
        AgentKind::Codex => vec!["--full-auto".to_string()],
        AgentKind::Cursor => vec!["--force".to_string()],
        AgentKind::Antigravity => Vec::new(),
    }
}

pub fn merge_extra_args(existing: &[String], extra: &[String]) -> Vec<String> {
    let mut merged = existing.to_vec();
    if extra.is_empty() {
        return merged;
    }
    if extra.len() == 1 {
        if !merged.iter().any(|value| value == &extra[0]) {
            merged.extend(extra.iter().cloned());
        }
        return merged;
    }
    let already = merged.windows(extra.len()).any(|window| window == extra)
        || merged.iter().any(|value| value == &extra[0]);
    if !already {
        merged.extend(extra.iter().cloned());
    }
    merged
}

fn path_is_runnable(path: &Path) -> bool {
    path.is_file()
}

fn executable_variants(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            format!("{name}.cmd"),
            format!("{name}.exe"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    }

    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

fn search_path(agent: AgentKind) -> Option<PathBuf> {
    let value = env::var_os("PATH")?;
    for dir in env::split_paths(&value) {
        for name in agent.binary_names() {
            for variant in executable_variants(name) {
                let candidate = dir.join(&variant);
                if path_is_runnable(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn common_directories() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        if let Some(home) = env::var_os("HOME") {
            dirs.push(PathBuf::from(&home).join(".local/bin"));
            dirs.push(PathBuf::from(&home).join(".cursor/bin"));
            dirs.push(PathBuf::from(&home).join(".antigravity/bin"));
        }
    }

    #[cfg(windows)]
    {
        if let Some(appdata) = env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Programs"));
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        if let Some(home) = env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".local/bin"));
        }
    }

    dirs
}

pub fn resolve_agent_binary(
    agent: AgentKind,
    saved_override: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(path) = saved_override {
        if path_is_runnable(path) {
            return Ok(path.to_path_buf());
        }
        return Err(format!(
            "{} 실행 파일 경로가 유효하지 않습니다: {}",
            agent.display_name(),
            path.display()
        ));
    }

    if let Some(value) = env::var_os(agent.env_override_key()) {
        let path = PathBuf::from(value);
        if path_is_runnable(&path) {
            return Ok(path);
        }
    }

    if let Some(path) = search_path(agent) {
        return Ok(path);
    }

    for dir in common_directories() {
        for name in agent.binary_names() {
            for variant in executable_variants(name) {
                let candidate = dir.join(&variant);
                if path_is_runnable(&candidate) {
                    return Ok(candidate);
                }
            }
        }
    }

    Err(format!(
        "{} CLI를 찾을 수 없습니다. CLI를 설치하거나 설정에서 실행 파일 위치를 지정해주세요.",
        agent.display_name()
    ))
}

fn cancelled_tasks() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn request_cancel(task_id: &str) {
    if let Ok(mut tasks) = cancelled_tasks().lock() {
        tasks.insert(task_id.to_string());
    }
}

fn clear_cancel(task_id: Option<&str>) {
    if let Some(id) = task_id {
        if let Ok(mut tasks) = cancelled_tasks().lock() {
            tasks.remove(id);
        }
    }
}

fn is_cancelled(task_id: Option<&str>) -> bool {
    let Some(id) = task_id else {
        return false;
    };
    cancelled_tasks()
        .lock()
        .map(|tasks| tasks.contains(id))
        .unwrap_or(false)
}

fn read_pipe_streaming<R: Read + Send + 'static>(
    reader: R,
    kind: AgentStreamKind,
    tx: mpsc::Sender<AgentStreamChunk>,
) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut all = Vec::new();
        let mut chunk = Vec::new();

        loop {
            chunk.clear();
            match reader.read_until(b'\n', &mut chunk) {
                Ok(0) => break,
                Ok(_) => {
                    all.extend_from_slice(&chunk);
                    let text = String::from_utf8_lossy(&chunk).into_owned();
                    if !text.is_empty() {
                        let _ = tx.send(AgentStreamChunk { kind, text });
                    }
                }
                Err(_) => break,
            }
        }

        all
    })
}

fn join_output(handle: thread::JoinHandle<Vec<u8>>) -> Vec<u8> {
    handle.join().unwrap_or_default()
}

fn drain_stream<F>(
    rx: &mpsc::Receiver<AgentStreamChunk>,
    on_chunk: &mut F,
) where
    F: FnMut(AgentStreamChunk),
{
    while let Ok(chunk) = rx.try_recv() {
        on_chunk(chunk);
    }
}

pub fn run_request_streaming<F>(
    request: &AgentRequest,
    mut on_chunk: F,
) -> Result<String, String>
where
    F: FnMut(AgentStreamChunk),
{
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("메시지가 비어 있습니다.".to_string());
    }
    if !request.working_dir.is_dir() {
        return Err(format!(
            "작업 폴더를 찾을 수 없습니다: {}",
            request.working_dir.display()
        ));
    }
    if !request.binary_path.is_file() {
        return Err(format!(
            "{} 실행 파일을 찾을 수 없습니다: {}",
            request.agent.display_name(),
            request.binary_path.display()
        ));
    }

    let mut child = Command::new(&request.binary_path)
        .args(args_for_with_options(
            request.agent,
            prompt,
            request.model.as_deref(),
            &request.extra_args,
        ))
        .current_dir(&request.working_dir)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            clear_cancel(request.task_id.as_deref());
            format!(
                "{} 실행에 실패했습니다: {error}",
                request.agent.display_name()
            )
        })?;

    let (tx, rx) = mpsc::channel::<AgentStreamChunk>();
    let stdout_reader = child
        .stdout
        .take()
        .map(|reader| read_pipe_streaming(reader, AgentStreamKind::Stdout, tx.clone()));
    let stderr_reader = child
        .stderr
        .take()
        .map(|reader| read_pipe_streaming(reader, AgentStreamKind::Stderr, tx.clone()));
    drop(tx);

    let started = Instant::now();
    let mut cancelled = false;
    let mut timed_out = false;

    let status = loop {
        drain_stream(&rx, &mut on_chunk);

        if is_cancelled(request.task_id.as_deref()) {
            cancelled = true;
            let _ = child.kill();
            break child
                .wait()
                .map_err(|error| format!("Agent 종료 확인 실패: {error}"))?;
        }

        if started.elapsed() >= request.timeout {
            timed_out = true;
            let _ = child.kill();
            break child
                .wait()
                .map_err(|error| format!("Agent timeout 종료 확인 실패: {error}"))?;
        }

        match child
            .try_wait()
            .map_err(|error| format!("Agent 상태 확인 실패: {error}"))?
        {
            Some(status) => break status,
            None => thread::sleep(Duration::from_millis(40)),
        }
    };

    let stdout = stdout_reader.map(join_output).unwrap_or_default();
    let stderr = stderr_reader.map(join_output).unwrap_or_default();
    drain_stream(&rx, &mut on_chunk);
    clear_cancel(request.task_id.as_deref());

    if cancelled {
        return Err("Agent 실행을 취소했습니다.".to_string());
    }
    if timed_out {
        return Err(format!(
            "{} 실행 시간이 제한을 초과해 중지했습니다.",
            request.agent.display_name()
        ));
    }

    let stderr_text = String::from_utf8_lossy(&stderr).trim().to_string();
    if !status.success() {
        let detail = if stderr_text.is_empty() {
            status
                .code()
                .map(|code| format!("종료 코드 {code}"))
                .unwrap_or_else(|| "알 수 없는 종료 상태".to_string())
        } else {
            stderr_text
        };
        return Err(format!("{} 오류: {detail}", request.agent.display_name()));
    }

    let answer = String::from_utf8_lossy(&stdout).trim().to_string();
    if answer.is_empty() {
        return Err(format!("{} 응답이 비어 있습니다.", request.agent.display_name()));
    }

    Ok(answer)
}


pub fn canonical_existing_dir(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("폴더를 읽을 수 없습니다: {} ({error})", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("폴더가 아닙니다: {}", path.display()));
    }
    fs::canonicalize(path)
        .map_err(|error| format!("폴더 경로 확인 실패: {} ({error})", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_managed_workspace_skips_permission_prompts() {
        let extra = managed_workspace_permission_args(AgentKind::Claude);
        let args = args_for_with_options(AgentKind::Claude, "안녕", None, &extra);
        assert_eq!(
            args,
            vec![
                "--permission-mode".to_string(),
                "bypassPermissions".to_string(),
                "-p".to_string(),
                "안녕".to_string(),
            ]
        );
    }

    #[test]
    fn codex_full_auto_follows_exec() {
        let extra = vec![
            "--skip-git-repo-check".to_string(),
            "--full-auto".to_string(),
        ];
        let args = args_for_with_options(AgentKind::Codex, "안녕", None, &extra);
        assert_eq!(
            args,
            vec![
                "exec".to_string(),
                "--skip-git-repo-check".to_string(),
                "--full-auto".to_string(),
                "안녕".to_string(),
            ]
        );
    }
}
