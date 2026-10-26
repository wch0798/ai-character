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
    // The app's own data: the saved keys file and the folder it lives in.
    "keys.env",
    "roaming/ai-character",
    "roaming\\ai-character",
    "application support/ai-character",
    // Reading the environment or special folders builds paths this check can't see.
    "process.env",
    "os.environ",
    "getenv",
    "[environment]::",
    "getfolderpath",
    // cmd.exe can change drive and folder (`C: & cd \`) without writing a full path.
    "cmd //c",
    "cmd.exe //c",
    "cmd /c",
    "cmd.exe /c",
    "cmd /k",
    "cmd.exe /k",
    // The app runs git in this folder; hooks or fsmonitor there would run outside this check.
    ".git/hooks",
    ".git\\hooks",
    ".git/config",
    ".git\\config",
    "core.hookspath",
    "core.fsmonitor",
    "git config",
];

/// Claude tools that write files; none of them may touch a `.git` folder.
const WRITE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// `\\server\share` or `//server/share`. Checked before anything touches the file system,
/// because even looking at such a path makes Windows connect to that server.
pub fn is_network_path(raw: &str) -> bool {
    let raw = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    raw.starts_with(r"\\") || (raw.starts_with("//") && !raw.starts_with("///"))
}

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

/// The folders a call may touch, resolved once per check rather than once per path.
struct Roots(Vec<String>);

impl Roots {
    fn new<'a>(roots: impl IntoIterator<Item = &'a Path>) -> Self {
        Roots(roots.into_iter().map(|root| normalized(&real(root))).filter(|root| !root.is_empty()).collect())
    }

    fn allow(&self, path: &Path) -> bool {
        let path = normalized(&real(path));
        self.0.iter().any(|root| path == *root || path.starts_with(&format!("{root}/")))
    }
}

/// Why a file tool call is refused, or None to let it run.
pub fn check_file_tool(tool: &str, tool_input: &serde_json::Value, cwd: &Path, workspace: &Path, temp: &Path, home: Option<&Path>) -> Option<String> {
    let roots = Roots::new([workspace, temp]);
    for field in FILE_PATH_FIELDS {
        let Some(raw) = tool_input.get(*field).and_then(serde_json::Value::as_str) else { continue };
        if raw.trim().is_empty() {
            continue;
        }
        if is_network_path(raw) {
            return Some(outside_message(raw));
        }
        let path = resolve(cwd, raw, home);
        if !roots.allow(&path) {
            return Some(outside_message(raw));
        }
        if WRITE_TOOLS.contains(&tool) && path.components().any(|part| part.as_os_str().eq_ignore_ascii_case(".git")) {
            return Some(git_message());
        }
    }
    // Glob's `pattern` and Grep's `glob` can carry a path of their own ("C:/Users/**/*.env",
    // "../../**"): the folder part before the first wildcard must stay inside too, resolved
    // against the tool's own `path` when it gives one.
    let base = tool_input
        .get("path")
        .and_then(serde_json::Value::as_str)
        .filter(|raw| !raw.trim().is_empty())
        .map_or_else(|| cwd.to_path_buf(), |raw| resolve(cwd, raw, home));
    // Grep's own `pattern` is a regex to search for, not a path.
    let glob_field = match tool {
        "Glob" => Some("pattern"),
        "Grep" => Some("glob"),
        _ => None,
    };
    if let Some(raw) = glob_field.and_then(|field| tool_input.get(field)).and_then(serde_json::Value::as_str) {
        let folder = pattern_folder(raw);
        if is_network_path(&folder) || (!folder.is_empty() && !roots.allow(&resolve(&base, &folder, home))) {
            return Some(outside_message(raw));
        }
    }
    None
}

/// Words in an MCP tool name that change something on GitHub.
const GITHUB_WRITE_WORDS: &[&str] = &["create", "update", "delete", "push", "merge", "fork", "write", "comment", "close", "add_", "remove"];

