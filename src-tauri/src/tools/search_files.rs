use super::fs::{resolve_path, FILE_SIZE_LIMIT};
use std::path::PathBuf;

/// Directories that are never worth walking for grep/glob — noise and huge.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode",
];

const GREP_MAX_MATCHES: usize = 200;
const GLOB_MAX_RESULTS: usize = 500;

fn should_skip_dir(entry: &walkdir::DirEntry) -> bool {
    entry.file_type().is_dir()
        && entry
            .file_name()
            .to_str()
            .map(|n| SKIP_DIRS.contains(&n))
            .unwrap_or(false)
}

/// Translate a simple glob pattern into a regex.
pub(super) fn glob_to_regex(glob: &str) -> Result<regex::Regex, String> {
    let mut re = String::from("(?i)^");
    let mut chars = glob.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    if chars.peek() == Some(&'/') {
                        chars.next();
                    }
                    re.push_str(".*");
                } else {
                    re.push_str("[^/\\\\]*");
                }
            }
            '?' => re.push_str("[^/\\\\]"),
            '{' => re.push('('),
            '}' => re.push(')'),
            ',' => re.push('|'),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '[' | ']' => {
                re.push('\\');
                re.push(c);
            }
            '/' => re.push_str("[/\\\\]"),
            _ => re.push(c),
        }
    }
    re.push('$');
    regex::Regex::new(&re).map_err(|e| format!("Invalid glob pattern: {}", e))
}

pub(super) async fn run_grep(
    pattern: &str,
    path: &str,
    glob: Option<&str>,
    case_insensitive: bool,
    work_dir: &str,
) -> Result<String, String> {
    if pattern.is_empty() {
        return Err("pattern must not be empty.".into());
    }
    let root = resolve_path(path, work_dir)?;

    let re = regex::RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| format!("Invalid regex pattern: {}", e))?;

    let name_re = match glob {
        Some(g) if !g.is_empty() => Some(glob_to_regex(g)?),
        _ => None,
    };

    let root_path = PathBuf::from(&root);
    let root_is_file = root_path.is_file();
    let root_clone = root_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut out = String::new();
        let mut match_count = 0usize;
        let mut files_with_matches = 0usize;
        'walk: for entry in walkdir::WalkDir::new(&root_clone)
            .into_iter()
            .filter_entry(|e| !should_skip_dir(e))
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let entry_path = entry.path();
            let rel = if root_is_file {
                entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| entry_path.to_string_lossy().to_string())
            } else {
                entry_path
                    .strip_prefix(&root_clone)
                    .unwrap_or(entry_path)
                    .to_string_lossy()
                    .replace('\\', "/")
            };
            if let Some(nre) = &name_re {
                let fname = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if !nre.is_match(fname) && !nre.is_match(&rel) {
                    continue;
                }
            }
            if let Ok(meta) = entry_path.metadata() {
                if meta.len() as usize > FILE_SIZE_LIMIT {
                    continue;
                }
            }
            let content = match std::fs::read_to_string(entry_path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let mut file_hit = false;
            for (lineno, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    file_hit = true;
                    let trimmed: String = line.chars().take(300).collect();
                    out.push_str(&format!("{}:{}:{}\n", rel, lineno + 1, trimmed.trim_end()));
                    match_count += 1;
                    if match_count >= GREP_MAX_MATCHES {
                        out.push_str(&format!(
                            "\n[Truncated at {} matches. Narrow the pattern or path.]",
                            GREP_MAX_MATCHES
                        ));
                        break 'walk;
                    }
                }
            }
            if file_hit {
                files_with_matches += 1;
            }
        }
        (out, match_count, files_with_matches)
    })
    .await
    .map_err(|e| format!("grep task failed: {}", e))?;

    let (out, match_count, files_with_matches) = result;
    if match_count == 0 {
        Ok(format!("No matches for /{}/.", pattern))
    } else {
        Ok(format!(
            "{} match(es) in {} file(s):\n{}",
            match_count, files_with_matches, out
        ))
    }
}

pub(super) async fn run_glob(pattern: &str, path: &str, work_dir: &str) -> Result<String, String> {
    if pattern.is_empty() {
        return Err("pattern must not be empty.".into());
    }
    let root = resolve_path(path, work_dir)?;
    let re = glob_to_regex(pattern)?;

    let root_clone = root.clone();
    let matches = tokio::task::spawn_blocking(move || {
        let mut found: Vec<String> = Vec::new();
        for entry in walkdir::WalkDir::new(&root_clone)
            .into_iter()
            .filter_entry(|e| !should_skip_dir(e))
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let entry_path = entry.path();
            let rel = entry_path
                .strip_prefix(&root_clone)
                .unwrap_or(entry_path)
                .to_string_lossy()
                .replace('\\', "/");
            if re.is_match(&rel) {
                found.push(rel);
                if found.len() >= GLOB_MAX_RESULTS {
                    break;
                }
            }
        }
        found
    })
    .await
    .map_err(|e| format!("glob task failed: {}", e))?;

    if matches.is_empty() {
        Ok(format!("No files match '{}'.", pattern))
    } else {
        Ok(format!(
            "{} file(s):\n{}",
            matches.len(),
            matches.join("\n")
        ))
    }
}
