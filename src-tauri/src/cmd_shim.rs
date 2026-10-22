#![cfg_attr(not(windows), allow(dead_code))]
//! `.cmd` launchers (npm installs, Cursor) only start Node with a script. Running that Node
//! directly avoids cmd.exe, which cannot take line breaks in arguments, expands `%` and, with
//! delayed expansion on, swallows `!`. User prompts then reach the program exactly as typed.
//!
//! Self-contained (no crate imports) so it can be exercised against real launchers on disk.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct ShimTarget {
    pub program: PathBuf,
    /// Arguments that go before the caller's own (the script path).
    pub leading: Vec<OsString>,
    pub envs: Vec<(String, OsString)>,
}

/// The script an npm cmd-shim forwards to: the quoted `%dp0%\...` path right before `%*`.
pub fn npm_shim_script(text: &str) -> Option<String> {
    for line in text.lines().rev() {
        let Some(before) = line.trim_end().strip_suffix("%*") else { continue };
        let quoted = before.trim_end().strip_suffix('"')?;
        let start = quoted.rfind('"')?;
        let inner = &quoted[start + 1..];
        let relative = ["%dp0%\\", "%~dp0\\", "%dp0%/", "%~dp0/"]
            .iter()
            .find_map(|prefix| inner.strip_prefix(prefix))?;
        if relative.is_empty() || relative.contains('%') || relative.split(['\\', '/']).any(|part| part == "..") {
            return None;
        }
        return Some(relative.to_string());
    }
    None
}

/// `YYYY.MM.DD-commit` or `YYYY.MM.DD-HH-MM-SS-commit` → sort key; anything else is ignored.
fn cursor_version_key(name: &str) -> Option<(u32, u32, u32, String)> {
    let (date, rest) = name.split_once('-')?;
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    let mut parts = date.split('.');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse().ok()?;
    let day = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((year, month, day, rest.to_string()))
}

pub fn latest_cursor_version(names: impl IntoIterator<Item = String>) -> Option<String> {
    names
        .into_iter()
        .filter_map(|name| cursor_version_key(&name).map(|key| (key, name)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, name)| name)
}

/// Finds the program a `.cmd` launcher really runs. `None` means "unknown launcher".
pub fn resolve(path: &Path, find_node: impl Fn() -> Option<PathBuf>) -> Option<ShimTarget> {
    let dir = path.parent()?;
    let text = std::fs::read_to_string(path).ok()?;

    if let Some(relative) = npm_shim_script(&text) {
        let script = dir.join(relative);
        if !script.is_file() {
            return None;
        }
        let local = dir.join("node.exe");
        let program = if local.is_file() { local } else { find_node()? };
        return Some(ShimTarget { program, leading: vec![script.into_os_string()], envs: Vec::new() });
    }

    // Cursor: cursor-agent.cmd → cursor-agent.ps1 → (node.exe + index.js) next to it, or in
    // the newest versions\<version>\ folder.
    if text.to_ascii_lowercase().contains(".ps1") {
        let version_dir = if dir.join("node.exe").is_file() && dir.join("index.js").is_file() {
            dir.to_path_buf()
        } else {
            let names = std::fs::read_dir(dir.join("versions"))
                .ok()?
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .filter_map(|entry| entry.file_name().into_string().ok());
            dir.join("versions").join(latest_cursor_version(names)?)
        };
        let program = version_dir.join("node.exe");
        let script = version_dir.join("index.js");
        if !program.is_file() || !script.is_file() {
            return None;
        }
        let mut envs = vec![(
            "CURSOR_INVOKED_AS".to_string(),
            path.file_name().map(OsString::from).unwrap_or_default(),
        )];
        if std::env::var_os("NODE_COMPILE_CACHE").is_none() {
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                envs.push(("NODE_COMPILE_CACHE".to_string(), PathBuf::from(local).join("cursor-compile-cache").into_os_string()));
            }
        }
        return Some(ShimTarget { program, leading: vec![script.into_os_string()], envs });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const NPM_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";

    #[test]
    fn reads_the_script_from_an_npm_shim() {
        assert_eq!(npm_shim_script(NPM_SHIM).as_deref(), Some("node_modules\\@openai\\codex\\bin\\codex.js"));
        assert_eq!(npm_shim_script("@echo off\r\n\"%~dp0\\node_modules\\x\\cli.js\" %*").as_deref(), Some("node_modules\\x\\cli.js"));
        assert_eq!(npm_shim_script("@echo off\r\necho hi"), None);
        assert_eq!(npm_shim_script("\"%dp0%\\..\\evil.js\" %*"), None);
    }

    #[test]
    fn picks_the_newest_cursor_version() {
        let names = ["2026.09.15-d2fe57e", "2026.10.19-6bbf2c4", "2026.10.2-aaaa", "promote-staged.cmd", "notes"];
        assert_eq!(latest_cursor_version(names.map(String::from)).as_deref(), Some("2026.10.19-6bbf2c4"));
        let stamped = ["2026.10.19-01-00-00-aaaa", "2026.10.19-23-00-00-bbbb"];
        assert_eq!(latest_cursor_version(stamped.map(String::from)).as_deref(), Some("2026.10.19-23-00-00-bbbb"));
        assert_eq!(latest_cursor_version(Vec::new()), None);
    }
}