/// MCP tools (Playwright, GitHub): GitHub changes are left to the user, and any file path or
/// `file://` address in the arguments must stay inside the workspace.
pub fn check_mcp_tool(tool: &str, tool_input: &serde_json::Value, cwd: &Path, workspace: &Path, temp: &Path, home: Option<&Path>) -> Option<String> {
    let name = tool.to_lowercase();
    if name.contains("github") && GITHUB_WRITE_WORDS.iter().any(|word| name.contains(word)) {
        return Some(format!(
            "AI-Character 안전 규칙: GitHub에 바로 쓰는 작업({tool})은 하지 않습니다. 바꿀 내용을 결과에 적어 사용자에게 직접 하도록 요청하세요."
        ));
    }
    let roots = Roots::new([workspace, temp]);
    let mut strings = Vec::new();
    collect_strings(tool_input, &mut strings);
    for raw in strings {
        let text = raw.trim();
        let path_text = match file_url_path(text) {
            Some(path) => path,
            None if is_network_path(text) || starts_like_path(text) => text.to_string(),
            None => continue,
        };
        if is_network_path(&path_text) || !roots.allow(&resolve(cwd, &path_text, home)) {
            return Some(outside_message(text));
        }
    }
    None
}

fn collect_strings<'a>(value: &'a serde_json::Value, out: &mut Vec<&'a str>) {
    match value {
        serde_json::Value::String(text) => out.push(text),
        serde_json::Value::Array(items) => items.iter().for_each(|item| collect_strings(item, out)),
        serde_json::Value::Object(map) => map.values().for_each(|item| collect_strings(item, out)),
        _ => {}
    }
}

/// `file:///C:/x/y` → `C:/x/y`; `file://server/share` → `//server/share` (a network path).
fn file_url_path(text: &str) -> Option<String> {
    if !text.get(..5)?.eq_ignore_ascii_case("file:") {
        return None;
    }
    let decoded = text[5..].replace("%20", " ");
    Some(match decoded.strip_prefix("///") {
        Some(local) => local.to_string(),
        None => decoded.strip_prefix("//").map_or(decoded.clone(), |host| format!("//{host}")),
    })
}

fn git_message() -> String {
    "AI-Character 안전 규칙: .git 폴더(훅·설정)는 고칠 수 없습니다. 코드 파일만 고치세요.".to_string()
}

