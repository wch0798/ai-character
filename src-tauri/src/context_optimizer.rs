use crate::process_util::find_tool;
use crate::policy_engine::mask_secrets;
use crate::settings::load_settings;
use crate::workspace::{ensure_project_snapshot, is_sensitive_file_name, should_exclude};
use crate::workspace_changes::{list_workspace_changes, workspace_file_diff};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_KEYWORDS: usize = 10;
const MAX_FILES: usize = 6;
const MAX_WALK_FILES: usize = 5_000;
const MAX_BLOCK_CHARS: usize = 2_500;
const DEFAULT_CONTEXT_CHARS: usize = 12_000;
const DIFF_SHARE: f64 = 0.35;

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than", "make", "add",
    "fix", "use", "using", "please", "file", "files", "code", "should", "must", "will", "can", "not",
    "all", "any", "are", "was", "were", "have", "has", "new", "old", "about", "task", "work", "only",
    "return", "json", "user", "request", "implement", "update", "change", "create",
];

const TEXT_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java", "kt", "swift", "c", "h", "cpp",
    "hpp", "cs", "rb", "php", "vue", "svelte", "html", "css", "scss", "json", "toml", "yaml", "yml",
    "md", "sh", "sql",
];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContext {
    pub context: String,
    pub fingerprint: String,
    pub files: Vec<String>,
    pub keywords: Vec<String>,
    pub used_ripgrep: bool,
    pub changed_files: usize,
}

/// Keeps the head and tail of long output so errors at either end survive.
pub fn limit_output(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars {
        return text.to_string();
    }
    let marker_budget = 40;
    let keep = max_chars.saturating_sub(marker_budget);
    let head = keep * 6 / 10;
    let tail = keep - head;
    let head_text: String = text.chars().take(head).collect();
    let tail_text: String = text.chars().skip(total - tail).collect();
    format!("{head_text}\n... [{} chars omitted] ...\n{tail_text}", total - head - tail)
}

fn is_code_like(token: &str) -> bool {
    token.contains('_')
        || token.contains('.')
        || token.chars().skip(1).any(|ch| ch.is_ascii_uppercase())
}

pub fn extract_keywords(query: &str) -> Vec<String> {
    let mut code_like = Vec::new();
    let mut plain = Vec::new();
    let mut seen = BTreeSet::new();
    for raw in query.split(|ch: char| !(ch.is_alphanumeric() || ch == '_' || ch == '.')) {
        let token = raw.trim_matches('.');
        let ascii = token.is_ascii();
        let long_enough = if ascii { token.len() >= 3 } else { token.chars().count() >= 2 };
        if !long_enough || token.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }
        let lower = token.to_lowercase();
        if STOPWORDS.contains(&lower.as_str()) || !seen.insert(lower) {
            continue;
        }
        if is_code_like(token) {
            code_like.push(token.to_string());
        } else if ascii {
            plain.push(token.to_string());
        }
    }
    code_like.extend(plain);
    code_like.truncate(MAX_KEYWORDS);
    code_like
}

fn has_text_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| TEXT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn eligible(relative: &str) -> bool {
    let parts: Vec<&str> = relative.split('/').collect();
    if parts.iter().any(|part| should_exclude(part) || part.starts_with('.')) {
        return false;
    }
    let name = parts.last().copied().unwrap_or_default();
    !is_sensitive_file_name(name) && has_text_extension(Path::new(name))
}

fn relative_of(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok()?.to_str().map(|value| value.replace('\\', "/"))
}

fn search_with_ripgrep(root: &Path, keywords: &[String]) -> Option<BTreeMap<String, usize>> {
    let rg = find_tool("rg")?;
    let mut command = Command::new(rg);
    #[cfg(windows)]
    {
        crate::windows_process::hide_console(&mut command);
    }
    command
        .arg("--count-matches")
        .arg("--ignore-case")
        .arg("--fixed-strings")
        .arg("--no-messages")
        .arg("--max-filesize")
        .arg("512K");
    for excluded in ["node_modules", "target", "dist", "build", ".venv", "venv", ".ai-character"] {
        command.arg("--glob").arg(format!("!{excluded}"));
    }
    for keyword in keywords {
        command.arg("-e").arg(keyword);
    }
    let output = command.arg(".").current_dir(root).stdin(Stdio::null()).output().ok()?;
    // rg exits 1 when nothing matched; anything else is a real failure.
    if !output.status.success() && output.status.code() != Some(1) {
        return None;
    }
    let mut hits = BTreeMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some((path, count)) = line.rsplit_once(':') else { continue };
        let relative = normalize_rg_path(path);
        if let (true, Ok(count)) = (eligible(&relative), count.trim().parse::<usize>()) {
            hits.insert(relative, count);
        }
    }
    Some(hits)
}

