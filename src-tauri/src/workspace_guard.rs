//! Keeps Claude inside its workspace copy. In the managed workspace Claude runs with
//! `bypassPermissions`, and the pages and files it reads may carry injected instructions, so
//! every file tool and shell command goes through this check first (a PreToolUse hook).
//!
//! The file-tool check is exact. The shell check reads paths out of the command text, so it
//! stops the plain cases ("read ../../.env", "write to the Startup folder") but not a command
//! that builds its paths at run time; that is why saved keys are also kept out of the agent's
//! environment (agent_core::agent_hidden_secrets).
//!
//! Self-contained (no crate imports) so it can be exercised on its own.

use std::path::{Component, Path, PathBuf};

/// Env var naming the workspace root, set on the agent process and inherited by its hooks.
pub const WORKSPACE_ENV: &str = "AI_CHARACTER_WORKSPACE";

const FILE_PATH_FIELDS: &[&str] = &["file_path", "notebook_path", "path"];

/// Ways to reach the user's profile or start-up without writing a path the check can read.
const SHELL_DENY: &[&str] = &[
    "$home",
    "${home}",
    "$userprofile",
    "%userprofile%",
    "%appdata%",
    "%localappdata%",
    "%homepath%",
    "$env:userprofile",
    "$env:appdata",
    "$env:localappdata",
    "$env:homepath",
    "$appdata",
    "$localappdata",
    "start menu\\programs\\startup",
    "start menu/programs/startup",
    "currentversion\\run",
    "currentversion/run",
    "schtasks",
    "reg add",
    "reg.exe add",
    "new-itemproperty",
    "set-itemproperty",
    "-encodedcommand",
    "frombase64string",
];

/// Lexically resolves `raw` against `base`: Git Bash `/c/...`, `~`, `.` and `..` included.
pub fn resolve(base: &Path, raw: &str, home: Option<&Path>) -> PathBuf {
    let raw = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    let path = if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")).or(if raw == "~" { Some("") } else { None }) {
        match home {
            Some(home) => home.join(rest),
            None => PathBuf::from(raw),
        }
    } else if let Some(drive) = git_bash_drive(raw) {
        PathBuf::from(drive)
    } else {
        PathBuf::from(raw)
    };
    let joined = if path.is_absolute() || path.has_root() { path } else { base.join(path) };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `/c/Users/x` or `/mnt/c/Users/x` → `C:/Users/x`.
fn git_bash_drive(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("/mnt/").or_else(|| raw.strip_prefix('/'))?;
    let mut chars = rest.chars();
    let drive = chars.next()?;
    let after = chars.as_str();
    if drive.is_ascii_alphabetic() && (after.is_empty() || after.starts_with('/')) {
        Some(format!("{}:/{}", drive.to_ascii_uppercase(), after.trim_start_matches('/')))
    } else {
        None
    }
}

/// Follows junctions and symlinks for the part of `path` that exists.
fn real(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(|name| name.to_os_string()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
    let mut out = std::fs::canonicalize(&existing).map(strip_verbatim).unwrap_or(existing);
    for name in rest.into_iter().rev() {
        out.push(name);
    }
    out
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/');
    if cfg!(windows) { text.to_lowercase() } else { text.to_string() }
}

pub fn is_inside(path: &Path, root: &Path) -> bool {
    let (path, root) = (normalized(&real(path)), normalized(&real(root)));
    !root.is_empty() && (path == root || path.starts_with(&format!("{root}/")))
}

fn allowed(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| is_inside(path, root))
}

/// Why a file tool call is refused, or None to let it run.
pub fn check_file_tool(tool_input: &serde_json::Value, cwd: &Path, workspace: &Path, temp: &Path, home: Option<&Path>) -> Option<String> {
    let roots = [workspace.to_path_buf(), temp.to_path_buf()];
    for field in FILE_PATH_FIELDS {
        let Some(raw) = tool_input.get(*field).and_then(serde_json::Value::as_str) else { continue };
        if raw.trim().is_empty() {
            continue;
        }
        let path = resolve(cwd, raw, home);
        if !allowed(&path, &roots) {
            return Some(outside_message(raw));
        }
    }
    None
}

