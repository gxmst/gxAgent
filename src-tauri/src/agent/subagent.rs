use super::dsml::{parse_dsml_tool_calls, strip_dsml_tags};
use super::state::{
    await_with_cancel, ensure_not_cancelled, AGENT_CANCELLED_ERROR, SUBAGENT_SLOTS,
};
use super::stream::{
    assistant_message_with_tool_calls, emit_request_event, normalize_tool_calls,
    send_model_request_with_retry, AccumulatedToolCall,
};
use crate::config::AppConfig;
use crate::provider;
use crate::tools::{execute_tool_with_control, get_enabled_tool_definitions, TOOL_CANCELLED_ERROR};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tauri::Window;
use tokio::sync::watch;

const SUBAGENT_MAX_TURNS: usize = 10;
const SUBAGENT_MAX_TOOL_CALLS: usize = 30;
const SUBAGENT_READ_ONLY_TOOLS: &[&str] = &[
    "read_file",
    "grep",
    "glob",
    "list_dir",
    "get_current_time",
    "web_search",
    "web_fetch",
];

pub(super) fn allowed_subagent_tool_names(config: &AppConfig) -> Vec<String> {
    config
        .tools_enabled
        .iter()
        .filter(|name| SUBAGENT_READ_ONLY_TOOLS.contains(&name.as_str()))
        .cloned()
        .collect()
}

pub(super) fn allowed_subagent_tool_definitions(config: &AppConfig) -> Vec<Value> {
    let names = allowed_subagent_tool_names(config);
    get_enabled_tool_definitions(&names)
}

async fn run_subagent_turn(
    window: &Window,
    request_id: &str,
    client: &reqwest::Client,
    child_config: &AppConfig,
    messages: &[Value],
    tools: &[Value],
    cancel_rx: &watch::Receiver<bool>,
) -> Result<(String, Vec<AccumulatedToolCall>), String> {
    let wire = provider::Wire::from_config(child_config);
    let body = provider::build_body(
        wire,
        &child_config.model,
        messages,
        tools,
        child_config,
        false,
    );
    let url = provider::build_url(wire, &child_config.base_url, &child_config.model, false);
    let builder = provider::apply_auth(wire, client.post(&url), &child_config.api_key);
    let response =
        send_model_request_with_retry(window, request_id, cancel_rx, builder.json(&body)).await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Subagent API error ({}): {}", status, text));
    }
    let response_body: Value = await_with_cancel(cancel_rx, response.json())
        .await?
        .map_err(|error| format!("Failed to parse subagent response: {}", error))?;
    let (mut content, _reasoning, mut tool_calls, _prompt_tokens, _completion_tokens) =
        provider::parse_full_response(wire, &response_body);
    if wire == provider::Wire::OpenAI && tool_calls.is_empty() && content.contains("DSML") {
        let dsml_calls = parse_dsml_tool_calls(&content);
        if !dsml_calls.is_empty() {
            content = strip_dsml_tags(&content);
            tool_calls = dsml_calls;
        }
    }
    normalize_tool_calls(&mut tool_calls);
    Ok((content, tool_calls))
}