/// rg prints `.\src\a.ts` on Windows and `./src/a.ts` elsewhere.
fn normalize_rg_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

fn walk_files(root: &Path, current: &Path, output: &mut Vec<PathBuf>) {
    if output.len() >= MAX_WALK_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(current) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_exclude(&name) || name.starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            walk_files(root, &path, output);
        } else if kind.is_file() {
            output.push(path);
            if output.len() >= MAX_WALK_FILES {
                return;
            }
        }
    }
}

fn search_with_walk(root: &Path, keywords: &[String]) -> BTreeMap<String, usize> {
    let lowered: Vec<String> = keywords.iter().map(|keyword| keyword.to_lowercase()).collect();
    let mut files = Vec::new();
    walk_files(root, root, &mut files);
    let mut hits = BTreeMap::new();
    for path in files {
        let Some(relative) = relative_of(root, &path) else { continue };
        if !eligible(&relative) {
            continue;
        }
        if fs::metadata(&path).map(|meta| meta.len() > MAX_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let text = text.to_lowercase();
        let count: usize = lowered.iter().map(|keyword| text.matches(keyword.as_str()).count()).sum();
        if count > 0 {
            hits.insert(relative, count);
        }
    }
    hits
}

fn rank_files(hits: BTreeMap<String, usize>, keywords: &[String]) -> Vec<String> {
    let lowered: Vec<String> = keywords.iter().map(|keyword| keyword.to_lowercase()).collect();
    let mut ranked: Vec<(String, usize)> = hits
        .into_iter()
        .map(|(path, count)| {
            let lower = path.to_lowercase();
            let name_bonus = lowered.iter().filter(|keyword| lower.contains(keyword.as_str())).count() * 20;
            (path, count + name_bonus)
        })
        .collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.into_iter().take(MAX_FILES).map(|(path, _)| path).collect()
}

fn language_for(path: &str) -> Option<tree_sitter::Language> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "ts" | "mts" | "cts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" | "js" | "jsx" | "mjs" | "cjs" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "py" => tree_sitter_python::LANGUAGE.into(),
        _ => return None,
    })
}

fn is_block_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "generator_function_declaration"
            | "method_definition"
            | "lexical_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration"
            | "class_declaration"
            | "function_item"
            | "struct_item"
            | "enum_item"
            | "trait_item"
            | "impl_item"
            | "function_definition"
            | "class_definition"
    )
}

fn contains_keyword(text: &str, lowered: &[String]) -> bool {
    let lower = text.to_lowercase();
    lowered.iter().any(|keyword| lower.contains(keyword.as_str()))
}

/// Selects the innermost declaration blocks mentioning a keyword.
fn collect_blocks(
    node: tree_sitter::Node,
    source: &str,
    lowered: &[String],
    output: &mut Vec<(usize, usize, usize)>,
) -> bool {
    let text = &source[node.start_byte()..node.end_byte()];
    if !contains_keyword(text, lowered) {
        return false;
    }
    let mut selected_child = false;
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        selected_child |= collect_blocks(child, source, lowered, output);
    }
    if selected_child {
        return true;
    }
    if is_block_kind(node.kind()) {
        output.push((node.start_byte(), node.end_byte(), node.start_position().row + 1));
        return true;
    }
    false
}

fn tree_sitter_blocks(path: &str, source: &str, lowered: &[String]) -> Option<Vec<String>> {
    let language = language_for(path)?;
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(source, None)?;
    let mut ranges = Vec::new();
    collect_blocks(tree.root_node(), source, lowered, &mut ranges);
    if ranges.is_empty() {
        return None;
    }
    Some(
        ranges
            .into_iter()
            .map(|(start, end, line)| {
                let block = limit_output(&source[start..end], MAX_BLOCK_CHARS);
                let lines = block.lines().count();
                format!("// {path}:{line}-{}\n{block}", line + lines.saturating_sub(1))
            })
            .collect(),
    )
}

