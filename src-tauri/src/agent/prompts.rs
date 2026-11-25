use crate::config::AppConfig;
use serde_json::{json, Value};
use std::path::Path;

// Hard ceilings for the user-configurable limits. These are runaway
// protection, not pacing: stopping an agent mid-task to ask "continue?" is
// worse UX than letting a healthy loop finish, so they are set well above
// what a normal engineering task needs.
const MAX_LOOPS: u32 = 100;
const ABSOLUTE_MAX_TOOL_CALLS_PER_REQUEST: u32 = 500;

pub(super) const SEARCH_FOLLOWUP_INSTRUCTION: &str = "You have just received web search results. You MUST base your answer on these search results. Cite the sources by mentioning the title and link when referencing information. If the search results are insufficient to fully answer the question, clearly state what information is missing and what you could find. Do not make up information not present in the search results.";
const GENERAL_ASSISTANT_INSTRUCTION: &str = "Assistant behavior: Be helpful, careful, and honest. Answer in the user's language when practical. If information is uncertain, outdated, or unavailable, say so clearly. Do not invent facts, citations, files, command results, or tool output. Ask for clarification when the user's goal is ambiguous and a wrong assumption would be risky.";
const DEFAULT_CHAT_SYSTEM_PROMPT: &str = "You are a helpful AI assistant. Be careful, honest, and practical. Answer in the user's language when practical. If you are unsure or lack enough information, say so instead of guessing. When using web search, ground the answer in the search results and cite relevant sources.";
pub(super) const CHAT_READ_ONLY_TOOLS: &[&str] = &[
    "get_current_time",
    "web_search",
    "web_fetch",
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "read_skill",
    "read_background_output",
    "list_background_processes",
    "list_memories",
];
pub(super) const CHAT_MODE_INSTRUCTION: &str = "Ordinary chat has a lightweight read-only tool set: current time, web search, and workspace file inspection. Do not modify files, run commands, run Python, or spawn agents in ordinary chat; those actions require Code mode.";
const ROLE_PRESET_BEGIN_MARKER: &str = "<<<GXAGENT_ACTIVE_ROLE_PRESET_BEGIN>>>";
const ROLE_PRESET_END_MARKER: &str = "<<<GXAGENT_ACTIVE_ROLE_PRESET_END>>>";
const USER_REQUEST_BEGIN_MARKER: &str = "<<<GXAGENT_USER_REQUEST_BEGIN>>>";
const USER_REQUEST_END_MARKER: &str = "<<<GXAGENT_USER_REQUEST_END>>>";

/// Agentic workflow guidance injected only in Code mode. This shapes the
/// explore -> plan -> act -> verify loop that makes tool-using agents reliable,
/// and steers the model toward the dedicated tools over ad-hoc shell commands.
const CODE_MODE_INSTRUCTION: &str = "Code mode workflow — follow this loop for engineering tasks:\n\
1. Explore before acting. Understand the existing code before changing it. Use grep to find symbols/usages, glob to discover files, and read_file to inspect them. Do not guess at file contents or APIs — verify them.\n\
2. Plan for non-trivial work. For any task beyond a one-line change, briefly outline the steps first. Use the todo_write tool to track multi-step tasks so progress stays visible; mark each step in_progress before starting it and completed when done.\n\
3. Prefer precise edits. Use edit_file for modifying existing files (exact string replacement) instead of rewriting whole files with write_file. Reserve write_file for creating new files. Match existing code style, naming, and libraries.\n\
4. Prefer dedicated tools over shell. Use read_file/grep/glob/edit_file rather than running cat/findstr/Select-String through execute_command — they are faster, workspace-sandboxed, and never interrupt the user with approval prompts.\n\
5. Verify your work. After changes, run the project's build/test/lint where possible and fix what you broke before reporting done. State what you verified and what you could not.\n\
6. Be honest about outcomes. If a command fails or a step is skipped, say so with the evidence. Do not claim success you did not confirm. When an action is destructive or hard to undo, confirm with the user first.";