/// The folder a glob starts from: everything before the first segment with a wildcard.
/// `src/**/*.ts` → `src`, `C:/Users/**` → `C:/Users`, `*.md` → "".
fn pattern_folder(pattern: &str) -> String {
    let mut folder = Vec::new();
    for segment in pattern.split(['/', '\\']) {
        if segment.contains(['*', '?', '[', '{']) {
            break;
        }
        folder.push(segment);
    }
    // A pattern with no wildcard at all names a file; its folder is what matters.
    if folder.len() == pattern.split(['/', '\\']).count() {
        folder.pop();
    }
    let joined = folder.join("/");
    // "C:" alone is a drive; keep its root.
    if joined.len() == 2 && joined.ends_with(':') { format!("{joined}/") } else if pattern.starts_with('/') && joined.is_empty() { "/".to_string() } else { joined }
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
    // `C:\x`, `C:/x`, and also a bare `C:` or drive-relative `C:Users` (cmd changes drive so).
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && !word.contains("://");
    // `\Users\me` is rooted on the current drive; `\n` alone is an escape, not a path.
    let rooted = word == r"\"
        || (bytes.len() > 2 && bytes[0] == b'\\' && bytes[1].is_ascii_alphabetic() && word[1..].contains(['\\', '/']));
    drive
        || rooted
        || word.starts_with('~')
        || word.starts_with("..")
        || is_network_path(word)
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
    let roots = Roots::new([workspace, temp].into_iter().chain(extra_roots.iter().map(PathBuf::as_path)));
    for word in path_like_words(command) {
        // Network paths (\\server\share) are always outside, and never looked at.
        if is_network_path(&word) || !roots.allow(&resolve(cwd, &word, home)) {
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
        let ok = check_file_tool("Read", &json!({ "file_path": "src/main.ts" }), &ws, &ws, &tmp, Some(&home));
        assert_eq!(ok, None);
        assert!(check_file_tool("Read", &json!({ "file_path": "../../.env" }), &ws, &ws, &tmp, Some(&home)).is_some());
        assert!(check_file_tool("Read", &json!({ "file_path": "~/.ssh/id_rsa" }), &ws, &ws, &tmp, Some(&home)).is_some());
        assert!(check_file_tool("Read", &json!({ "path": "C:/Users" }), &ws, &ws, &tmp, Some(&home)).is_some());
    }

    #[test]
    fn glob_patterns_stay_inside() {
        let (ws, tmp, home) = dirs();
        let check = |tool: &str, input: serde_json::Value| check_file_tool(tool, &input, &ws, &ws, &tmp, Some(&home));
        assert_eq!(check("Glob", json!({ "pattern": "src/**/*.ts" })), None);
        assert!(check("Glob", json!({ "pattern": "C:/Users/me/**/*.env" })).is_some());
        assert!(check("Glob", json!({ "pattern": "../../**" })).is_some());
        assert!(check("Grep", json!({ "pattern": "x", "glob": "../**/*.env" })).is_some());
        // A regex that happens to look like a path is only searched for, not opened.
        assert_eq!(check("Grep", json!({ "pattern": "../config" })), None);
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
    fn keys_env_git_and_network_paths_are_refused() {
        let (ws, tmp, home) = dirs();
        let shell = |cmd: &str| check_shell(cmd, &ws, &ws, &tmp, Some(&home), &[]);
        assert!(shell("cat keys.env").is_some());
        assert!(shell(r#"node -e "console.log(process.env.APPDATA)""#).is_some());
        assert!(shell(r#"cmd //c "C: & cd \ & type Users\me\x.txt""#).is_some());
        assert!(shell("dir C:").is_some());
        assert!(shell("echo x > .git/hooks/post-checkout").is_some());
        assert!(shell("cat //attacker/share/x").is_some());
        assert_eq!(shell("npm run test:unit"), None);
        let file = |tool: &str, input: serde_json::Value| check_file_tool(tool, &input, &ws, &ws, &tmp, Some(&home));
        assert!(file("Write", json!({ "file_path": ".git/config" })).is_some());
        assert_eq!(file("Read", json!({ "file_path": ".git/HEAD" })), None);
        assert!(file("Read", json!({ "file_path": r"\\attacker\share\x" })).is_some());
    }

    #[test]
    fn mcp_tools_stay_inside_and_leave_github_writes_to_the_user() {
        let (ws, tmp, home) = dirs();
        let mcp = |tool: &str, input: serde_json::Value| check_mcp_tool(tool, &input, &ws, &ws, &tmp, Some(&home));
        assert!(mcp("mcp__github__create_pull_request", json!({ "title": "x" })).is_some());
        assert_eq!(mcp("mcp__github__get_file_contents", json!({ "path": "README.md" })), None);
        assert!(mcp("mcp__playwright__browser_navigate", json!({ "url": "file:///C:/Users/me/x.html" })).is_some());
        assert!(mcp("mcp__playwright__browser_file_upload", json!({ "paths": ["C:/Users/me/secret.txt"] })).is_some());
        assert_eq!(mcp("mcp__playwright__browser_navigate", json!({ "url": "https://example.com" })), None);
    }

    #[test]
    fn git_bash_drives_are_understood() {
        assert_eq!(git_bash_drive("/c/Users/me").as_deref(), Some("C:/Users/me"));
        assert_eq!(git_bash_drive("/mnt/d/x").as_deref(), Some("D:/x"));
        assert_eq!(git_bash_drive("/usr/bin"), None);
    }
}
