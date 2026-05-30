use crate::config::AppConfig;
use crate::mcp::McpManager;
use crate::policy::{check_approval, ApprovalLevel};
use crate::tools::{execute_tool_with_timeout, get_enabled_tool_definitions};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Instant;
use tauri::{Emitter, Window};

const MAX_LOOPS: u32 = 20;

static STEERING_QUEUE: once_cell::sync::Lazy<Arc<tokio::sync::Mutex<Vec<String>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(tokio::sync::Mutex::new(Vec::new())));

pub async fn push_steering_message(msg: String) {
    let mut queue = STEERING_QUEUE.lock().await;
    queue.push(msg);
}

async fn drain_steering_messages() -> Vec<String> {
    let mut queue = STEERING_QUEUE.lock().await;
    let messages = queue.drain(..).collect();
    messages
}

fn load_workspace_rules(work_dir: &str) -> Option<(String, String)> {
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

fn estimate_message_tokens(msg: &Value) -> u64 {
    let content = msg["content"].as_str().unwrap_or("");
    (content.len() as u64) / 4
}

fn compact_messages(messages: &mut Vec<Value>, context_limit: usize) {
    if messages.len() <= 6 {
        return;
    }

    let protect_first = 1;
    let protect_last = 4;

    let total_len = messages.len();
    if total_len <= protect_first + protect_last {
        return;
    }

    let mut total_tokens: u64 = 0;
    for msg in messages.iter() {
        total_tokens += estimate_message_tokens(msg);
    }

    let limit_tokens = context_limit as u64 * 4;
    if total_tokens < limit_tokens {
        return;
    }

    for i in protect_first..(total_len - protect_last) {
        let msg = &mut messages[i];
        if msg["role"] == "tool" {
            if let Some(content) = msg["content"].as_str() {
                if content.len() > 800 {
                    let truncated = format!(
                        "⚡[Tool output truncated] Prefix:\n{}\n...\n[{} chars omitted]\n...\nSuffix:\n{}",
                        &content[..400.min(content.len())],
                        content.len().saturating_sub(800),
                        &content[content.len().saturating_sub(400)..]
                    );
                    msg["content"] = json!(truncated);
                }
            }
        } else if msg["role"] == "user" || msg["role"] == "assistant" {
            if let Some(content) = msg["content"].as_str() {
                if content.len() > 2000 {
                    let truncated = format!(
                        "{}\n...\n[{} chars omitted]",
                        &content[..1500.min(content.len())],
                        content.len().saturating_sub(1500)
                    );
                    msg["content"] = json!(truncated);
                }
            }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub approval_level: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolApprovalRequest {
    pub request_id: String,
    pub tool_calls: Vec<PendingToolCall>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AccumulatedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// Core agent loop with streaming and human-in-the-loop approval
pub async fn start_agent_loop(
    window: Window,
    user_prompt: String,
    config: AppConfig,
    session_messages: Vec<Value>,
    session_mode: String,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    if session_mode == "chat" {
        return run_chat_mode(window, client, user_prompt, config, session_messages).await;
    }

    let mut mcp_manager = McpManager::new();
    let mcp_tool_defs = if !config.mcp_servers.is_empty() {
        match mcp_manager.start_all(&config.mcp_servers).await {
            Ok(tools) => {
                let count = tools.len();
                let _ = window.emit("agent-mcp-status", json!({
                    "status": "started",
                    "servers": config.mcp_servers.len(),
                    "tools": count,
                }));
                tools
            }
            Err(e) => {
                let _ = window.emit("agent-mcp-status", json!({
                    "status": "error",
                    "error": e,
                }));
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    let result = start_agent_loop_inner(window, client, user_prompt, config, session_messages, mcp_manager, mcp_tool_defs).await;
    result
}

async fn run_chat_mode(
    window: Window,
    client: reqwest::Client,
    user_prompt: String,
    config: AppConfig,
    session_messages: Vec<Value>,
) -> Result<(), String> {
    let chat_system_prompt = if config.system_prompt.contains("PowerShell") || config.system_prompt.contains("Windows PowerShell") {
        "You are a helpful AI assistant. You can search the web when needed to provide up-to-date information. Be concise, friendly, and helpful. Respond in the same language the user uses.".to_string()
    } else {
        config.system_prompt.clone()
    };

    let mut messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": chat_system_prompt
    })];

    let limit = config.context_limit as usize;
    let limited_messages: Vec<Value> = if session_messages.len() > limit {
        session_messages.into_iter().rev().take(limit).rev().collect()
    } else {
        session_messages
    };
    messages.extend(limited_messages);
    messages.push(json!({
        "role": "user",
        "content": user_prompt
    }));

    let has_web_search = config.tools_enabled.contains(&"web_search".to_string());
    let web_search_tool = json!({
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information. Use this when you need up-to-date information that may not be in your training data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query"
                    }
                },
                "required": ["query"]
            }
        }
    });

    let request_start = Instant::now();
    let is_ollama = config.provider == "ollama";

    let mut request_body = if is_ollama {
        json!({
            "model": config.model,
            "messages": messages,
            "stream": config.streaming,
            "options": {
                "temperature": config.temperature,
                "top_p": config.top_p,
            }
        })
    } else {
        json!({
            "model": config.model,
            "messages": messages,
            "stream": config.streaming,
            "stream_options": {
                "include_usage": true
            }
        })
    };

    if let Some(max_tokens) = config.max_tokens {
        if is_ollama {
            request_body["options"]["num_predict"] = json!(max_tokens);
        } else {
            request_body["max_tokens"] = json!(max_tokens);
        }
    }
    if !is_ollama {
        request_body["temperature"] = json!(config.temperature);
        request_body["top_p"] = json!(config.top_p);
    }

    if has_web_search && !is_ollama {
        request_body["tools"] = json!([web_search_tool]);
        request_body["tool_choice"] = json!("auto");
    }

    let url = if is_ollama {
        format!("{}/api/chat", config.base_url.trim_end_matches('/'))
    } else {
        format!("{}/chat/completions", config.base_url.trim_end_matches('/'))
    };

    let mut request_builder = client
        .post(&url)
        .header("Content-Type", "application/json");

    if !is_ollama && !config.api_key.is_empty() {
        request_builder = request_builder.header(
            "Authorization",
            format!("Bearer {}", config.api_key),
        );
    }

    let response = request_builder
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        let _ = window.emit("agent-error", &error_text);
        return Err(format!("API error ({}): {}", status, error_text));
    }

    if !config.streaming {
        let body: Value = response.json().await.map_err(|e| format!("Parse error: {}", e))?;
        let content = if is_ollama {
            body["message"]["content"].as_str().unwrap_or("").to_string()
        } else {
            body["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string()
        };

        if has_web_search && !is_ollama {
            if let Some(tool_calls) = body["choices"][0]["message"]["tool_calls"].as_array() {
                if !tool_calls.is_empty() {
                    let tool_call = &tool_calls[0];
                    let tool_call_id = tool_call["id"].as_str().unwrap_or("").to_string();
                    let tool_name = tool_call["function"]["name"].as_str().unwrap_or("").to_string();
                    let tool_args = tool_call["function"]["arguments"].as_str().unwrap_or("{}").to_string();

                    let query_display = if let Ok(args) = serde_json::from_str::<Value>(&tool_args) {
                        args["query"].as_str().unwrap_or(&tool_name).to_string()
                    } else {
                        tool_name.clone()
                    };
                    let _ = window.emit("agent-search-status", json!({
                        "type": "searching",
                        "query": query_display,
                    }));
                    let search_start = std::time::Instant::now();

                    let tool_output = execute_tool_with_timeout(
                        &tool_name,
                        &tool_args,
                        &config.default_work_dir,
                        &config.search_provider,
                        &config.search_api_key,
                        config.command_timeout,
                    ).await;

                    let search_elapsed = search_start.elapsed().as_secs_f64();
                    if tool_output.starts_with("Error:") {
                        let _ = window.emit("agent-search-status", json!({
                            "type": "error",
                            "query": query_display,
                            "message": tool_output,
                            "duration": search_elapsed,
                        }));
                    } else {
                        let preview = if tool_output.len() > 500 { &tool_output[..500] } else { &tool_output.clone() };
                        let _ = window.emit("agent-search-status", json!({
                            "type": "results",
                            "query": query_display,
                            "results": preview,
                            "duration": search_elapsed,
                        }));
                    }

                    messages.push(json!({
                        "role": "assistant",
                        "content": null,
                        "tool_calls": tool_calls
                    }));
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": tool_output
                    }));

                    let mut followup_body = json!({
                        "model": config.model,
                        "messages": messages,
                        "stream": false,
                    });
                    if let Some(max_tokens) = config.max_tokens {
                        followup_body["max_tokens"] = json!(max_tokens);
                    }
                    followup_body["temperature"] = json!(config.temperature);
                    followup_body["top_p"] = json!(config.top_p);

                    let followup_response = client
                        .post(&url)
                        .header("Content-Type", "application/json")
                        .header("Authorization", format!("Bearer {}", config.api_key))
                        .json(&followup_body)
                        .send()
                        .await
                        .map_err(|e| format!("Follow-up request failed: {}", e))?;

                    if followup_response.status().is_success() {
                        let followup_body: Value = followup_response.json().await.map_err(|e| format!("Parse error: {}", e))?;
                        let final_content = followup_body["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
                        let _ = window.emit("agent-stream-chunk", &final_content);
                        let _ = window.emit("agent-stream-done", json!({
                            "content": final_content,
                            "loopCount": 2,
                            "ttftMs": request_start.elapsed().as_millis() as u64,
                            "responseTimeMs": request_start.elapsed().as_millis() as u64,
                        }));
                    } else {
                        let _ = window.emit("agent-stream-done", json!({
                            "content": content,
                            "loopCount": 1,
                            "ttftMs": request_start.elapsed().as_millis() as u64,
                            "responseTimeMs": request_start.elapsed().as_millis() as u64,
                        }));
                    }
                    let _ = window.emit("agent-complete", "success");
                    return Ok(());
                }
            }

            // DSML-format tool calls (DeepSeek models)
            if content.contains("DSML") {
                let dsml_calls = parse_dsml_tool_calls(&content);
                if !dsml_calls.is_empty() {
                    eprintln!("[agent] Non-streaming: detected {} DSML tool call(s)", dsml_calls.len());
                    let clean_content = strip_dsml_tags(&content);

                    for tc in &dsml_calls {
                        let query_display = if let Ok(args) = serde_json::from_str::<Value>(&tc.arguments) {
                            args["query"].as_str().unwrap_or(&tc.name).to_string()
                        } else {
                            tc.name.clone()
                        };
                        let _ = window.emit("agent-search-status", json!({
                            "type": "searching",
                            "query": query_display,
                        }));
                        let search_start = std::time::Instant::now();

                        let tool_output = execute_tool_with_timeout(
                            &tc.name,
                            &tc.arguments,
                            &config.default_work_dir,
                            &config.search_provider,
                            &config.search_api_key,
                            config.command_timeout,
                        ).await;

                        let search_elapsed = search_start.elapsed().as_secs_f64();
                        if tool_output.starts_with("Error:") {
                            let _ = window.emit("agent-search-status", json!({
                                "type": "error",
                                "query": query_display,
                                "message": tool_output.clone(),
                                "duration": search_elapsed,
                            }));
                        } else {
                            let preview = if tool_output.len() > 500 { &tool_output[..500] } else { &tool_output.clone() };
                            let _ = window.emit("agent-search-status", json!({
                                "type": "results",
                                "query": query_display,
                                "results": preview,
                                "duration": search_elapsed,
                            }));
                        }

                        messages.push(json!({
                            "role": "assistant",
                            "content": if clean_content.is_empty() { Value::Null } else { json!(clean_content) },
                            "tool_calls": [{ "id": tc.id, "type": "function", "function": { "name": tc.name, "arguments": tc.arguments } }]
                        }));
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": tool_output
                        }));
                    }

                    let mut followup_body = json!({
                        "model": config.model,
                        "messages": messages,
                        "stream": false,
                    });
                    if let Some(max_tokens) = config.max_tokens {
                        followup_body["max_tokens"] = json!(max_tokens);
                    }
                    followup_body["temperature"] = json!(config.temperature);
                    followup_body["top_p"] = json!(config.top_p);

                    let followup_response = client
                        .post(&url)
                        .header("Content-Type", "application/json")
                        .header("Authorization", format!("Bearer {}", config.api_key))
                        .json(&followup_body)
                        .send()
                        .await
                        .map_err(|e| format!("Follow-up request failed: {}", e))?;

                    if followup_response.status().is_success() {
                        let fb: Value = followup_response.json().await.map_err(|e| format!("Parse error: {}", e))?;
                        let final_content = fb["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
                        let _ = window.emit("agent-stream-chunk", &final_content);
                        let _ = window.emit("agent-stream-done", json!({
                            "content": final_content,
                            "loopCount": 2,
                            "ttftMs": request_start.elapsed().as_millis() as u64,
                            "responseTimeMs": request_start.elapsed().as_millis() as u64,
                        }));
                    } else {
                        let _ = window.emit("agent-stream-done", json!({
                            "content": clean_content,
                            "loopCount": 1,
                            "ttftMs": request_start.elapsed().as_millis() as u64,
                            "responseTimeMs": request_start.elapsed().as_millis() as u64,
                        }));
                    }
                    let _ = window.emit("agent-complete", "success");
                    return Ok(());
                }
            }
        }

        let _ = window.emit("agent-stream-done", json!({
            "content": content,
            "loopCount": 1,
            "ttftMs": request_start.elapsed().as_millis() as u64,
            "responseTimeMs": request_start.elapsed().as_millis() as u64,
        }));
        let _ = window.emit("agent-complete", "success");
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut assistant_content = String::new();
    let mut first_content_received = false;
    let mut ttft_ms: Option<u64> = None;
    let mut accumulated_tool_calls: Vec<AccumulatedToolCall> = Vec::new();
    let mut dsml_buffering = false;
    let mut dsml_buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);

        if is_ollama {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() { continue; }
                let json_val: Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(content) = json_val["message"]["content"].as_str() {
                    if !content.is_empty() {
                        if !first_content_received {
                            first_content_received = true;
                            ttft_ms = Some(request_start.elapsed().as_millis() as u64);
                        }
                        assistant_content.push_str(content);
                        if content.contains("DSML") || dsml_buffering {
                            eprintln!("[agent] DSML buffering: chunk contains DSML={}", content.contains("DSML"));
                            dsml_buffering = true;
                            dsml_buffer.push_str(content);
                        } else {
                            let _ = window.emit("agent-stream-chunk", content);
                        }
                    }
                }
                if json_val["done"].as_bool() == Some(true) {
                    if has_web_search && !is_ollama {
                        if let Some(tool_calls) = json_val["message"]["tool_calls"].as_array() {
                            if !tool_calls.is_empty() {
                                for tc in tool_calls {
                                    let tc_id = tc["id"].as_str().unwrap_or("").to_string();
                                    let tc_name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                                    let tc_args = tc["function"]["arguments"].as_str().unwrap_or("{}").to_string();
                                    accumulated_tool_calls.push(AccumulatedToolCall {
                                        id: tc_id,
                                        name: tc_name,
                                        arguments: tc_args,
                                    });
                                }
                            }
                        }
                    }
                    break;
                }
            }
        } else {
            for line in text.lines() {
                let line = line.trim();
                if !line.starts_with("data: ") { continue; }
                let data = &line[6..];
                if data == "[DONE]" {
                    break;
                }
                let json_val: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(content) = json_val["choices"][0]["delta"]["content"].as_str() {
                    if !content.is_empty() {
                        if !first_content_received {
                            first_content_received = true;
                            ttft_ms = Some(request_start.elapsed().as_millis() as u64);
                        }
                        assistant_content.push_str(content);
                        if content.contains("DSML") || dsml_buffering {
                            dsml_buffering = true;
                            dsml_buffer.push_str(content);
                        } else {
                            let _ = window.emit("agent-stream-chunk", content);
                        }
                    }
                }
                if has_web_search {
                    if let Some(delta_tool_calls) = json_val["choices"][0]["delta"]["tool_calls"].as_array() {
                        for dtc in delta_tool_calls {
                            let idx = dtc["index"].as_u64().unwrap_or(0) as usize;
                            while accumulated_tool_calls.len() <= idx {
                                accumulated_tool_calls.push(AccumulatedToolCall {
                                    id: String::new(),
                                    name: String::new(),
                                    arguments: String::new(),
                                });
                            }
                            if let Some(id) = dtc["id"].as_str() {
                                accumulated_tool_calls[idx].id = id.to_string();
                            }
                            if let Some(name) = dtc["function"]["name"].as_str() {
                                accumulated_tool_calls[idx].name = name.to_string();
                            }
                            if let Some(args) = dtc["function"]["arguments"].as_str() {
                                accumulated_tool_calls[idx].arguments.push_str(args);
                            }
                        }
                    }
                }
            }
        }
    }

    // Detect DSML-format tool calls (DeepSeek models)
    if accumulated_tool_calls.is_empty() && dsml_buffering {
        eprintln!("[agent] DSML buffering ended, parsing tool calls from {} bytes", assistant_content.len());
        let dsml_calls = parse_dsml_tool_calls(&assistant_content);
        if !dsml_calls.is_empty() {
            eprintln!("[agent] Detected {} DSML tool call(s)", dsml_calls.len());
            let clean_content = strip_dsml_tags(&assistant_content);
            let buffer_clean = strip_dsml_tags(&dsml_buffer);
            if !buffer_clean.trim().is_empty() {
                let _ = window.emit("agent-stream-chunk", &buffer_clean);
            }
            if has_web_search {
                accumulated_tool_calls = dsml_calls;
            }
            assistant_content = clean_content;
        } else {
            eprintln!("[agent] DSML detected but no tool calls parsed, sending cleaned content");
            let clean_content = strip_dsml_tags(&assistant_content);
            if !clean_content.trim().is_empty() {
                let _ = window.emit("agent-stream-chunk", &clean_content);
            }
            assistant_content = clean_content;
        }
    }

    if has_web_search && !accumulated_tool_calls.is_empty() {
        let mut tool_results: Vec<Value> = Vec::new();
        for tc in &accumulated_tool_calls {
            if tc.name != "web_search" {
                eprintln!("[agent] Skipping unsupported DSML tool: {}", tc.name);
                tool_results.push(json!({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": format!("Error: Tool '{}' is not available. Only web_search is supported. Please answer based on the information you already have.", tc.name)
                }));
                continue;
            }
            let query_display = if let Ok(args) = serde_json::from_str::<Value>(&tc.arguments) {
                args["query"].as_str().unwrap_or("").to_string()
            } else {
                tc.name.clone()
            };
            let _ = window.emit("agent-search-status", json!({
                "type": "searching",
                "query": query_display,
            }));
            let search_start = std::time::Instant::now();
            let tool_output = execute_tool_with_timeout(
                &tc.name,
                &tc.arguments,
                &config.default_work_dir,
                &config.search_provider,
                &config.search_api_key,
                config.command_timeout,
            ).await;
            let search_elapsed = search_start.elapsed();
            eprintln!("[agent] Search '{}' completed in {:.1}s, result length: {}", query_display, search_elapsed.as_secs_f64(), tool_output.len());
            if tool_output.starts_with("Error:") {
                let _ = window.emit("agent-search-status", json!({
                    "type": "error",
                    "query": query_display,
                    "message": tool_output,
                    "duration": search_elapsed.as_secs_f64(),
                }));
            } else {
                let preview = if tool_output.len() > 500 { &tool_output[..500] } else { &tool_output.clone() };
                let _ = window.emit("agent-search-status", json!({
                    "type": "results",
                    "query": query_display,
                    "results": preview,
                    "duration": search_elapsed.as_secs_f64(),
                }));
            }
            tool_results.push(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": tool_output
            }));
        }

        messages.push(json!({
            "role": "assistant",
            "content": if assistant_content.is_empty() { Value::Null } else { json!(assistant_content) },
            "tool_calls": accumulated_tool_calls.iter().map(|tc| {
                json!({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": tc.arguments
                    }
                })
            }).collect::<Vec<_>>()
        }));
        for tr in &tool_results {
            messages.push(tr.clone());
        }

        let mut followup_body = json!({
            "model": config.model,
            "messages": messages,
            "stream": true,
            "stream_options": {
                "include_usage": true
            }
        });
        if let Some(max_tokens) = config.max_tokens {
            followup_body["max_tokens"] = json!(max_tokens);
        }
        followup_body["temperature"] = json!(config.temperature);
        followup_body["top_p"] = json!(config.top_p);

        let followup_response = match client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", config.api_key))
            .json(&followup_body)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                let _ = window.emit("agent-stream-chunk", &format!("\n❌ Follow-up request failed: {}\n", e));
                let _ = window.emit("agent-stream-done", json!({
                    "content": format!("🔍 Search completed but follow-up failed: {}", e),
                    "loopCount": 1,
                    "ttftMs": ttft_ms.unwrap_or(0),
                    "responseTimeMs": request_start.elapsed().as_millis() as u64,
                }));
                let _ = window.emit("agent-complete", "success");
                return Ok(());
            }
        };

        if !followup_response.status().is_success() {
            let status = followup_response.status();
            let error_text = followup_response.text().await.unwrap_or_default();
            let _ = window.emit("agent-stream-chunk", &format!("\n❌ Follow-up API error ({}): {}\n", status, &error_text[..error_text.len().min(300)]));
            let _ = window.emit("agent-stream-done", json!({
                "content": format!("🔍 Search completed but follow-up failed ({}): {}", status, error_text),
                "loopCount": 1,
                "ttftMs": ttft_ms.unwrap_or(0),
                "responseTimeMs": request_start.elapsed().as_millis() as u64,
            }));
            let _ = window.emit("agent-complete", "success");
            return Ok(());
        }

        let mut followup_stream = followup_response.bytes_stream();
        let mut followup_content = String::new();
        let mut followup_dsml_buffering = false;
        let mut followup_dsml_buffer = String::new();

        while let Some(chunk) = followup_stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    let _ = window.emit("agent-stream-chunk", &format!("\n❌ Stream error: {}\n", e));
                    break;
                }
            };
            let text = String::from_utf8_lossy(&chunk);
            for line in text.lines() {
                let line = line.trim();
                if !line.starts_with("data: ") { continue; }
                let data = &line[6..];
                if data == "[DONE]" { break; }
                let json_val: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(content) = json_val["choices"][0]["delta"]["content"].as_str() {
                    if !content.is_empty() {
                        followup_content.push_str(content);
                        if content.contains("DSML") || followup_dsml_buffering {
                            followup_dsml_buffering = true;
                            followup_dsml_buffer.push_str(content);
                        } else {
                            let _ = window.emit("agent-stream-chunk", content);
                        }
                    }
                }
            }
        }

        // Handle DSML in follow-up response
        if followup_dsml_buffering {
            let dsml_calls = parse_dsml_tool_calls(&followup_content);
            let clean_content = strip_dsml_tags(&followup_content);
            let buffer_clean = strip_dsml_tags(&followup_dsml_buffer);
            if !buffer_clean.trim().is_empty() {
                let _ = window.emit("agent-stream-chunk", &buffer_clean);
            }
            followup_content = clean_content;

            if !dsml_calls.is_empty() && has_web_search {
                eprintln!("[agent] Follow-up: detected {} DSML tool call(s)", dsml_calls.len());
                let mut tool_results: Vec<Value> = Vec::new();
                for tc in &dsml_calls {
                    if tc.name != "web_search" {
                        eprintln!("[agent] Skipping unsupported DSML tool: {}", tc.name);
                        tool_results.push(json!({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": format!("Error: Tool '{}' is not available. Only web_search is supported.", tc.name)
                        }));
                        continue;
                    }
                    let query_display = if let Ok(args) = serde_json::from_str::<Value>(&tc.arguments) {
                        args["query"].as_str().unwrap_or(&tc.name).to_string()
                    } else {
                        tc.name.clone()
                    };
                    let _ = window.emit("agent-search-status", json!({
                        "type": "searching",
                        "query": query_display,
                    }));
                    let search_start = std::time::Instant::now();
                    let tool_output = execute_tool_with_timeout(
                        &tc.name,
                        &tc.arguments,
                        &config.default_work_dir,
                        &config.search_provider,
                        &config.search_api_key,
                        config.command_timeout,
                    ).await;
                    let search_elapsed = search_start.elapsed().as_secs_f64();
                    if tool_output.starts_with("Error:") {
                        let _ = window.emit("agent-search-status", json!({
                            "type": "error",
                            "query": query_display,
                            "message": tool_output.clone(),
                            "duration": search_elapsed,
                        }));
                    } else {
                        let preview = if tool_output.len() > 500 { &tool_output[..500] } else { &tool_output.clone() };
                        let _ = window.emit("agent-search-status", json!({
                            "type": "results",
                            "query": query_display,
                            "results": preview,
                            "duration": search_elapsed,
                        }));
                    }
                    tool_results.push(json!({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": tool_output
                    }));
                }

                if !tool_results.is_empty() {
                    messages.push(json!({
                        "role": "assistant",
                        "content": if followup_content.is_empty() { Value::Null } else { json!(followup_content) },
                    }));
                    for tr in &tool_results {
                        messages.push(tr.clone());
                    }

                    let mut second_followup_body = json!({
                        "model": config.model,
                        "messages": messages,
                        "stream": true,
                    });
                    if let Some(max_tokens) = config.max_tokens {
                        second_followup_body["max_tokens"] = json!(max_tokens);
                    }
                    second_followup_body["temperature"] = json!(config.temperature);
                    second_followup_body["top_p"] = json!(config.top_p);

                    let second_followup_response = client
                        .post(&url)
                        .header("Content-Type", "application/json")
                        .header("Authorization", format!("Bearer {}", config.api_key))
                        .json(&second_followup_body)
                        .send()
                        .await
                        .map_err(|e| format!("Second follow-up request failed: {}", e))?;

                    if second_followup_response.status().is_success() {
                        let mut second_stream = second_followup_response.bytes_stream();
                        let mut second_content = String::new();
                        let mut second_dsml_buffering = false;
                        let mut second_dsml_buffer = String::new();

                        while let Some(chunk) = second_stream.next().await {
                            let chunk = match chunk {
                                Ok(c) => c,
                                Err(_) => break,
                            };
                            let text = String::from_utf8_lossy(&chunk);
                            for line in text.lines() {
                                let line = line.trim();
                                if !line.starts_with("data: ") { continue; }
                                let data = &line[6..];
                                if data == "[DONE]" { break; }
                                let json_val: Value = match serde_json::from_str(data) {
                                    Ok(v) => v,
                                    Err(_) => continue,
                                };
                                if let Some(content) = json_val["choices"][0]["delta"]["content"].as_str() {
                                    if !content.is_empty() {
                                        second_content.push_str(content);
                                        if content.contains("DSML") || second_dsml_buffering {
                                            second_dsml_buffering = true;
                                            second_dsml_buffer.push_str(content);
                                        } else {
                                            let _ = window.emit("agent-stream-chunk", content);
                                        }
                                    }
                                }
                            }
                        }

                        if second_dsml_buffering {
                            let clean = strip_dsml_tags(&second_dsml_buffer);
                            if !clean.trim().is_empty() {
                                let _ = window.emit("agent-stream-chunk", &clean);
                            }
                        }

                        let _ = window.emit("agent-stream-done", json!({
                            "content": second_content,
                            "loopCount": 3,
                            "ttftMs": ttft_ms.unwrap_or(0),
                            "responseTimeMs": request_start.elapsed().as_millis() as u64,
                        }));
                        let _ = window.emit("agent-complete", "success");
                        return Ok(());
                    }
                }
            }
        }

        let _ = window.emit("agent-stream-done", json!({
            "content": followup_content,
            "loopCount": 2,
            "ttftMs": ttft_ms.unwrap_or(0),
            "responseTimeMs": request_start.elapsed().as_millis() as u64,
        }));
        let _ = window.emit("agent-complete", "success");
        return Ok(());
    }

    let _ = window.emit("agent-stream-done", json!({
        "content": assistant_content,
        "loopCount": 1,
        "ttftMs": ttft_ms.unwrap_or(0),
        "responseTimeMs": request_start.elapsed().as_millis() as u64,
    }));
    let _ = window.emit("agent-complete", "success");
    Ok(())
}