/// Sanitize arguments for logging - redact sensitive information
pub(super) fn sanitize_args_for_log(args: &str) -> String {
    let lower = args.to_lowercase();
    if lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("credential")
        || lower.contains("authorization")
        || lower.contains("bearer")
    {
        return "[REDACTED - contains sensitive data]".to_string();
    }
    if args.chars().count() > 200 {
        let truncated: String = args.chars().take(200).collect();
        format!("{}... [truncated]", truncated)
    } else {
        args.to_string()
    }
}

/// Parse search result text into structured sources for frontend display
pub(super) fn parse_search_sources(tool_output: &str) -> Vec<Value> {
    tool_output
        .split("\n---\n")
        .filter_map(|block| {
            let title = block
                .lines()
                .find(|l| l.starts_with("Title:"))
                .map(|l| l.trim_start_matches("Title:").trim().to_string())
                .unwrap_or_default();
            let link = block
                .lines()
                .find(|l| l.starts_with("Link:"))
                .map(|l| l.trim_start_matches("Link:").trim().to_string())
                .unwrap_or_default();
            let snippet = block
                .lines()
                .find(|l| l.starts_with("Snippet:"))
                .map(|l| l.trim_start_matches("Snippet:").trim().to_string())
                .unwrap_or_default();
            if title.is_empty() && snippet.is_empty() {
                None
            } else {
                Some(json!({ "title": title, "link": link, "snippet": snippet }))
            }
        })
        .take(5)
        .collect()
}

pub(super) fn resolve_chat_system_prompt(configured_prompt: &str) -> String {
    if configured_prompt.trim().is_empty() {
        DEFAULT_CHAT_SYSTEM_PROMPT.to_string()
    } else {
        configured_prompt.to_string()
    }
}

/// Some OpenAI-compatible Claude/Kiro gateways silently ignore the canonical
/// system message. Repeat only an explicitly active role preset at user level
/// for the current outbound request. The UI history keeps the original user
/// text, and the leading marker prevents accidental double wrapping.
pub(super) fn prepend_active_role_prompt(user_prompt: &str, role_prompt: Option<&str>) -> String {
    let Some(role_prompt) = role_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    else {
        return user_prompt.to_string();
    };
    if user_prompt
        .trim_start()
        .starts_with(ROLE_PRESET_BEGIN_MARKER)
    {
        return user_prompt.to_string();
    }

    format!(
        "{ROLE_PRESET_BEGIN_MARKER}\nThe following role preset was explicitly selected by the user. Apply it to this response while keeping the user's actual request separate.\n{role_prompt}\n{ROLE_PRESET_END_MARKER}\n\n{USER_REQUEST_BEGIN_MARKER}\n{user_prompt}\n{USER_REQUEST_END_MARKER}"
    )
}

pub(super) fn append_code_mode_instruction(system_prompt: &mut String) {
    system_prompt.push_str("\n\n");
    system_prompt.push_str(CODE_MODE_INSTRUCTION);
}

pub(super) fn append_plan_mode_instruction(system_prompt: &mut String) {
    system_prompt.push_str(
        "\n\nPlan mode is active. Work read-only: inspect the workspace, use todo_write to maintain a concrete plan, and explain the intended changes. Do not write files, run commands, run Python, or call external mutation tools until the user turns plan mode off.",
    );
}

pub(super) fn plan_mode_allows_tool(name: &str) -> bool {
    matches!(
        name,
        "get_current_time"
            | "read_file"
            | "list_dir"
            | "web_search"
            | "web_fetch"
            | "grep"
            | "glob"
            | "todo_write"
            | "spawn_agent"
            | "ask_user_question"
            | "read_skill"
            | "read_background_output"
            | "list_background_processes"
            | "list_memories"
    )
}

pub(super) fn configured_max_agent_loops(config: &AppConfig) -> u32 {
    config.max_agent_loops.clamp(1, MAX_LOOPS)
}

pub(super) fn configured_max_tool_calls(config: &AppConfig) -> u32 {
    config
        .max_tool_calls_per_request
        .clamp(1, ABSOLUTE_MAX_TOOL_CALLS_PER_REQUEST)
}