/// Words in a shell command that look like paths (absolute, `~`, Git Bash drives, `..`).
fn path_like_words(command: &str) -> Vec<String> {
    // A quoted path is one word ("C:\Program Files\..."). Other quoted text, such as
    // bash -c "cat ../../.env", is split like the rest of the command.
    let mut words = Vec::new();
    let mut rest = String::new();
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' {
            let quoted: String = chars.by_ref().take_while(|&next| next != c).collect();
            if starts_like_path(&quoted) {
                words.push(quoted);
                rest.push(' ');
            } else {
                rest.push(' ');
                rest.push_str(&quoted);
                rest.push(' ');
            }
        } else {
            rest.push(c);
        }
    }
    words.extend(rest.split(|c: char| c.is_whitespace() || "`;|&<>()=,".contains(c)).map(str::to_string));
    words
        .into_iter()
        .filter(|word| !word.is_empty())
        .filter(|word| starts_like_path(word) || word.split(['/', '\\']).any(|part| part == ".."))
        .collect()
}

fn starts_like_path(word: &str) -> bool {
    let bytes = word.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/');
    drive
        || word.starts_with('~')
        || word.starts_with("..")
        || word.starts_with("\\\\")
        || git_bash_drive(word.split_whitespace().next().unwrap_or_default()).is_some()
}

/// Why a shell command is refused, or None to let it run. `extra_roots` are read-only system
/// folders (Program Files, Windows) that commands may name to run tools.
pub fn check_shell(command: &str, cwd: &Path, workspace: &Path, temp: &Path, home: Option<&Path>, extra_roots: &[PathBuf]) -> Option<String> {
    let lower = command.to_lowercase();
    if let Some(found) = SHELL_DENY.iter().find(|marker| lower.contains(*marker)) {
        return Some(format!(
            "AI-Character 안전 규칙: 사용자 폴더나 시작 프로그램을 건드릴 수 있는 명령이라 막았습니다 ({found}). 작업 폴더 안에서만 작업하세요."
        ));
    }
    let mut roots = vec![workspace.to_path_buf(), temp.to_path_buf()];
    roots.extend(extra_roots.iter().cloned());
    for word in path_like_words(command) {
        // Network paths (\\server\share) are always outside.
        if word.starts_with("\\\\") || !allowed(&resolve(cwd, &word, home), &roots) {
            return Some(outside_message(&word));
        }
    }
    None
}

fn outside_message(raw: &str) -> String {
    format!("AI-Character 안전 규칙: 작업 폴더 밖({raw})은 읽거나 쓸 수 없습니다. 작업 폴더 안의 파일만 사용하세요.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dirs() -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("guard-{}", std::process::id()));
        let workspace = base.join("conv").join("project");
        std::fs::create_dir_all(&workspace).unwrap();
        (workspace, base.join("tmp"), base.join("home"))
    }

    #[test]
    fn file_tools_stay_inside() {
        let (ws, tmp, home) = dirs();
        let ok = check_file_tool(&json!({ "file_path": "src/main.ts" }), &ws, &ws, &tmp, Some(&home));
        assert_eq!(ok, None);
        assert!(check_file_tool(&json!({ "file_path": "../../.env" }), &ws, &ws, &tmp, Some(&home)).is_some());
        assert!(check_file_tool(&json!({ "file_path": "~/.ssh/id_rsa" }), &ws, &ws, &tmp, Some(&home)).is_some());
        assert!(check_file_tool(&json!({ "path": "C:/Users" }), &ws, &ws, &tmp, Some(&home)).is_some());
    }

    #[test]
    fn shell_commands_stay_inside() {
        let (ws, tmp, home) = dirs();
        let check = |cmd: &str| check_shell(cmd, &ws, &ws, &tmp, Some(&home), &[]);
        assert_eq!(check("npm test -- --run src/a.test.ts"), None);
        assert_eq!(check("git diff ./src"), None);
        assert!(check("cat ../../.env").is_some());
        assert!(check("type C:\\Users\\me\\.ssh\\id_rsa").is_some());
        assert!(check("cp x.bat /c/Users/me/AppData/Roaming/x.bat").is_some());
        assert!(check("echo hi > $env:APPDATA\\x.txt").is_some());
        assert!(check("schtasks /create /tn x /tr calc").is_some());
    }

    #[test]
    fn git_bash_drives_are_understood() {
        assert_eq!(git_bash_drive("/c/Users/me").as_deref(), Some("C:/Users/me"));
        assert_eq!(git_bash_drive("/mnt/d/x").as_deref(), Some("D:/x"));
        assert_eq!(git_bash_drive("/usr/bin"), None);
    }
}