async fn start_agent_loop_inner(
    window: Window,
    client: reqwest::Client,
    user_prompt: String,
    config: AppConfig,
    session_messages: Vec<Value>,
    mut mcp_manager: McpManager,
    mcp_tool_defs: Vec<Value>,
) -> Result<(), String> {
    let mut system_prompt = config.system_prompt.clone();

    if let Some((rules, filename)) = load_workspace_rules(&config.default_work_dir) {
        system_prompt.push_str(&format!(
            "\n\n===========================================\n📌 [Workspace Rules (from {})]:\n{}\n===========================================\n",
            filename, rules
        ));
        let _ = window.emit("agent-workspace-rules", json!({
            "file": filename,
            "length": rules.len(),
        }));
    }

    let mut messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": system_prompt
    })];

    let limit = config.context_limit as usize;
    let limited_messages: Vec<Value> = if session_messages.len() > limit {
        session_messages.into_iter().rev().take(limit).rev().collect()
    } else {
        session_messages
    };
    messages.extend(limited_messages);

    messages.push(json!({
        "role": "user",
        "content": user_prompt
    }));

    let mut loop_count = 0;
    let mut total_prompt_tokens: u64 = 0;
    let mut total_completion_tokens: u64 = 0;

    while loop_count < MAX_LOOPS {
        loop_count += 1;

        let steering_msgs = drain_steering_messages().await;
        if !steering_msgs.is_empty() {
            let combined = steering_msgs.join("\n");
            let steering_prompt = format!(
                "⚠️ [User Steering (High Priority)]:\n{}\nPlease adjust your next action according to this intervention immediately!",
                combined
            );
            messages.push(json!({
                "role": "user",
                "content": steering_prompt
            }));
            let _ = window.emit("agent-steering-processed", &combined);
        }

        compact_messages(&mut messages, config.context_limit as usize);

        let request_start = Instant::now();

        let is_ollama = config.provider == "ollama";

        // Build request body
        let mut request_body = if is_ollama {
            json!({
                "model": config.model,
                "messages": messages,
                "stream": config.streaming,
                "options": {
                    "temperature": config.temperature,
                    "top_p": config.top_p,
                }
            })
        } else {
            json!({
                "model": config.model,
                "messages": messages,
                "stream": config.streaming,
                "stream_options": {
                    "include_usage": true
                }
            })
        };

        if let Some(max_tokens) = config.max_tokens {
            if is_ollama {
                request_body["options"]["num_predict"] = json!(max_tokens);
            } else {
                request_body["max_tokens"] = json!(max_tokens);
            }
        }
        if !is_ollama {
            request_body["temperature"] = json!(config.temperature);
            request_body["top_p"] = json!(config.top_p);
        }

        // Add enabled tools
        let mut enabled_tools = get_enabled_tool_definitions(&config.tools_enabled);
        enabled_tools.extend(mcp_tool_defs.clone());
        if !enabled_tools.is_empty() {
            request_body["tools"] = json!(enabled_tools);
        }

        let url = if is_ollama {
            format!("{}/api/chat", config.base_url.trim_end_matches('/'))
        } else {
            format!("{}/chat/completions", config.base_url.trim_end_matches('/'))
        };

        let mut request_builder = client
            .post(&url)
            .header("Content-Type", "application/json");

        if !is_ollama && !config.api_key.is_empty() {
            request_builder = request_builder.header(
                "Authorization",
                format!("Bearer {}", config.api_key),
            );
        }

        let response = request_builder
            .json(&request_body)
            .send()
            .await
            .map_err(|e| format!("API request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("LLM API error ({}): {}", status, error_text));
        }

        if !config.streaming {
            // Non-streaming mode
            let body: Value = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            let response_time_ms = request_start.elapsed().as_millis() as u64;

            // Extract usage
            let prompt_tokens = body["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
            let completion_tokens = body["usage"]["completion_tokens"].as_u64().unwrap_or(0);
            total_prompt_tokens += prompt_tokens;
            total_completion_tokens += completion_tokens;

            let _ = window.emit("agent-usage", json!({
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_prompt_tokens": total_prompt_tokens,
                "total_completion_tokens": total_completion_tokens,
                "ttft_ms": response_time_ms,
                "response_time_ms": response_time_ms,
                "loop_count": loop_count,
            }));

            let content = body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string();

            let reasoning_content = body["choices"][0]["message"]["reasoning_content"]
                .as_str()
                .unwrap_or("")
                .to_string();

            if !reasoning_content.is_empty() {
                let _ = window.emit("agent-reasoning-chunk", &reasoning_content);
            }

            if !content.is_empty() {
                let _ = window.emit("agent-stream-chunk", &content);
            }

            let tool_calls = body["choices"][0]["message"]["tool_calls"]
                .as_array()
                .cloned()
                .unwrap_or_default();

            if tool_calls.is_empty() {
                mcp_manager.shutdown().await;
                let _ = window.emit("agent-complete", "success");
                return Ok(());
            }

            // Process tool calls in non-streaming mode
            let accumulated: Vec<AccumulatedToolCall> = tool_calls
                .iter()
                .map(|tc| AccumulatedToolCall {
                    id: tc["id"].as_str().unwrap_or("").to_string(),
                    name: tc["function"]["name"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    arguments: tc["function"]["arguments"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                })
                .collect();

            // Add assistant message with content
            let mut assistant_msg = json!({
                "role": "assistant",
            });
            if !content.is_empty() {
                assistant_msg["content"] = json!(content);
            } else {
                assistant_msg["content"] = Value::Null;
            }
            assistant_msg["tool_calls"] = json!(tool_calls);
            messages.push(assistant_msg);

            let result = process_tool_calls(
                &window,
                &accumulated,
                &config,
                &mut messages,
                &mut mcp_manager,
            )
            .await?;
            if result {
                return Ok(());
            }
            continue;
        }

        // Streaming mode
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut accumulated_tool_calls: Vec<AccumulatedToolCall> = Vec::new();
        let mut has_tool_calls = false;
        let mut assistant_content = String::new();
        let mut assistant_reasoning = String::new();
        let mut ttft_ms: Option<u64> = None;
        let mut first_content_received = false;
        let mut stream_usage_prompt: u64 = 0;
        let mut stream_usage_completion: u64 = 0;

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| e.to_string())?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                if is_ollama {
                    // Ollama JSON Lines format: each line is a complete JSON object
                    if let Ok(json_val) = serde_json::from_str::<Value>(&line) {
                        if json_val["done"].as_bool() == Some(true) {
                            if let Some(eval_count) = json_val["eval_count"].as_u64() {
                                stream_usage_completion = eval_count;
                            }
                            if let Some(prompt_eval_count) = json_val["prompt_eval_count"].as_u64() {
                                stream_usage_prompt = prompt_eval_count;
                            }
                            break;
                        }

                        if let Some(content) = json_val["message"]["content"].as_str() {
                            if !content.is_empty() {
                                if !first_content_received {
                                    first_content_received = true;
                                    ttft_ms = Some(request_start.elapsed().as_millis() as u64);
                                }
                                assistant_content.push_str(content);
                                let _ = window.emit("agent-stream-chunk", content);
                            }
                        }

                        if let Some(tool_calls) = json_val["message"]["tool_calls"].as_array() {
                            has_tool_calls = true;
                            for (idx, tc) in tool_calls.iter().enumerate() {
                                if idx >= accumulated_tool_calls.len() {
                                    let id = tc["id"].as_str()
                                        .filter(|s| !s.is_empty())
                                        .map(|s| s.to_string())
                                        .unwrap_or_else(|| format!("call_{}", idx));
                                    accumulated_tool_calls.push(AccumulatedToolCall {
                                        id,
                                        name: tc["function"]["name"].as_str().unwrap_or("").to_string(),
                                        arguments: tc["function"]["arguments"].as_str().unwrap_or("").to_string(),
                                    });
                                } else {
                                    let existing = &mut accumulated_tool_calls[idx];
                                    if let Some(args_chunk) = tc["function"]["arguments"].as_str() {
                                        existing.arguments.push_str(args_chunk);
                                    }
                                    if existing.id.is_empty() {
                                        if let Some(id) = tc["id"].as_str().filter(|s| !s.is_empty()) {
                                            existing.id = id.to_string();
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // OpenAI SSE format
                    if !line.starts_with("data: ") {
                        continue;
                    }
                    let data = &line[6..];
                    if data == "[DONE]" {
                        break;
                    }

                    if let Ok(json_val) = serde_json::from_str::<Value>(data) {
                        if let Some(usage) = json_val.get("usage") {
                            stream_usage_prompt = usage["prompt_tokens"].as_u64().unwrap_or(stream_usage_prompt);
                            stream_usage_completion = usage["completion_tokens"].as_u64().unwrap_or(stream_usage_completion);
                        }

                        if let Some(choices) = json_val["choices"].as_array() {
                            if choices.is_empty() {
                                continue;
                            }
                            let delta = &choices[0]["delta"];

                            if let Some(reasoning) = delta["reasoning_content"].as_str() {
                                if !reasoning.is_empty() {
                                    assistant_reasoning.push_str(reasoning);
                                    let _ = window.emit("agent-reasoning-chunk", reasoning);
                                }
                            }

                            if let Some(content) = delta["content"].as_str() {
                                if !first_content_received && !content.is_empty() {
                                    first_content_received = true;
                                    ttft_ms = Some(request_start.elapsed().as_millis() as u64);
                                }
                                assistant_content.push_str(content);
                                let _ = window.emit("agent-stream-chunk", content);
                            }

                            if let Some(tool_calls) = delta["tool_calls"].as_array() {
                                has_tool_calls = true;
                                for tc in tool_calls {
                                    let idx = tc["index"].as_u64().unwrap_or(0) as usize;

                                    if idx >= accumulated_tool_calls.len() {
                                        accumulated_tool_calls.push(AccumulatedToolCall {
                                            id: tc["id"].as_str().unwrap_or("").to_string(),
                                            name: tc["function"]["name"].as_str().unwrap_or("").to_string(),
                                            arguments: String::new(),
                                        });
                                    }

                                    if let Some(args_delta) = tc["function"]["arguments"].as_str() {
                                        accumulated_tool_calls[idx].arguments.push_str(args_delta);
                                        let _ = window.emit(
                                            "agent-tool-drafting",
                                            json!({
                                                "index": idx,
                                                "id": accumulated_tool_calls[idx].id,
                                                "name": accumulated_tool_calls[idx].name,
                                                "arguments": accumulated_tool_calls[idx].arguments
                                            }),
                                        );
                                    }

                                    if let Some(tc_id) = tc["id"].as_str() {
                                        if !tc_id.is_empty() {
                                            accumulated_tool_calls[idx].id = tc_id.to_string();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Emit usage stats for this streaming turn
        let response_time_ms = request_start.elapsed().as_millis() as u64;
        total_prompt_tokens += stream_usage_prompt;
        total_completion_tokens += stream_usage_completion;

        let _ = window.emit("agent-usage", json!({
            "prompt_tokens": stream_usage_prompt,
            "completion_tokens": stream_usage_completion,
            "total_prompt_tokens": total_prompt_tokens,
            "total_completion_tokens": total_completion_tokens,
            "ttft_ms": ttft_ms.unwrap_or(response_time_ms),
            "response_time_ms": response_time_ms,
            "loop_count": loop_count,
        }));

        // No tool calls - conversation complete
        if !has_tool_calls {
            mcp_manager.shutdown().await;
            let _ = window.emit("agent-complete", "success");
            return Ok(());
        }

        // Build assistant message for conversation history
        let tool_calls_json: Vec<Value> = accumulated_tool_calls
            .iter()
            .map(|tc| {
                json!({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": tc.arguments
                    }
                })
            })
            .collect();

        let mut assistant_msg = json!({
            "role": "assistant",
            "tool_calls": tool_calls_json,
        });
        if assistant_content.is_empty() {
            assistant_msg["content"] = Value::Null;
        } else {
            assistant_msg["content"] = json!(assistant_content);
        }
        messages.push(assistant_msg);

        // Process tool calls with approval
        let result =
            process_tool_calls(&window, &accumulated_tool_calls, &config, &mut messages, &mut mcp_manager)
                .await?;
        if result {
            return Ok(());
        }
    }

    mcp_manager.shutdown().await;
    Err("Max agent loop iterations reached.".to_string())
}

async fn git_checkpoint(work_dir: &str) {
    let output = tokio::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(work_dir)
        .creation_flags(0x08000000)
        .output()
        .await;

    if let Ok(out) = output {
        if !out.status.success() {
            return;
        }
    } else {
        return;
    }

    let _ = tokio::process::Command::new("git")
        .args(["add", "-A"])
        .current_dir(work_dir)
        .creation_flags(0x08000000)
        .output()
        .await;

    let _ = tokio::process::Command::new("git")
        .args(["commit", "-m", "gxagent-auto-checkpoint", "--no-verify", "--allow-empty"])
        .current_dir(work_dir)
        .creation_flags(0x08000000)
        .output()
        .await;
}

async fn execute_tool_with_mcp(
    name: &str,
    args_str: &str,
    config: &AppConfig,
    mcp_manager: &mut McpManager,
) -> String {
    let write_tools = ["write_file", "execute_command"];
    if write_tools.contains(&name) {
        git_checkpoint(&config.default_work_dir).await;
    }

    let builtin_tools = ["execute_command", "read_file", "write_file", "list_dir", "run_python", "web_search"];
    if builtin_tools.contains(&name) {
        execute_tool_with_timeout(name, args_str, &config.default_work_dir, &config.search_provider, &config.search_api_key, config.command_timeout).await
    } else {
        let args: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
        match mcp_manager.route_tool_call(name, args).await {
            Ok(output) => output,
            Err(e) => format!("MCP tool error: {}", e),
        }
    }
}

/// Process accumulated tool calls with human-in-the-loop approval.
/// Returns Ok(true) if the agent should stop (no more tool calls needed),
/// Ok(false) if the loop should continue.
async fn process_tool_calls(
    window: &Window,
    tool_calls: &[AccumulatedToolCall],
    config: &AppConfig,
    messages: &mut Vec<Value>,
    mcp_manager: &mut McpManager,
) -> Result<bool, String> {
    let mut needs_confirmation = Vec::new();
    let mut auto_approved = Vec::new();

    // Classify each tool call by approval level
    for tc in tool_calls {
        let level = check_approval(
            &tc.name,
            &tc.arguments,
            &config.approval_policy,
            &config.trusted_patterns,
        );

        match level {
            ApprovalLevel::AutoApprove => {
                auto_approved.push(tc.clone());
            }
            ApprovalLevel::NeedsConfirmation => {
                needs_confirmation.push(PendingToolCall {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    arguments: tc.arguments.clone(),
                    approval_level: "needs_confirmation".to_string(),
                });
            }
            ApprovalLevel::Blocked => {
                // Emit blocked event and add error as tool response
                let _ = window.emit(
                    "agent-tool-blocked",
                    json!({
                        "id": tc.id,
                        "name": tc.name,
                        "arguments": tc.arguments,
                        "reason": "This command is blocked by security policy."
                    }),
                );
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": "Error: This command was blocked by the security policy. Please try a different approach."
                }));
            }
        }
    }

    // Execute auto-approved tools immediately
    for tc in &auto_approved {
        let _ = window.emit(
            "agent-tool-executing",
            json!({
                "id": tc.id,
                "name": tc.name,
                "arguments": tc.arguments
            }),
        );

        let output = execute_tool_with_mcp(&tc.name, &tc.arguments, &config, &mut *mcp_manager).await;

        let _ = window.emit(
            "agent-tool-output",
            json!({
                "id": tc.id,
                "name": tc.name,
                "output": output
            }),
        );

        messages.push(json!({
            "role": "tool",
            "tool_call_id": tc.id,
            "content": output
        }));
    }

    // If there are tools needing confirmation, emit approval request and wait
    if !needs_confirmation.is_empty() {
        let request_id = uuid::Uuid::new_v4().to_string();
        let request = ToolApprovalRequest {
            request_id: request_id.clone(),
            tool_calls: needs_confirmation,
        };

        let _ = window.emit("agent-tool-approval-request", &request);

        // Wait for user response via Tauri state
        // The frontend will invoke "resolve_tool_approval" command
        let approval_result = wait_for_approval(window, &request_id).await?;

        for (tc_id, approved) in approval_result {
            if approved {
                // Find the tool call
                if let Some(tc) = tool_calls.iter().find(|t| t.id == tc_id) {
                    let _ = window.emit(
                        "agent-tool-executing",
                        json!({
                            "id": tc.id,
                            "name": tc.name,
                            "arguments": tc.arguments
                        }),
                    );

                    let output =
                        execute_tool_with_mcp(&tc.name, &tc.arguments, &config, &mut *mcp_manager).await;

                    let _ = window.emit(
                        "agent-tool-output",
                        json!({
                            "id": tc.id,
                            "name": tc.name,
                            "output": output
                        }),
                    );

                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": output
                    }));
                }
            } else {
                // User rejected
                if let Some(_tc) = tool_calls.iter().find(|t| t.id == tc_id) {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": "User rejected this tool call. Please try a different approach or ask the user for clarification."
                    }));
                }
            }
        }
    }

    Ok(false)
}

use std::sync::Arc;
use tokio::sync::watch;

/// Global pending approvals store: request_id -> watch::Sender channel
type ApprovalMap = std::collections::HashMap<String, watch::Sender<Option<Vec<(String, bool)>>>>;

static PENDING_APPROVALS: once_cell::sync::Lazy<Arc<tokio::sync::Mutex<ApprovalMap>>> =
    once_cell::sync::Lazy::new(|| {
        Arc::new(tokio::sync::Mutex::new(ApprovalMap::new()))
    });

/// Wait for frontend to resolve a tool approval request.
/// Includes a 5-minute timeout to prevent orphaned approvals from leaking memory.
async fn wait_for_approval(
    _window: &Window,
    request_id: &str,
) -> Result<Vec<(String, bool)>, String> {
    const APPROVAL_TIMEOUT_SECS: u64 = 300; // 5 minutes

    let rx = {
        let mut pending = PENDING_APPROVALS.lock().await;
        // Create a watch channel; the sender will be stored, receiver returned
        let (tx, rx) = watch::channel(None::<Vec<(String, bool)>>);
        pending.insert(request_id.to_string(), tx);
        rx
    };

    // Wait for the value to change from None to Some, with timeout
    let mut rx = rx;
    let timeout = tokio::time::sleep(std::time::Duration::from_secs(APPROVAL_TIMEOUT_SECS));
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            result = rx.changed() => {
                result.map_err(|_| "Approval channel closed unexpectedly".to_string())?;
                let result = rx.borrow().clone();
                if let Some(results) = result {
                    return Ok(results);
                }
            }
            _ = &mut timeout => {
                // Clean up the orphaned entry
                let mut pending = PENDING_APPROVALS.lock().await;
                pending.remove(request_id);
                return Err(format!(
                    "Approval request timed out after {} seconds",
                    APPROVAL_TIMEOUT_SECS
                ));
            }
        }
    }
}

/// Called by the frontend to resolve a pending approval
pub async fn resolve_approval(
    request_id: &str,
    results: Vec<(String, bool)>,
) -> Result<(), String> {
    let mut pending = PENDING_APPROVALS.lock().await;
    if let Some(tx) = pending.remove(request_id) {
        tx.send(Some(results)).map_err(|_| "Failed to send approval result".to_string())?;
        Ok(())
    } else {
        Err(format!("No pending approval found for request: {}", request_id))
    }
}

/// Fetch available models from an OpenAI-compatible API
pub async fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let url = format!("{}/models", base_url.trim_end_matches('/'));

    let mut request = client
        .get(&url)
        .header("Content-Type", "application/json");

    if !api_key.is_empty() {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Models API error ({}): {}", status, error_text));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {}", e))?;

    let models = body["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m["id"].as_str().is_some())
        .collect();

    Ok(models)
}

fn parse_dsml_tool_calls(content: &str) -> Vec<AccumulatedToolCall> {
    let mut calls = Vec::new();
    let dsml_close = "\u{ff5c}\u{ff5c}DSML\u{ff5c}\u{ff5c}";
    let invoke_open = format!("<{}invoke name=\"", dsml_close);
    let invoke_close = format!("</{}invoke>", dsml_close);
    let param_open = format!("<{}parameter name=\"", dsml_close);
    let param_close = format!("</{}parameter>", dsml_close);

    let mut pos = 0;
    while let Some(start) = content[pos..].find(&invoke_open) {
        let abs_start = pos + start;
        let name_start = abs_start + invoke_open.len();
        if let Some(name_end) = content[name_start..].find('"') {
            let name = content[name_start..name_start + name_end].to_string();
            let mut args = serde_json::Map::new();

            let invoke_body_start = name_start + name_end + 1;
            if let Some(invoke_end_offset) = content[invoke_body_start..].find(&invoke_close) {
                let body = &content[invoke_body_start..invoke_body_start + invoke_end_offset];

                let mut param_pos = 0;
                while let Some(p_start) = body[param_pos..].find(&param_open) {
                    let abs_p = param_pos + p_start;
                    let pname_start = abs_p + param_open.len();
                    if let Some(pname_end) = body[pname_start..].find('"') {
                        let pname = body[pname_start..pname_start + pname_end].to_string();
                        let after_name = pname_start + pname_end;
                        if let Some(gt_pos) = body[after_name..].find('>') {
                            let val_start = after_name + gt_pos + 1;
                            if let Some(pc_offset) = body[val_start..].find(&param_close) {
                                let val_end = val_start + pc_offset;
                                if val_end > val_start {
                                    let pval = body[val_start..val_end].to_string();
                                    args.insert(pname, json!(pval));
                                }
                            }
                        }
                        param_pos = pname_start + pname_end + 1;
                    } else {
                        break;
                    }
                }
            }

            calls.push(AccumulatedToolCall {
                id: format!("dsml_{}", calls.len()),
                name,
                arguments: serde_json::Value::Object(args).to_string(),
            });

            pos = name_start + name_end + 1;
        } else {
            break;
        }
    }

    calls
}

fn strip_dsml_tags(content: &str) -> String {
    let dsml_close = "\u{ff5c}\u{ff5c}DSML\u{ff5c}\u{ff5c}";
    let mut result = content.to_string();

    // Remove complete DSML tag blocks: <｜｜DSML｜｜tool_calls>...</｜｜DSML｜｜tool_calls>
    let tc_open = format!("<{}tool_calls>", dsml_close);
    let tc_close = format!("</{}tool_calls>", dsml_close);
    loop {
        if let Some(start) = result.find(&tc_open) {
            if let Some(end) = result[start..].find(&tc_close) {
                result.replace_range(start..start + end + tc_close.len(), "");
            } else {
                result.replace_range(start.., "");
                break;
            }
        } else {
            break;
        }
    }

    // Remove any remaining DSML fragments
    let fragments = [
        format!("<{}tool_calls>", dsml_close),
        format!("</{}tool_calls>", dsml_close),
        format!("<{}invoke", dsml_close),
        format!("</{}invoke>", dsml_close),
        format!("<{}parameter", dsml_close),
        format!("</{}parameter>", dsml_close),
    ];
    for frag in &fragments {
        result = result.replace(frag, "");
    }

    // Remove lines that are only DSML residue (contain DSML markers but no useful content)
    let cleaned: Vec<&str> = result
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !trimmed.contains("DSML")
        })
        .collect();
    cleaned.join("\n").trim().to_string()
}