/// Run a bounded, multi-turn read-only subagent with codebase & web inspection tools.
pub(super) async fn run_spawn_agent(
    window: &Window,
    request_id: &str,
    args_str: &str,
    config: &AppConfig,
    cancel_rx: &watch::Receiver<bool>,
) -> Result<String, String> {
    let permit = SUBAGENT_SLOTS.clone().try_acquire_owned().map_err(|_| {
        "The subagent concurrency limit (3) is already in use. Continue this task directly."
            .to_string()
    })?;
    let args: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
    let task = args["task"].as_str().unwrap_or("").trim();
    if task.is_empty() {
        drop(permit);
        return Err("spawn_agent requires a non-empty task.".to_string());
    }
    let context_hint = args["context_hint"].as_str().unwrap_or("").trim();

    let allowed_names = allowed_subagent_tool_names(config);
    let tool_defs = allowed_subagent_tool_definitions(config);
    let tool_summary = if allowed_names.is_empty() {
        "none".to_string()
    } else {
        allowed_names.join(", ")
    };

    let child_system = format!(
        "You are a focused gxAgent read-only research subagent working in `{}`. Investigate the bounded task below autonomously across up to {} turns using only your enabled read-only tools ({}). You cannot modify files, execute shell commands, ask the user questions, or spawn another agent. Verify file paths and symbols directly before reporting them, and return a concise factual summary with concrete findings, risks, and a recommended next step.{}\n\nTask:\n{}",
        if config.default_work_dir.trim().is_empty() {
            "."
        } else {
            config.default_work_dir.trim()
        },
        SUBAGENT_MAX_TURNS,
        tool_summary,
        if context_hint.is_empty() {
            String::new()
        } else {
            format!("\n\nContext hint:\n{}", context_hint)
        },
        task
    );

    let mut messages = vec![
        json!({ "role": "system", "content": child_system }),
        json!({ "role": "user", "content": task }),
    ];

    let mut child_config = config.clone();
    child_config.tools_enabled = allowed_names;
    child_config.streaming = false;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut tool_calls_used: usize = 0;

    for turn in 0..SUBAGENT_MAX_TURNS {
        ensure_not_cancelled(cancel_rx)?;
        emit_request_event(
            window,
            "agent-subagent-progress",
            request_id,
            json!({
                "task": task,
                "turn": turn + 1,
                "maxTurns": SUBAGENT_MAX_TURNS,
                "toolCallsUsed": tool_calls_used,
            }),
        );

        let offer_tools: &[Value] =
            if turn + 1 < SUBAGENT_MAX_TURNS && tool_calls_used < SUBAGENT_MAX_TOOL_CALLS {
                &tool_defs
            } else {
                &[]
            };

        let (content, tool_calls) = run_subagent_turn(
            window,
            request_id,
            &client,
            &child_config,
            &messages,
            offer_tools,
            cancel_rx,
        )
        .await?;

        if tool_calls.is_empty() {
            drop(permit);
            if content.trim().is_empty() {
                return Err("Subagent returned an empty report.".to_string());
            }
            return Ok(content);
        }

        messages.push(assistant_message_with_tool_calls(&content, &tool_calls));

        let mut runnable = Vec::new();
        let mut results_by_id: HashMap<String, String> = HashMap::new();

        for tc in &tool_calls {
            if !SUBAGENT_READ_ONLY_TOOLS.contains(&tc.name.as_str())
                || !child_config.tools_enabled.contains(&tc.name)
            {
                results_by_id.insert(
                    tc.id.clone(),
                    format!(
                        "Error: Tool '{}' is not permitted in a read-only subagent.",
                        tc.name
                    ),
                );
                continue;
            }
            if !serde_json::from_str::<Value>(&tc.arguments).is_ok_and(|v| v.is_object()) {
                results_by_id.insert(
                    tc.id.clone(),
                    "Error: Invalid tool arguments: expected a JSON object".to_string(),
                );
                continue;
            }
            if tool_calls_used >= SUBAGENT_MAX_TOOL_CALLS {
                results_by_id.insert(
                    tc.id.clone(),
                    format!(
                        "Error: Subagent tool-call limit ({}) reached. Summarize your verified findings now.",
                        SUBAGENT_MAX_TOOL_CALLS
                    ),
                );
                continue;
            }
            tool_calls_used += 1;
            runnable.push(tc);
        }

        if !runnable.is_empty() {
            let futures = runnable.iter().map(|tc| {
                let name = tc.name.clone();
                let args = tc.arguments.clone();
                let work_dir = config.default_work_dir.clone();
                let provider = config.search_provider.clone();
                let key = config.search_api_key.clone();
                let timeout = config.command_timeout;
                let cancel = cancel_rx.clone();
                async move {
                    execute_tool_with_control(
                        &name,
                        &args,
                        &work_dir,
                        &provider,
                        &key,
                        timeout,
                        Some(cancel),
                        None,
                    )
                    .await
                }
            });
            let outputs = futures_util::future::join_all(futures).await;
            for (tc, output) in runnable.iter().zip(outputs) {
                if output == TOOL_CANCELLED_ERROR {
                    drop(permit);
                    return Err(AGENT_CANCELLED_ERROR.to_string());
                }
                results_by_id.insert(tc.id.clone(), output);
            }
        }

        for tc in &tool_calls {
            let output = results_by_id
                .remove(&tc.id)
                .unwrap_or_else(|| "Error: Missing tool result".to_string());
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": output
            }));
        }
    }

    drop(permit);
    Err("Subagent exhausted its turn budget without a final report.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subagent_filter_allows_only_enabled_read_only_tools() {
        let config = AppConfig {
            tools_enabled: vec![
                "execute_command".into(),
                "write_file".into(),
                "edit_file".into(),
                "run_python".into(),
                "spawn_agent".into(),
                "todo_write".into(),
                "read_file".into(),
                "grep".into(),
                "web_fetch".into(),
            ],
            ..AppConfig::default()
        };

        let allowed = allowed_subagent_tool_names(&config);
        assert_eq!(allowed, vec!["read_file", "grep", "web_fetch"]);

        let defs = allowed_subagent_tool_definitions(&config);
        let mut def_names: Vec<&str> = defs
            .iter()
            .filter_map(|def| def["function"]["name"].as_str())
            .collect();
        def_names.sort();
        assert_eq!(def_names, vec!["grep", "read_file", "web_fetch"]);
    }
}
