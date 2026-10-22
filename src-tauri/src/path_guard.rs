use std::fs;
use std::path::{Component, Path, PathBuf};

pub fn normalize_for_compare(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let trimmed = raw
        .strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix("//?/"))
        .unwrap_or(raw.as_ref());
    PathBuf::from(trimmed)
}

/// `fs::canonicalize` on Windows returns `\\?\C:\...`, which cmd.exe cannot use as a
/// working directory. Keep plain drive paths; leave `\\?\UNC\...` untouched.
pub fn without_verbatim_drive_prefix(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    match raw.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

pub fn is_path_within(root: &Path, candidate: &Path) -> bool {
    let root = normalize_for_compare(root);
    let candidate = normalize_for_compare(candidate);
    candidate == root || candidate.starts_with(&root)
}

fn component_names(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect()
}

fn is_drive_or_unix_root(path: &Path) -> bool {
    let comps: Vec<_> = path.components().collect();
    matches!(
        comps.as_slice(),
        [Component::Prefix(_), Component::RootDir]
            | [Component::RootDir]
            | [Component::Prefix(_)]
    )
}

pub fn is_blocked_system_path(path: &Path) -> bool {
    if is_drive_or_unix_root(path) {
        return true;
    }
    let names = component_names(path);
    if names.is_empty() {
        return true;
    }
    let first = names[0].as_str();
    if matches!(
        first,
        "windows"
            | "program files"
            | "program files (x86)"
            | "etc"
            | "bin"
            | "sbin"
            | "system"
            | "proc"
            | "dev"
            | "sys"
            | "boot"
            | "root"
    ) {
        return true;
    }
    if first == "usr" && names.get(1).is_some_and(|next| next != "local") {
        return true;
    }
    if names.windows(2).any(|pair| {
        pair[0] == "windows" && matches!(pair[1].as_str(), "system32" | "syswow64" | "sysnative")
    }) {
        return true;
    }
    names
        .iter()
        .any(|name| matches!(name.as_str(), ".ssh" | ".gnupg" | ".aws"))
}

pub fn is_secret_filename(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    matches!(
        name.as_str(),
        "keys.env"
            | ".env"
            | ".env.local"
            | "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
            | "credentials.json"
            | "service-account.json"
            | "service_account.json"
            | "auth.json"
            | ".claude.json"
    ) || name.starts_with(".env.")
        || name.ends_with(".pem")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || (name.ends_with(".key") && name != "license.key")
}

pub fn assert_inspectable_path(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("파일 경로가 비어 있습니다.".to_string());
    }
    if is_blocked_system_path(path) || is_secret_filename(path) {
        return Err("이 경로는 검사하거나 첨부할 수 없습니다.".to_string());
    }
    if !path.exists() {
        return Ok(path.to_path_buf());
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        format!("파일 경로를 확인할 수 없습니다: {} ({error})", path.display())
    })?;
    if is_blocked_system_path(&canonical) || is_secret_filename(&canonical) {
        return Err("이 경로는 검사하거나 첨부할 수 없습니다.".to_string());
    }
    Ok(canonical)
}

pub fn assert_project_dir_allowed(path: &Path) -> Result<(), String> {
    if is_drive_or_unix_root(path) {
        return Err("드라이브 루트는 작업 공간으로 사용할 수 없습니다.".to_string());
    }
    if is_blocked_system_path(path) {
        return Err("시스템 폴더는 작업 공간으로 사용할 수 없습니다.".to_string());
    }
    let names = component_names(path);
    if names.len() == 1 && matches!(names[0].as_str(), "users" | "home") {
        return Err("사용자 폴더 루트는 작업 공간으로 사용할 수 없습니다.".to_string());
    }
    Ok(())
}

pub fn agent_binary_name_allowed(binary_names: &[&str], path: &Path) -> bool {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if stem.is_empty() {
        return false;
    }
    if matches!(
        stem.as_str(),
        "cmd"
            | "powershell"
            | "pwsh"
            | "wscript"
            | "cscript"
            | "mshta"
            | "rundll32"
            | "regsvr32"
            | "bash"
            | "sh"
            | "python"
            | "pythonw"
            | "node"
    ) {
        return false;
    }
    binary_names.iter().any(|name| {
        let allowed = name.to_ascii_lowercase();
        stem == allowed
    })
}

pub fn assert_agent_binary_path(binary_names: &[&str], path: &Path) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err(format!("실행 파일을 찾을 수 없습니다: {}", path.display()));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        format!("실행 파일 경로 확인 실패: {} ({error})", path.display())
    })?;
    if canonical
        .components()
        .any(|part| part.as_os_str() == "System32" || part.as_os_str() == "SysWOW64")
    {
        return Err("시스템 폴더의 실행 파일은 Agent로 지정할 수 없습니다.".to_string());
    }
    #[cfg(windows)]
    {
        let ext = canonical
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(ext.as_str(), "exe" | "cmd" | "bat") {
            return Err("허용되지 않는 실행 파일 형식입니다. .exe / .cmd / .bat 만 지정할 수 있습니다.".to_string());
        }
    }
    if !agent_binary_name_allowed(binary_names, &canonical) {
        return Err(format!(
            "이 파일은 해당 Agent CLI가 아닙니다. 허용 이름: {}",
            binary_names.join(", ")
        ));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_windows_system_paths() {
        #[cfg(windows)]
        assert!(is_blocked_system_path(Path::new(r"C:\Windows\System32\config\SAM")));
        assert!(is_blocked_system_path(Path::new("/etc/passwd")));
        assert!(is_secret_filename(Path::new("/tmp/keys.env")));
        assert!(!is_blocked_system_path(Path::new(r"E:\AI\repo")));
    }

    #[test]
    fn allows_known_agent_names_only() {
        assert!(agent_binary_name_allowed(&["claude"], Path::new("claude.exe")));
        assert!(agent_binary_name_allowed(&["cursor-agent", "agent"], Path::new("cursor-agent.cmd")));
        assert!(!agent_binary_name_allowed(&["claude"], Path::new("cmd.exe")));
        assert!(!agent_binary_name_allowed(&["claude"], Path::new("powershell.exe")));
    }
}