/// OS-specific shell guidance, appended in code mode so the model uses the
/// correct command syntax for the machine the app is actually running on.
fn shell_guidance() -> &'static str {
    if cfg!(target_os = "windows") {
        "Shell environment: the execute_command tool runs in Windows PowerShell. Use PowerShell syntax, not Unix/bash. Chain commands with ; (not && or ||). Use cmdlets: Get-ChildItem (not ls), Remove-Item (not rm), Copy-Item (not cp). For reading or searching files, prefer the read_file/grep/glob tools over Get-Content/Select-String — the builtin tools never require user approval. Suppress noisy errors with 2>$null. Use Windows-style paths with backslashes."
    } else if cfg!(target_os = "macos") {
        "Shell environment: the execute_command tool runs in a POSIX shell (sh/bash/zsh) on macOS. Use standard Unix syntax: chain commands with && or ;, and use ls, cat, grep, rm, find. Use forward-slash paths."
    } else {
        "Shell environment: the execute_command tool runs in a POSIX shell (sh/bash) on Linux. Use standard Unix syntax: chain commands with && or ;, and use ls, cat, grep, rm, find. Use forward-slash paths."
    }
}

pub(super) fn append_shell_guidance(system_prompt: &mut String) {
    system_prompt.push_str("\n\n");
    system_prompt.push_str(shell_guidance());
}

pub(super) fn search_tool_observation(output: &str) -> String {
    if output.trim_start().starts_with("Error:") {
        format!(
            "{}\n\nThe web search failed. Do not invent search results or citations. Continue from reliable existing context and clearly disclose the search failure when it affects the answer.",
            output
        )
    } else {
        format!("{}\n\n{}", output, SEARCH_FOLLOWUP_INSTRUCTION)
    }
}

/// Add generated context to the current user turn without inserting a late
/// system message. Several OpenAI-compatible relays reject system messages that
/// appear after user/assistant/tool traffic as a malformed request.
pub(super) fn append_to_latest_user_message(messages: &mut [Value], addition: &str) -> bool {
    let Some(message) = messages.iter_mut().rev().find(|msg| msg["role"] == "user") else {
        return false;
    };

    match &mut message["content"] {
        Value::String(content) => {
            if !content.is_empty() {
                content.push_str("\n\n");
            }
            content.push_str(addition);
            true
        }
        Value::Array(parts) => {
            parts.push(json!({ "type": "text", "text": addition }));
            true
        }
        _ => false,
    }
}

pub(super) fn append_general_assistant_instruction(system_prompt: &mut String) {
    system_prompt.push_str("\n\n");
    system_prompt.push_str(GENERAL_ASSISTANT_INSTRUCTION);
}

fn normalized_thinking_level(level: &str) -> &'static str {
    if level.eq_ignore_ascii_case("low") {
        "low"
    } else if level.eq_ignore_ascii_case("high") {
        "high"
    } else {
        "medium"
    }
}

fn thinking_instruction(level: &str) -> &'static str {
    match normalized_thinking_level(level) {
        "low" => "Reasoning effort: low. Prefer direct answers and avoid unnecessary exploration unless the task clearly requires it.",
        "high" => "Reasoning effort: high. Spend more internal effort on planning, edge cases, and verification, but do not reveal hidden chain-of-thought.",
        _ => "Reasoning effort: medium. Balance speed with enough internal checking for correctness, and do not reveal hidden chain-of-thought.",
    }
}

pub(super) fn append_thinking_instruction(system_prompt: &mut String, level: &str) {
    system_prompt.push_str("\n\n");
    system_prompt.push_str(thinking_instruction(level));
}

fn supports_reasoning_effort(config: &AppConfig) -> bool {
    let base_url = config.base_url.to_ascii_lowercase();
    let model = config.model.to_ascii_lowercase();
    let is_openai = base_url.contains("api.openai.com") || base_url.contains("openai.azure.com");
    is_openai
        && (model.starts_with("o1")
            || model.starts_with("o3")
            || model.starts_with("o4")
            || model.starts_with("gpt-5"))
}

pub(super) fn apply_reasoning_effort(
    request_body: &mut Value,
    config: &AppConfig,
    is_ollama: bool,
) {
    if is_ollama || !supports_reasoning_effort(config) {
        return;
    }
    request_body["reasoning_effort"] = json!(normalized_thinking_level(&config.thinking_level));
}

