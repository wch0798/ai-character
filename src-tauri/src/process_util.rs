use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

// The process environment is never mutated after startup (`set_var` races with C code reading
// `environ`), so refreshed PATH and saved keys live here and are passed to children explicitly.
static PATH_OVERRIDE: RwLock<Option<OsString>> = RwLock::new(None);
static SECRET_OVERLAY: RwLock<BTreeMap<String, Option<String>>> = RwLock::new(BTreeMap::new());

pub fn process_path() -> Option<OsString> {
    PATH_OVERRIDE
        .read()
        .ok()
        .and_then(|value| value.clone())
        .or_else(|| env::var_os("PATH"))
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn set_process_path(value: OsString) {
    if let Ok(mut slot) = PATH_OVERRIDE.write() {
        *slot = Some(value);
    }
}

/// Current value of an API key: a value saved in this session wins over the inherited one.
pub fn secret_value(name: &str) -> Option<String> {
    let overlay = SECRET_OVERLAY.read().ok().and_then(|map| map.get(name).cloned());
    let value = match overlay {
        Some(saved) => saved,
        None => env::var(name).ok(),
    };
    value.map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

/// `None` hides an inherited value from this app and its children.
pub fn set_secret_value(name: &str, value: Option<String>) {
    if let Ok(mut map) = SECRET_OVERLAY.write() {
        map.insert(name.to_string(), value.filter(|value| !value.trim().is_empty()));
    }
}

/// Gives a child the refreshed PATH and the keys saved in this session.
pub fn apply_process_env(command: &mut Command) -> &mut Command {
    if let Some(path) = PATH_OVERRIDE.read().ok().and_then(|value| value.clone()) {
        command.env("PATH", path);
    }
    if let Ok(map) = SECRET_OVERLAY.read() {
        for (name, value) in map.iter() {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
    }
    command
}

#[derive(Clone, Debug, Default)]
pub struct CommandOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: i64,
}

/// GUI apps on macOS start with a minimal PATH that lacks Homebrew, cargo and npm globals.
pub fn tool_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = process_path()
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default();
    #[cfg(unix)]
    {
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            dirs.push(PathBuf::from(dir));
        }
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            dirs.push(home.join(".cargo/bin"));
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".cursor/bin"));
            dirs.push(home.join(".antigravity/bin"));
            dirs.push(home.join(".npm-global/bin"));
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = env::var_os("APPDATA") {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(program_files) = env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(&program_files).join("nodejs"));
            dirs.push(PathBuf::from(&program_files).join("Git").join("cmd"));
        }
        if let Some(profile) = env::var_os("USERPROFILE") {
            dirs.push(PathBuf::from(profile).join(".cargo").join("bin"));
        }
    }
    let mut unique = Vec::new();
    for dir in dirs {
        if !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    unique
}

pub fn augmented_path() -> OsString {
    env::join_paths(tool_dirs()).unwrap_or_else(|_| process_path().unwrap_or_default())
}

fn executable_variants(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![format!("{name}.exe"), format!("{name}.cmd"), format!("{name}.bat"), name.to_string()]
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

pub fn find_tool(name: &str) -> Option<PathBuf> {
    tool_dirs().into_iter().find_map(|dir| {
        executable_variants(name)
            .into_iter()
            .map(|variant| dir.join(variant))
            .find(|candidate| candidate.is_file())
    })
}

/// Bytes a pipe reader thread has collected so far; it keeps growing until the pipe closes.
pub type SharedOutput = Arc<Mutex<Vec<u8>>>;

/// How long to wait for the output pipes after the process itself has exited. A background
/// grandchild (a server the agent started, the real binary behind a node shim) can hold them
/// open for hours, and the run must still finish.
pub const PIPE_GRACE: Duration = Duration::from_secs(3);

pub fn spawn_reader<R: Read + Send + 'static>(mut reader: R) -> (SharedOutput, thread::JoinHandle<()>) {
    let output = SharedOutput::default();
    let sink = output.clone();
    let handle = thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => sink.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&buffer[..read]),
            }
        }
    });
    (output, handle)
}