fn line_window_blocks(path: &str, source: &str, lowered: &[String]) -> Vec<String> {
    let lines: Vec<&str> = source.lines().collect();
    let mut windows: Vec<(usize, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !contains_keyword(line, lowered) {
            continue;
        }
        let start = index.saturating_sub(8);
        let end = (index + 9).min(lines.len());
        match windows.last_mut() {
            Some(last) if start <= last.1 => last.1 = end,
            _ => windows.push((start, end)),
        }
    }
    windows
        .into_iter()
        .take(4)
        .map(|(start, end)| {
            let block = limit_output(&lines[start..end].join("\n"), MAX_BLOCK_CHARS);
            format!("// {path}:{}-{}\n{block}", start + 1, end)
        })
        .collect()
}

pub fn relevant_blocks(path: &str, source: &str, keywords: &[String]) -> Vec<String> {
    let lowered: Vec<String> = keywords.iter().map(|keyword| keyword.to_lowercase()).collect();
    tree_sitter_blocks(path, source, &lowered).unwrap_or_else(|| line_window_blocks(path, source, &lowered))
}

fn changes_block(project_root: &Path, conversation_id: &str, budget: usize) -> (String, usize, String) {
    let Ok(changes) = list_workspace_changes(project_root, conversation_id) else {
        return (String::new(), 0, String::new());
    };
    if changes.is_empty() {
        return (String::new(), 0, String::new());
    }
    let mut summary: Vec<String> = changes
        .iter()
        .map(|change| format!("- {:?} {}", change.kind, change.path).to_lowercase())
        .collect();
    summary.truncate(40);
    let mut diffs = String::new();
    for change in changes.iter().filter(|change| !change.binary) {
        if diffs.chars().count() >= budget {
            break;
        }
        if let Ok(diff) = workspace_file_diff(project_root, conversation_id, &change.path) {
            diffs.push_str(&limit_output(&diff, budget / 2));
            diffs.push('\n');
        }
    }
    let block = format!(
        "CHANGES SINCE BASELINE ({} files):\n{}\n{}",
        changes.len(),
        summary.join("\n"),
        limit_output(&diffs, budget)
    );
    (block, changes.len(), diffs)
}

fn workspace_root(conversation_id: Option<&str>) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let settings = load_settings()?;
    let Some(project) = crate::agent_commands::project_dir_for(&settings, conversation_id) else { return Ok(None) };
    let root = match conversation_id {
        Some(id) => ensure_project_snapshot(&project, id)?,
        None => project.clone(),
    };
    Ok(Some((project, root)))
}

pub fn build_context_for_root(
    root: &Path,
    query: &str,
    max_chars: usize,
    changes: Option<(&Path, &str)>,
) -> TaskContext {
    let keywords = extract_keywords(query);
    let diff_budget = (max_chars as f64 * DIFF_SHARE) as usize;
    let (change_text, changed_files, raw_diff) = match changes {
        Some((project, id)) => changes_block(project, id, diff_budget),
        None => (String::new(), 0, String::new()),
    };

    let mut used_ripgrep = false;
    let files = if keywords.is_empty() {
        Vec::new()
    } else {
        let hits = match search_with_ripgrep(root, &keywords) {
            Some(hits) => {
                used_ripgrep = true;
                hits
            }
            None => search_with_walk(root, &keywords),
        };
        rank_files(hits, &keywords)
    };

    let code_budget = max_chars.saturating_sub(change_text.chars().count());
    let mut hasher = Sha256::new();
    hasher.update(raw_diff.as_bytes());
    let mut code = String::new();
    let mut included = Vec::new();
    for relative in &files {
        let Ok(source) = fs::read_to_string(root.join(relative)) else { continue };
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(source.as_bytes());
        for block in relevant_blocks(relative, &source, &keywords) {
            if code.chars().count() + block.chars().count() > code_budget {
                break;
            }
            code.push_str(&block);
            code.push_str("\n\n");
        }
        included.push(relative.clone());
    }

    let mut sections = Vec::new();
    if !code.trim().is_empty() {
        sections.push(format!("RELEVANT CODE (keywords: {}):\n{}", keywords.join(", "), code.trim_end()));
    }
    if !change_text.is_empty() {
        sections.push(change_text);
    }
    let context = mask_secrets(&limit_output(&sections.join("\n\n"), max_chars));
    let fingerprint = if included.is_empty() && raw_diff.is_empty() {
        String::new()
    } else {
        format!("{:x}", hasher.finalize())
    };
    TaskContext { context, fingerprint, files: included, keywords, used_ripgrep, changed_files }
}