pub(super) fn load_workspace_rules(work_dir: &str) -> Option<(String, String)> {
    let start_path = Path::new(work_dir);
    let rule_files = [".gxagent.md", "AGENTS.md", "CLAUDE.md"];

    let mut current = Some(start_path);
    while let Some(dir) = current {
        for filename in &rule_files {
            let rule_path = dir.join(filename);
            if rule_path.exists() && rule_path.is_file() {
                if let Ok(content) = std::fs::read_to_string(&rule_path) {
                    let name = filename.to_string();
                    return Some((content, name));
                }
            }
        }
        current = dir.parent();
    }
    None
}

#[cfg(test)]
mod role_prompt_tests {
    use super::*;

    #[test]
    fn chat_system_prompt_preserves_tool_related_role_text() {
        for prompt in [
            "You are a PowerShell specialist.",
            "Explain when to use execute_command.",
            "You can coordinate with local tools when useful.",
        ] {
            assert_eq!(resolve_chat_system_prompt(prompt), prompt);
        }
    }

    #[test]
    fn chat_system_prompt_falls_back_only_when_empty() {
        assert_eq!(resolve_chat_system_prompt(""), DEFAULT_CHAT_SYSTEM_PROMPT);
        assert_eq!(
            resolve_chat_system_prompt("  \n\t"),
            DEFAULT_CHAT_SYSTEM_PROMPT
        );
    }

    #[test]
    fn active_role_is_wrapped_before_the_current_user_request() {
        let wrapped = prepend_active_role_prompt("Who are you?", Some("You are Little Orange."));

        assert!(wrapped.starts_with(ROLE_PRESET_BEGIN_MARKER));
        assert!(wrapped.contains("You are Little Orange."));
        assert!(wrapped.contains(&format!(
            "{USER_REQUEST_BEGIN_MARKER}\nWho are you?\n{USER_REQUEST_END_MARKER}"
        )));
        assert!(wrapped.find(ROLE_PRESET_END_MARKER) < wrapped.find(USER_REQUEST_BEGIN_MARKER));
    }

    #[test]
    fn inactive_or_empty_role_does_not_modify_the_user_request() {
        assert_eq!(prepend_active_role_prompt("hello", None), "hello");
        assert_eq!(prepend_active_role_prompt("hello", Some(" \n ")), "hello");
    }

    #[test]
    fn already_wrapped_request_is_not_wrapped_again() {
        let once = prepend_active_role_prompt("hello", Some("role"));
        let twice = prepend_active_role_prompt(&once, Some("role"));

        assert_eq!(twice, once);
        assert_eq!(twice.matches(ROLE_PRESET_BEGIN_MARKER).count(), 1);
    }

    #[test]
    fn generated_search_context_is_appended_to_the_latest_user_turn() {
        let mut messages = vec![
            json!({ "role": "system", "content": "system" }),
            json!({ "role": "user", "content": "question" }),
        ];
        assert!(append_to_latest_user_message(
            &mut messages,
            "search context"
        ));
        assert_eq!(messages[1]["content"], "question\n\nsearch context");
        assert_eq!(
            messages
                .iter()
                .filter(|message| message["role"] == "system")
                .count(),
            1
        );
    }

    #[test]
    fn generated_search_context_preserves_multimodal_user_parts() {
        let mut messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "question" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA==" } }
            ]
        })];
        assert!(append_to_latest_user_message(
            &mut messages,
            "search context"
        ));
        let parts = messages[0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[2]["text"], "search context");
    }

    #[test]
    fn search_tool_observation_carries_grounding_instruction_in_tool_content() {
        let observation = search_tool_observation("Title: Source\nLink: https://example.com");
        assert!(observation.contains("Title: Source"));
        assert!(observation.contains(SEARCH_FOLLOWUP_INSTRUCTION));
    }

    #[test]
    fn failed_search_observation_forbids_invented_results() {
        let observation = search_tool_observation("Error: Tavily API error (503)");
        assert!(observation.contains("search failed"));
        assert!(observation.contains("Do not invent search results"));
        assert!(!observation.contains("MUST base your answer on these search results"));
    }
}