/// What the reader collected, waiting at most until `deadline` for the pipe to close.
pub fn collect_until(output: &SharedOutput, handle: thread::JoinHandle<()>, deadline: Instant) -> Vec<u8> {
    while !handle.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    if handle.is_finished() {
        let _ = handle.join();
    }
    output.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Runs a program with a hard timeout; stdout and stderr are combined.
pub fn run_command(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    envs: &[(&str, OsString)],
    timeout: Duration,
) -> CommandOutput {
    run_command_with(program, args, cwd, envs, false, timeout, None)
}

/// Same as `run_command`, but the child never sees the app's API keys or tokens.
pub fn run_command_without_secrets(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    envs: &[(&str, OsString)],
    timeout: Duration,
) -> CommandOutput {
    run_command_with(program, args, cwd, envs, true, timeout, None)
}

/// Like `run_command`; setting `cancel` kills the whole process tree.
pub fn run_command_cancellable(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    strip_secrets: bool,
    timeout: Duration,
    cancel: &AtomicBool,
) -> CommandOutput {
    run_command_with(program, args, cwd, &[], strip_secrets, timeout, Some(cancel))
}

/// Shells spawn grandchildren that keep the output pipes open, so the whole group is killed.
pub fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let mut taskkill = Command::new("taskkill");
        crate::windows_process::hide_console(&mut taskkill);
        let _ = taskkill
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

fn run_command_with(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    envs: &[(&str, OsString)],
    strip_secrets: bool,
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> CommandOutput {
    let started = Instant::now();
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        crate::windows_process::hide_console(&mut command);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    apply_process_env(&mut command);
    command.args(args).env("PATH", augmented_path()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    if strip_secrets {
        for name in crate::policy_engine::SECRET_ENV_NAMES {
            command.env_remove(name);
        }
    }
    for (key, value) in envs {
        command.env(key, value);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CommandOutput {
                output: format!("실행 실패: {} ({error})", program.display()),
                duration_ms: started.elapsed().as_millis() as i64,
                ..Default::default()
            }
        }
    };
    let stdout = child.stdout.take().map(spawn_reader);
    let stderr = child.stderr.take().map(spawn_reader);
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                kill_tree(&mut child);
                break child.wait().ok();
            }
            Ok(None) if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) => {
                cancelled = true;
                kill_tree(&mut child);
                break child.wait().ok();
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => break None,
        }
    };
    let mut output = String::new();
    let deadline = Instant::now() + PIPE_GRACE;
    for (collected, handle) in [stdout, stderr].into_iter().flatten() {
        output.push_str(&String::from_utf8_lossy(&collect_until(&collected, handle, deadline)));
    }
    CommandOutput {
        success: !timed_out && !cancelled && status.map(|status| status.success()).unwrap_or(false),
        code: status.and_then(|status| status.code()),
        output,
        timed_out,
        cancelled,
        duration_ms: started.elapsed().as_millis() as i64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reader that sends a little and then blocks, like a pipe a background grandchild holds.
    struct HeldOpen(bool);

    impl Read for HeldOpen {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if !self.0 {
                self.0 = true;
                buffer[..2].copy_from_slice(b"hi");
                return Ok(2);
            }
            thread::sleep(Duration::from_secs(3600));
            Ok(0)
        }
    }

    #[test]
    fn collect_until_gives_up_on_a_pipe_that_stays_open() {
        let (output, handle) = spawn_reader(HeldOpen(false));
        let started = Instant::now();
        let bytes = collect_until(&output, handle, Instant::now() + Duration::from_millis(300));
        assert_eq!(bytes, b"hi");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn captures_output_and_exit_code() {
        let sh = find_tool("sh").unwrap();
        let result = run_command(&sh, &["-c".into(), "echo hi; echo err 1>&2; exit 3".into()], None, &[], Duration::from_secs(5));
        assert!(!result.success);
        assert_eq!(result.code, Some(3));
        assert!(result.output.contains("hi") && result.output.contains("err"));
    }

    #[cfg(unix)]
    #[test]
    fn strips_secret_env_vars() {
        let sh = find_tool("sh").unwrap();
        let script = vec!["-c".into(), "echo \"[$GITHUB_TOKEN]\"".into()];
        let envs = [("GITHUB_TOKEN", OsString::from("ghp_visible"))];
        let plain = run_command(&sh, &script, None, &envs, Duration::from_secs(5));
        assert!(plain.output.contains("[ghp_visible]"));
        let clean = run_command_without_secrets(&sh, &script, None, &[], Duration::from_secs(5));
        assert!(clean.output.contains("[]"));
    }

    #[cfg(unix)]
    #[test]
    fn saved_keys_reach_children_without_touching_process_env() {
        let name = "OPENAI_API_KEY";
        let inherited = env::var(name).ok();
        set_secret_value(name, Some("sk-overlay-test-value".into()));
        assert_eq!(secret_value(name).as_deref(), Some("sk-overlay-test-value"));
        assert_eq!(env::var(name).ok(), inherited);
        let sh = find_tool("sh").unwrap();
        let script = vec!["-c".into(), format!("echo \"[${name}]\"")];
        let seen = run_command(&sh, &script, None, &[], Duration::from_secs(5));
        assert!(seen.output.contains("[sk-overlay-test-value]"));
        set_secret_value(name, None);
        assert_eq!(secret_value(name), None);
        let hidden = run_command(&sh, &script, None, &[], Duration::from_secs(5));
        assert!(hidden.output.contains("[]"));
    }

    #[cfg(unix)]
    #[test]
    fn cancel_kills_the_whole_shell_tree() {
        let sh = find_tool("sh").unwrap();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let stopper = thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::SeqCst);
        });
        let args = vec!["-c".into(), "sleep 5 | cat; echo done".into()];
        let result = run_command_cancellable(&sh, &args, None, true, Duration::from_secs(10), &cancel);
        stopper.join().unwrap();
        assert!(result.cancelled && !result.success && !result.timed_out);
        assert!(!result.output.contains("done"));
        assert!(result.duration_ms < 3_000, "took {}ms", result.duration_ms);
    }

    #[cfg(unix)]
    #[test]
    fn kills_on_timeout() {
        let sh = find_tool("sh").unwrap();
        let result = run_command(&sh, &["-c".into(), "sleep 5".into()], None, &[], Duration::from_millis(300));
        assert!(result.timed_out && !result.success);
        assert!(result.duration_ms < 3_000);
    }
}