#[tauri::command]
pub async fn build_task_context(
    conversation_id: Option<String>,
    query: String,
    max_chars: Option<usize>,
) -> Result<TaskContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = conversation_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
        let Some((project, root)) = workspace_root(id)? else {
            return Ok(TaskContext::default());
        };
        let max_chars = max_chars.unwrap_or(DEFAULT_CONTEXT_CHARS).clamp(1_000, 60_000);
        Ok(build_context_for_root(&root, &query, max_chars, id.map(|id| (project.as_path(), id))))
    })
    .await
    .map_err(|error| format!("컨텍스트 생성 작업 실패: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ctx-opt-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn normalizes_windows_and_unix_rg_paths() {
        assert_eq!(normalize_rg_path(".\\src\\a.ts"), "src/a.ts");
        assert_eq!(normalize_rg_path("./src/a.ts"), "src/a.ts");
        assert!(eligible(&normalize_rg_path(".\\src\\a.ts")));
    }

    #[test]
    fn limit_output_keeps_head_and_tail() {
        let text = format!("HEAD{}TAIL", "x".repeat(5_000));
        let limited = limit_output(&text, 200);
        assert!(limited.starts_with("HEAD"));
        assert!(limited.ends_with("TAIL"));
        assert!(limited.contains("chars omitted"));
        assert!(limited.chars().count() <= 260);
    }

    #[test]
    fn keywords_prefer_identifiers_and_skip_stopwords() {
        let keywords = extract_keywords("Fix the runAutomaticManager order and usage_ledger please");
        assert_eq!(keywords[0], "runAutomaticManager");
        assert_eq!(keywords[1], "usage_ledger");
        assert!(!keywords.iter().any(|keyword| keyword.eq_ignore_ascii_case("the")));
    }

    #[test]
    fn tree_sitter_extracts_only_matching_typescript_function() {
        let source = "function alpha() { return 1; }\n\nexport function targetFn(value: number) {\n  return value * 2;\n}\n\nfunction omega() { return 3; }\n";
        let blocks = relevant_blocks("a.ts", source, &["targetFn".to_string()]);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].contains("targetFn"));
        assert!(!blocks[0].contains("alpha"));
        assert!(!blocks[0].contains("omega"));
    }

    #[test]
    fn tree_sitter_extracts_rust_and_python_blocks() {
        let rust = "fn keep_me() -> u8 { 1 }\nfn other() {}\n";
        let blocks = relevant_blocks("lib.rs", rust, &["keep_me".to_string()]);
        assert!(blocks[0].contains("keep_me") && !blocks[0].contains("other"));
        let python = "def wanted():\n    return 1\n\ndef unrelated():\n    return 2\n";
        let blocks = relevant_blocks("m.py", python, &["wanted".to_string()]);
        assert!(blocks[0].contains("wanted") && !blocks[0].contains("unrelated"));
    }

    #[test]
    fn walk_fallback_finds_files_and_skips_excluded_dirs() {
        let root = temp_dir("walk");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("src/widget.ts"), "const loadWidget = 1; loadWidget;\n").unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "loadWidget\n").unwrap();
        fs::write(root.join(".env"), "loadWidget=1\n").unwrap();
        let hits = search_with_walk(&root, &["loadWidget".to_string()]);
        assert_eq!(hits.keys().cloned().collect::<Vec<_>>(), vec!["src/widget.ts".to_string()]);
        assert_eq!(hits["src/widget.ts"], 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn context_skips_secrets_and_changes_fingerprint_with_source() {
        let root = temp_dir("fingerprint");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.ts"), "export function loadWidget() { return 1; }\n").unwrap();
        fs::write(root.join("keys.env"), "loadWidget=sk-ant-secretvalue123456\n").unwrap();
        let first = build_context_for_root(&root, "loadWidget bug", 4_000, None);
        assert_eq!(first.files, vec!["src/app.ts".to_string()]);
        assert!(first.context.contains("loadWidget"));
        assert!(!first.context.contains("sk-ant-secret"));
        fs::write(root.join("src/app.ts"), "export function loadWidget() { return 2; }\n").unwrap();
        let second = build_context_for_root(&root, "loadWidget bug", 4_000, None);
        assert_ne!(first.fingerprint, second.fingerprint);
        let _ = fs::remove_dir_all(&root);
    }
}
