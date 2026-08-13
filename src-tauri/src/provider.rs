//! Provider wire-format adapter layer.
//!
//! The rest of the agent works exclusively with an internal, OpenAI-shaped
//! representation:
//!   * `messages`: a `Vec<Value>` of `{role, content, tool_calls?, tool_call_id?}`
//!   * `tools`: a `Vec<Value>` of `{type:"function", function:{name, description, parameters}}`
//!
//! This module is the ONLY place that knows about provider-specific request
//! shapes, auth headers, URLs, and streaming response formats. It converts the
//! canonical representation into the target wire format on the way out, and
//! converts streaming responses back into a unified [`StreamDelta`] on the way
//! in. Adding a provider means extending the `match wire` arms here — never
//! sprinkling `if provider == ...` across `agent.rs`.

use crate::config::AppConfig;
use serde_json::{json, Value};

/// The on-the-wire protocol used to talk to the model endpoint. This is
/// deliberately decoupled from the "provider brand": a Claude model can be
/// served behind an OpenAI-compatible proxy (`Wire::OpenAI`), and a relay can
/// expose Gemini models in OpenAI format. The wire format is what determines
/// request/response shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    OpenAI,
    Ollama,
    Anthropic,
    Gemini,
}

impl Wire {
    /// Resolve a wire format from a free-form string (case-insensitive).
    /// Unknown values default to OpenAI, the safe lowest-common-denominator.
    pub fn from_str(s: &str) -> Wire {
        match s.trim().to_ascii_lowercase().as_str() {
            "ollama" => Wire::Ollama,
            "anthropic" | "claude" => Wire::Anthropic,
            "gemini" | "google" => Wire::Gemini,
            _ => Wire::OpenAI,
        }
    }

    /// Resolve the wire format from config. Falls back to the legacy `provider`
    /// field when `wire_format` is empty (old configs), then defaults to OpenAI.
    pub fn from_config(config: &AppConfig) -> Wire {
        let wf = config.wire_format.trim();
        if wf.is_empty() {
            Wire::from_str(&config.provider)
        } else {
            Wire::from_str(wf)
        }
    }

    pub fn is_ollama(self) -> bool {
        matches!(self, Wire::Ollama)
    }
}

const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Build the request URL for a single (streaming or non-streaming) turn.
pub fn build_url(wire: Wire, base_url: &str, model: &str, streaming: bool) -> String {
    let base = base_url.trim_end_matches('/');
    match wire {
        Wire::Ollama => format!("{}/api/chat", base),
        // Allow base urls that already include the /v1 suffix so we don't
        // emit `/v1/v1/messages` when the user types the full versioned URL.
        Wire::Anthropic => {
            if base.ends_with("/v1") {
                format!("{}/messages", base)
            } else {
                format!("{}/v1/messages", base)
            }
        }
        Wire::Gemini => {
            // Gemini uses distinct endpoints for streaming vs. non-streaming,
            // and the model name is part of the path.
            let method = if streaming {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            // Official Gemini model names often carry a `models/` prefix
            // (e.g. "models/gemini-2.0-flash"). Strip it so we don't emit
            // `/models/models/...`.
            let model = model.strip_prefix("models/").unwrap_or(model);
            // Allow base urls that already include /v1beta or /v1.
            if base.contains("/v1beta") || base.ends_with("/v1") {
                format!("{}/models/{}:{}", base, model, method)
            } else {
                format!("{}/v1beta/models/{}:{}", base, model, method)
            }
        }
        Wire::OpenAI => format!("{}/chat/completions", base),
    }
}

/// Apply provider-specific auth + required headers to a request builder.
pub fn apply_auth(
    wire: Wire,
    builder: reqwest::RequestBuilder,
    api_key: &str,
) -> reqwest::RequestBuilder {
    let builder = builder.header("Content-Type", "application/json");
    match wire {
        Wire::Ollama => builder,
        Wire::OpenAI => {
            if api_key.is_empty() {
                builder
            } else {
                builder.header("Authorization", format!("Bearer {}", api_key))
            }
        }
        Wire::Anthropic => builder
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        Wire::Gemini => {
            // Gemini takes the key via header (preferred over the ?key= query param).
            builder.header("x-goog-api-key", api_key)
        }
    }
}

/// Build the JSON request body from canonical (OpenAI-shaped) messages + tools.
///
/// `tools` is the OpenAI tool-definition array (may be empty).
pub fn build_body(
    wire: Wire,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    config: &AppConfig,
    streaming: bool,
) -> Value {
    match wire {
        Wire::Ollama => build_ollama_body(model, messages, tools, config, streaming),
        Wire::OpenAI => build_openai_body(model, messages, tools, config, streaming),
        Wire::Anthropic => build_anthropic_body(model, messages, tools, config, streaming),
        Wire::Gemini => build_gemini_body(messages, tools, config),
    }
}

fn build_openai_body(
    model: &str,
    messages: &[Value],
    tools: &[Value],
    config: &AppConfig,
    streaming: bool,
) -> Value {
    let messages = normalize_system_messages(messages);
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": streaming,
    });
    if streaming {
        body["stream_options"] = json!({ "include_usage": true });
    }
    if let Some(max_tokens) = config.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    body["temperature"] = json!(config.temperature);
    body["top_p"] = json!(config.top_p);
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    body
}

fn build_ollama_body(
    model: &str,
    messages: &[Value],
    tools: &[Value],
    config: &AppConfig,
    streaming: bool,
) -> Value {
    let messages = normalize_system_messages(messages);
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": streaming,
        "options": {
            "temperature": config.temperature,
            "top_p": config.top_p,
        }
    });
    if let Some(max_tokens) = config.max_tokens {
        body["options"]["num_predict"] = json!(max_tokens);
    }
    // Ollama's /api/chat accepts OpenAI-shaped tool definitions as-is. The
    // response side (parse_ollama_line) already handles message.tool_calls.
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    body
}

/// Keep system instructions at the beginning of OpenAI-shaped histories.
/// Native Anthropic/Gemini adapters already lift system text into their
/// top-level fields, but OpenAI-compatible relays vary: strict ones reject a
/// system role that appears after conversation or tool messages.
fn normalize_system_messages(messages: &[Value]) -> Vec<Value> {
    let mut system_parts: Vec<String> = Vec::new();
    let mut conversation: Vec<Value> = Vec::with_capacity(messages.len());

    for message in messages {
        if message["role"] == "system" {
            if let Some(content) = message["content"].as_str() {
                if !content.trim().is_empty() {
                    system_parts.push(content.to_string());
                }
            }
        } else {
            conversation.push(message.clone());
        }
    }

    if system_parts.is_empty() {
        return conversation;
    }

    let mut normalized = Vec::with_capacity(conversation.len() + 1);
    normalized.push(json!({
        "role": "system",
        "content": system_parts.join("\n\n"),
    }));
    normalized.extend(conversation);
    normalized
}

/// Split canonical messages into an Anthropic-style (system_text, messages[]).
/// Anthropic takes `system` as a top-level field and only allows user/assistant
/// roles in `messages`, with tool calls/results expressed as content blocks.
fn build_anthropic_body(
    model: &str,
    messages: &[Value],
    tools: &[Value],
    config: &AppConfig,
    streaming: bool,
) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut conv: Vec<Value> = Vec::new();

    for msg in messages {
        let role = msg["role"].as_str().unwrap_or("");
        match role {
            "system" => {
                if let Some(text) = msg["content"].as_str() {
                    if !text.is_empty() {
                        system_parts.push(text.to_string());
                    }
                }
            }
            "user" => {
                conv.push(json!({
                    "role": "user",
                    "content": anthropic_user_content(msg),
                }));
            }
            "assistant" => {
                conv.push(json!({
                    "role": "assistant",
                    "content": anthropic_assistant_content(msg),
                }));
            }
            "tool" => {
                // Tool results become a user message carrying a tool_result block.
                // Anthropic requires tool_result to be in a user-role message.
                let tool_use_id = msg["tool_call_id"].as_str().unwrap_or("");
                let content = msg["content"].as_str().unwrap_or("");
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                });
                // Merge consecutive tool results into one user message when possible.
                if let Some(last) = conv.last_mut() {
                    if last["role"] == "user" {
                        if let Some(arr) = last["content"].as_array_mut() {
                            arr.push(block);
                            continue;
                        }
                    }
                }
                conv.push(json!({ "role": "user", "content": [block] }));
            }
            _ => {}
        }
    }

    let mut body = json!({
        "model": model,
        "messages": conv,
        "stream": streaming,
        // Anthropic requires max_tokens. Use the configured value or a safe default.
        "max_tokens": config.max_tokens.unwrap_or(4096),
        "temperature": config.temperature,
        "top_p": config.top_p,
    });

    if !system_parts.is_empty() {
        body["system"] = json!(system_parts.join("\n\n"));
    }

    let anth_tools = openai_tools_to_anthropic(tools);
    if !anth_tools.is_empty() {
        body["tools"] = json!(anth_tools);
    }

    body
}

/// User content for Anthropic: plain string, or blocks when images are present.
fn anthropic_user_content(msg: &Value) -> Value {
    // Canonical user messages may carry multimodal content as an array of
    // {type:"text"|"image_url", ...} (OpenAI shape). Convert images to
    // Anthropic image blocks; otherwise pass the plain string through.
    match &msg["content"] {
        Value::String(s) => json!(s),
        Value::Array(parts) => {
            let mut blocks: Vec<Value> = Vec::new();
            for p in parts {
                match p["type"].as_str() {
                    Some("text") => {
                        blocks.push(
                            json!({ "type": "text", "text": p["text"].as_str().unwrap_or("") }),
                        );
                    }
                    Some("image_url") => {
                        let url = p["image_url"]["url"].as_str().unwrap_or("");
                        if let Some((media_type, data)) = parse_data_url(url) {
                            blocks.push(json!({
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": data,
                                }
                            }));
                        }
                    }
                    _ => {}
                }
            }
            json!(blocks)
        }
        _ => json!(""),
    }
}

/// Assistant content for Anthropic: text block + tool_use blocks.
fn anthropic_assistant_content(msg: &Value) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    if let Some(text) = msg["content"].as_str() {
        if !text.is_empty() {
            blocks.push(json!({ "type": "text", "text": text }));
        }
    }
    if let Some(tool_calls) = msg["tool_calls"].as_array() {
        for tc in tool_calls {
            let id = tc["id"].as_str().unwrap_or("");
            let name = tc["function"]["name"].as_str().unwrap_or("");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let input: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
            blocks.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input,
            }));
        }
    }
    if blocks.is_empty() {
        // Anthropic rejects empty assistant content.
        blocks.push(json!({ "type": "text", "text": "" }));
    }
    json!(blocks)
}

fn openai_tools_to_anthropic(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|t| {
            let f = &t["function"];
            let name = f["name"].as_str()?;
            Some(json!({
                "name": name,
                "description": f["description"].as_str().unwrap_or(""),
                "input_schema": f["parameters"].clone(),
            }))
        })
        .collect()
}

/// Build a Gemini `generateContent` request body.
/// Gemini uses `contents` with role `user`/`model`, parts arrays, a top-level
/// `systemInstruction`, and `functionDeclarations` for tools.
fn build_gemini_body(messages: &[Value], tools: &[Value], config: &AppConfig) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut contents: Vec<Value> = Vec::new();

    // Gemini's functionResponse needs the function *name*, but our canonical tool
    // results only carry the tool_call_id. We resolve id -> name with a map built
    // incrementally as we walk the history in order: each assistant turn records
    // its tool_calls, and the tool results that immediately follow look up against
    // that state. Gemini synthesizes per-turn ids (gemini_call_0, _1, ...) that
    // repeat across turns, so a single pre-scan would let a later turn's id
    // clobber an earlier one — updating in order keeps each result on its own turn.
    let mut tool_id_to_name: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for msg in messages {
        let role = msg["role"].as_str().unwrap_or("");
        match role {
            "system" => {
                if let Some(text) = msg["content"].as_str() {
                    if !text.is_empty() {
                        system_parts.push(text.to_string());
                    }
                }
            }
            "user" => {
                contents.push(json!({
                    "role": "user",
                    "parts": gemini_user_parts(msg),
                }));
            }
            "assistant" => {
                if let Some(tool_calls) = msg["tool_calls"].as_array() {
                    for tc in tool_calls {
                        if let (Some(id), Some(name)) =
                            (tc["id"].as_str(), tc["function"]["name"].as_str())
                        {
                            if !id.is_empty() && !name.is_empty() {
                                tool_id_to_name.insert(id.to_string(), name.to_string());
                            }
                        }
                    }
                }
                contents.push(json!({
                    "role": "model",
                    "parts": gemini_assistant_parts(msg),
                }));
            }
            "tool" => {
                // Gemini expresses tool results as a functionResponse part in a
                // user-role message. Resolve the function name by tool_call_id so
                // multiple parallel results each map to their own function; fall
                // back to the most recent functionCall name if the id is unknown.
                let content = msg["content"].as_str().unwrap_or("");
                let tool_call_id = msg["tool_call_id"].as_str().unwrap_or("");
                let fn_name = tool_id_to_name
                    .get(tool_call_id)
                    .cloned()
                    .unwrap_or_else(|| gemini_find_tool_name(&contents, tool_call_id));
                let part = json!({
                    "functionResponse": {
                        "name": fn_name,
                        "response": { "result": content },
                    }
                });
                if let Some(last) = contents.last_mut() {
                    if last["role"] == "user" {
                        if let Some(arr) = last["parts"].as_array_mut() {
                            arr.push(part);
                            continue;
                        }
                    }
                }
                contents.push(json!({ "role": "user", "parts": [part] }));
            }
            _ => {}
        }
    }

    let mut body = json!({
        "contents": contents,
        "generationConfig": {
            "temperature": config.temperature,
            "topP": config.top_p,
        }
    });

    if let Some(max_tokens) = config.max_tokens {
        body["generationConfig"]["maxOutputTokens"] = json!(max_tokens);
    }

    if !system_parts.is_empty() {
        body["systemInstruction"] = json!({
            "parts": [{ "text": system_parts.join("\n\n") }]
        });
    }

    let decls = openai_tools_to_gemini(tools);
    if !decls.is_empty() {
        body["tools"] = json!([{ "functionDeclarations": decls }]);
    }

    body
}

fn gemini_user_parts(msg: &Value) -> Value {
    match &msg["content"] {
        Value::String(s) => json!([{ "text": s }]),
        Value::Array(parts) => {
            let mut out: Vec<Value> = Vec::new();
            for p in parts {
                match p["type"].as_str() {
                    Some("text") => out.push(json!({ "text": p["text"].as_str().unwrap_or("") })),
                    Some("image_url") => {
                        let url = p["image_url"]["url"].as_str().unwrap_or("");
                        if let Some((media_type, data)) = parse_data_url(url) {
                            out.push(json!({
                                "inline_data": { "mime_type": media_type, "data": data }
                            }));
                        }
                    }
                    _ => {}
                }
            }
            json!(out)
        }
        _ => json!([{ "text": "" }]),
    }
}

fn gemini_assistant_parts(msg: &Value) -> Value {
    let mut parts: Vec<Value> = Vec::new();
    if let Some(text) = msg["content"].as_str() {
        if !text.is_empty() {
            parts.push(json!({ "text": text }));
        }
    }
    if let Some(tool_calls) = msg["tool_calls"].as_array() {
        for tc in tool_calls {
            let name = tc["function"]["name"].as_str().unwrap_or("");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
            parts.push(json!({
                "functionCall": { "name": name, "args": args }
            }));
        }
    }
    if parts.is_empty() {
        parts.push(json!({ "text": "" }));
    }
    json!(parts)
}

/// Fallback used only when a tool result's id has no entry in the id→name map
/// built from the assistant's tool_calls (e.g. a malformed history). Returns the
/// most recent model functionCall name seen.
fn gemini_find_tool_name(contents: &[Value], _tool_call_id: &str) -> String {
    for c in contents.iter().rev() {
        if c["role"] == "model" {
            if let Some(parts) = c["parts"].as_array() {
                for p in parts {
                    if let Some(name) = p["functionCall"]["name"].as_str() {
                        return name.to_string();
                    }
                }
            }
        }
    }
    String::new()
}

fn openai_tools_to_gemini(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|t| {
            let f = &t["function"];
            let name = f["name"].as_str()?;
            let mut decl = json!({
                "name": name,
                "description": f["description"].as_str().unwrap_or(""),
            });
            // Gemini rejects empty parameter objects; only include when non-trivial.
            let params = &f["parameters"];
            if params.is_object() && params.get("properties").is_some() {
                decl["parameters"] = sanitize_gemini_schema(params);
            }
            Some(decl)
        })
        .collect()
}

/// Gemini's schema dialect is a subset of JSON Schema. Strip fields it rejects
/// (e.g. `additionalProperties`, `$schema`) recursively.
fn sanitize_gemini_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if matches!(k.as_str(), "additionalProperties" | "$schema" | "default") {
                    continue;
                }
                out.insert(k.clone(), sanitize_gemini_schema(v));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(sanitize_gemini_schema).collect()),
        other => other.clone(),
    }
}

/// Parse a `data:<mime>;base64,<data>` URL into (mime, base64).
fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let media_type = meta.split(';').next().unwrap_or("image/png").to_string();
    Some((media_type, data.to_string()))
}

// ============================================================================
// Streaming response parsing
// ============================================================================

/// A normalized streaming event. All providers' streaming chunks are parsed
/// into a sequence of these so the agent loop is provider-agnostic.
#[derive(Debug, Default, Clone)]
pub struct StreamDelta {
    /// Visible assistant text appended this event.
    pub content: Option<String>,
    /// Reasoning / thinking text appended this event (where supported).
    pub reasoning: Option<String>,
    /// Tool-call fragments. For streaming, `arguments` is a partial fragment to
    /// be appended at `index`; `id`/`name` may arrive once at the start.
    pub tool_calls: Vec<ToolCallDelta>,
    /// Usage stats, when the provider reports them (often only at the end).
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    /// True when this event marks the end of the stream.
    pub done: bool,
}

#[derive(Debug, Clone)]
pub struct ToolCallDelta {
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    /// Partial JSON-arguments fragment to append.
    pub arguments: Option<String>,
}

/// Per-stream parser state. Some formats (Anthropic) are stateful across SSE
/// events: a `content_block_start` declares a block index + type, and later
/// deltas reference it.
#[derive(Debug, Default)]
pub struct StreamState {
    /// Anthropic: maps content-block index -> ("text" | "tool_use", tool index).
    /// We track how many tool_use blocks we've seen to assign stable indices.
    anth_block_is_tool: std::collections::HashMap<usize, usize>,
    anth_tool_count: usize,
    /// Gemini: running count of functionCall parts seen across all chunks of
    /// this response, so tool calls split across SSE chunks get distinct,
    /// non-colliding indices/ids instead of all restarting at 0.
    gemini_tool_count: usize,
}

/// Parse a single raw SSE/JSONL line into zero-or-more normalized deltas.
///
/// `line` is one already-trimmed line from the response stream. Returns an
/// empty vec for lines that carry no payload (comments, blank lines, etc.).
pub fn parse_stream_line(wire: Wire, line: &str, state: &mut StreamState) -> Vec<StreamDelta> {
    match wire {
        Wire::OpenAI => parse_openai_sse(line),
        Wire::Ollama => parse_ollama_line(line),
        Wire::Anthropic => parse_anthropic_sse(line, state),
        Wire::Gemini => parse_gemini_sse(line, state),
    }
}

fn parse_openai_sse(line: &str) -> Vec<StreamDelta> {
    if !line.starts_with("data:") {
        return vec![];
    }
    let data = line[5..].trim();
    if data == "[DONE]" {
        return vec![StreamDelta {
            done: true,
            ..Default::default()
        }];
    }
    let v: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let mut delta = StreamDelta::default();

    if let Some(usage) = v.get("usage").filter(|u| !u.is_null()) {
        delta.prompt_tokens = usage["prompt_tokens"].as_u64();
        delta.completion_tokens = usage["completion_tokens"].as_u64();
    }

    if let Some(choices) = v["choices"].as_array() {
        if let Some(choice) = choices.first() {
            let d = &choice["delta"];
            if let Some(reasoning) = d["reasoning_content"].as_str() {
                if !reasoning.is_empty() {
                    delta.reasoning = Some(reasoning.to_string());
                }
            }
            if let Some(content) = d["content"].as_str() {
                if !content.is_empty() {
                    delta.content = Some(content.to_string());
                }
            }
            if let Some(tcs) = d["tool_calls"].as_array() {
                for tc in tcs {
                    let index = tc["index"].as_u64().unwrap_or(0) as usize;
                    delta.tool_calls.push(ToolCallDelta {
                        index,
                        id: tc["id"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(String::from),
                        name: tc["function"]["name"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(String::from),
                        arguments: tc["function"]["arguments"].as_str().map(String::from),
                    });
                }
            }
        }
    }

    vec![delta]
}

fn parse_ollama_line(line: &str) -> Vec<StreamDelta> {
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let mut delta = StreamDelta::default();

    if let Some(content) = v["message"]["content"].as_str() {
        if !content.is_empty() {
            delta.content = Some(content.to_string());
        }
    }
    if let Some(tcs) = v["message"]["tool_calls"].as_array() {
        for (idx, tc) in tcs.iter().enumerate() {
            // Ollama emits complete tool calls (arguments as an object).
            let args = if tc["function"]["arguments"].is_string() {
                tc["function"]["arguments"]
                    .as_str()
                    .unwrap_or("{}")
                    .to_string()
            } else {
                tc["function"]["arguments"].to_string()
            };
            delta.tool_calls.push(ToolCallDelta {
                index: idx,
                id: tc["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                name: tc["function"]["name"].as_str().map(String::from),
                arguments: Some(args),
            });
        }
    }
    if v["done"].as_bool() == Some(true) {
        delta.prompt_tokens = v["prompt_eval_count"].as_u64();
        delta.completion_tokens = v["eval_count"].as_u64();
        delta.done = true;
    }

    vec![delta]
}

fn parse_anthropic_sse(line: &str, state: &mut StreamState) -> Vec<StreamDelta> {
    // Anthropic SSE: "event: <type>" lines followed by "data: {json}". We only
    // need the data lines; the JSON itself carries a "type" field.
    if !line.starts_with("data:") {
        return vec![];
    }
    let data = line[5..].trim();
    if data.is_empty() {
        return vec![];
    }
    let v: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let mut delta = StreamDelta::default();
    match v["type"].as_str() {
        Some("message_start") => {
            if let Some(u) = v["message"]["usage"].as_object() {
                delta.prompt_tokens = u.get("input_tokens").and_then(|x| x.as_u64());
                delta.completion_tokens = u.get("output_tokens").and_then(|x| x.as_u64());
            }
        }
        Some("content_block_start") => {
            let idx = v["index"].as_u64().unwrap_or(0) as usize;
            let block = &v["content_block"];
            if block["type"] == "tool_use" {
                let tool_index = state.anth_tool_count;
                state.anth_tool_count += 1;
                state.anth_block_is_tool.insert(idx, tool_index);
                delta.tool_calls.push(ToolCallDelta {
                    index: tool_index,
                    id: block["id"].as_str().map(String::from),
                    name: block["name"].as_str().map(String::from),
                    arguments: None,
                });
            }
        }
        Some("content_block_delta") => {
            let idx = v["index"].as_u64().unwrap_or(0) as usize;
            let d = &v["delta"];
            match d["type"].as_str() {
                Some("text_delta") => {
                    if let Some(t) = d["text"].as_str() {
                        if !t.is_empty() {
                            delta.content = Some(t.to_string());
                        }
                    }
                }
                Some("thinking_delta") => {
                    if let Some(t) = d["thinking"].as_str() {
                        if !t.is_empty() {
                            delta.reasoning = Some(t.to_string());
                        }
                    }
                }
                Some("input_json_delta") => {
                    if let Some(&tool_index) = state.anth_block_is_tool.get(&idx) {
                        if let Some(partial) = d["partial_json"].as_str() {
                            delta.tool_calls.push(ToolCallDelta {
                                index: tool_index,
                                id: None,
                                name: None,
                                arguments: Some(partial.to_string()),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        Some("message_delta") => {
            if let Some(out) = v["usage"]["output_tokens"].as_u64() {
                delta.completion_tokens = Some(out);
            }
        }
        Some("message_stop") => {
            delta.done = true;
        }
        _ => {}
    }

    vec![delta]
}

fn parse_gemini_sse(line: &str, state: &mut StreamState) -> Vec<StreamDelta> {
    // Gemini stream (alt=sse) emits "data: {json}" lines, each a GenerateContent
    // response chunk with candidates[].content.parts[].
    if !line.starts_with("data:") {
        return vec![];
    }
    let data = line[5..].trim();
    if data.is_empty() {
        return vec![];
    }
    let v: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    let mut delta = StreamDelta::default();

    if let Some(um) = v.get("usageMetadata") {
        delta.prompt_tokens = um["promptTokenCount"].as_u64();
        delta.completion_tokens = um["candidatesTokenCount"].as_u64();
    }

    if let Some(candidates) = v["candidates"].as_array() {
        if let Some(cand) = candidates.first() {
            if let Some(parts) = cand["content"]["parts"].as_array() {
                for p in parts {
                    if let Some(text) = p["text"].as_str() {
                        if !text.is_empty() {
                            delta.content = Some(match delta.content.take() {
                                Some(mut s) => {
                                    s.push_str(text);
                                    s
                                }
                                None => text.to_string(),
                            });
                        }
                    }
                    if let Some(fc) = p.get("functionCall").filter(|x| !x.is_null()) {
                        let name = fc["name"].as_str().unwrap_or("");
                        let args = fc["args"].to_string();
                        // Gemini chunks may split functionCalls across SSE events, so
                        // the tool index must persist across the whole response, not
                        // restart per chunk — otherwise a second chunk's call_0 would
                        // collide with the first's and the accumulator would fold them.
                        let tool_idx = state.gemini_tool_count;
                        delta.tool_calls.push(ToolCallDelta {
                            index: tool_idx,
                            id: Some(format!("gemini_call_{}", tool_idx)),
                            name: Some(name.to_string()),
                            arguments: Some(args),
                        });
                        state.gemini_tool_count += 1;
                    }
                }
            }
            // finishReason present => this candidate is complete.
            if cand
                .get("finishReason")
                .map(|r| !r.is_null())
                .unwrap_or(false)
            {
                delta.done = true;
            }
        }
    }

    vec![delta]
}

/// Parse a complete (non-streaming) response body into a normalized result:
/// (assistant_text, reasoning, tool_calls, prompt_tokens, completion_tokens).
pub fn parse_full_response(
    wire: Wire,
    body: &Value,
) -> (
    String,
    String,
    Vec<crate::agent::AccumulatedToolCall>,
    u64,
    u64,
) {
    use crate::agent::AccumulatedToolCall;
    match wire {
        Wire::OpenAI | Wire::Ollama => {
            let msg = if wire.is_ollama() {
                &body["message"]
            } else {
                &body["choices"][0]["message"]
            };
            let content = msg["content"].as_str().unwrap_or("").to_string();
            let reasoning = msg["reasoning_content"].as_str().unwrap_or("").to_string();
            let mut calls = Vec::new();
            if let Some(tcs) = msg["tool_calls"].as_array() {
                for (idx, tc) in tcs.iter().enumerate() {
                    let args = if tc["function"]["arguments"].is_string() {
                        tc["function"]["arguments"]
                            .as_str()
                            .unwrap_or("{}")
                            .to_string()
                    } else {
                        tc["function"]["arguments"].to_string()
                    };
                    calls.push(AccumulatedToolCall {
                        id: tc["id"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                            .unwrap_or_else(|| format!("call_{}", idx)),
                        name: tc["function"]["name"].as_str().unwrap_or("").to_string(),
                        arguments: args,
                    });
                }
            }
            let (pt, ct) = if wire.is_ollama() {
                (
                    body["prompt_eval_count"].as_u64().unwrap_or(0),
                    body["eval_count"].as_u64().unwrap_or(0),
                )
            } else {
                (
                    body["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
                    body["usage"]["completion_tokens"].as_u64().unwrap_or(0),
                )
            };
            (content, reasoning, calls, pt, ct)
        }
        Wire::Anthropic => {
            let mut content = String::new();
            let mut reasoning = String::new();
            let mut calls = Vec::new();
            if let Some(blocks) = body["content"].as_array() {
                let mut idx = 0;
                for b in blocks {
                    match b["type"].as_str() {
                        Some("text") => content.push_str(b["text"].as_str().unwrap_or("")),
                        Some("thinking") => {
                            reasoning.push_str(b["thinking"].as_str().unwrap_or(""))
                        }
                        Some("tool_use") => {
                            calls.push(AccumulatedToolCall {
                                id: b["id"]
                                    .as_str()
                                    .unwrap_or(&format!("call_{}", idx))
                                    .to_string(),
                                name: b["name"].as_str().unwrap_or("").to_string(),
                                arguments: b["input"].to_string(),
                            });
                            idx += 1;
                        }
                        _ => {}
                    }
                }
            }
            let pt = body["usage"]["input_tokens"].as_u64().unwrap_or(0);
            let ct = body["usage"]["output_tokens"].as_u64().unwrap_or(0);
            (content, reasoning, calls, pt, ct)
        }
        Wire::Gemini => {
            let mut content = String::new();
            let mut calls = Vec::new();
            if let Some(parts) = body["candidates"][0]["content"]["parts"].as_array() {
                let mut idx = 0;
                for p in parts {
                    if let Some(t) = p["text"].as_str() {
                        content.push_str(t);
                    }
                    if let Some(fc) = p.get("functionCall").filter(|x| !x.is_null()) {
                        calls.push(AccumulatedToolCall {
                            id: format!("gemini_call_{}", idx),
                            name: fc["name"].as_str().unwrap_or("").to_string(),
                            arguments: fc["args"].to_string(),
                        });
                        idx += 1;
                    }
                }
            }
            let pt = body["usageMetadata"]["promptTokenCount"]
                .as_u64()
                .unwrap_or(0);
            let ct = body["usageMetadata"]["candidatesTokenCount"]
                .as_u64()
                .unwrap_or(0);
            (content, String::new(), calls, pt, ct)
        }
    }
}

/// Does this wire format use line-delimited JSON (Ollama) rather than SSE?
#[allow(dead_code)]
pub fn is_jsonl(wire: Wire) -> bool {
    matches!(wire, Wire::Ollama)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AppConfig {
        AppConfig {
            temperature: 0.5,
            top_p: 0.9,
            max_tokens: Some(2048),
            ..AppConfig::default()
        }
    }

    fn msgs() -> Vec<Value> {
        vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
            json!({ "role": "assistant", "content": "ok", "tool_calls": [
                { "id": "call_1", "type": "function",
                  "function": { "name": "read_file", "arguments": "{\"path\":\"a.txt\"}" } }
            ]}),
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "file body" }),
        ]
    }

    fn tools() -> Vec<Value> {
        vec![json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "read",
                "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
            }
        })]
    }

    #[test]
    fn wire_from_str_resolves_aliases_and_defaults_to_openai() {
        assert!(matches!(Wire::from_str("claude"), Wire::Anthropic));
        assert!(matches!(Wire::from_str("Google"), Wire::Gemini));
        assert!(matches!(Wire::from_str("OLLAMA"), Wire::Ollama));
        assert!(matches!(Wire::from_str("anything-else"), Wire::OpenAI));
    }

    #[test]
    fn wire_from_config_prefers_wire_format_over_provider() {
        let mut config = cfg();
        config.provider = "anthropic".into();
        config.wire_format = "openai".into();
        assert!(matches!(Wire::from_config(&config), Wire::OpenAI));
        config.wire_format = String::new();
        assert!(matches!(Wire::from_config(&config), Wire::Anthropic));
    }

    #[test]
    fn build_url_avoids_duplicate_version_segments() {
        assert_eq!(
            build_url(Wire::Anthropic, "https://api.anthropic.com/v1", "m", true),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            build_url(Wire::Anthropic, "https://api.anthropic.com", "m", true),
            "https://api.anthropic.com/v1/messages"
        );
        let gemini = build_url(
            Wire::Gemini,
            "https://generativelanguage.googleapis.com",
            "models/gemini-2.0-flash",
            true,
        );
        assert_eq!(
            gemini,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse"
        );
        assert!(build_url(Wire::Gemini, "https://g/v1beta", "m", false).ends_with("/models/m:generateContent"));
        assert_eq!(
            build_url(Wire::Ollama, "http://localhost:11434/", "m", true),
            "http://localhost:11434/api/chat"
        );
        assert_eq!(
            build_url(Wire::OpenAI, "https://api.deepseek.com/v1", "m", true),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn openai_body_carries_tools_usage_and_sampling() {
        let body = build_body(Wire::OpenAI, "m", &msgs(), &tools(), &cfg(), true);
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["stream_options"]["include_usage"], json!(true));
        assert_eq!(body["max_tokens"], json!(2048));
        assert_eq!(body["tool_choice"], json!("auto"));
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn openai_body_moves_late_system_messages_to_the_front() {
        let messages = vec![
            json!({ "role": "system", "content": "base" }),
            json!({ "role": "user", "content": "question" }),
            json!({ "role": "assistant", "content": null, "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": { "name": "web_search", "arguments": "{\"query\":\"x\"}" }
            }] }),
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "result" }),
            json!({ "role": "system", "content": "late instruction" }),
        ];
        let body = build_body(Wire::OpenAI, "m", &messages, &tools(), &cfg(), false);
        let normalized = body["messages"].as_array().unwrap();
        assert_eq!(normalized[0]["role"], "system");
        assert_eq!(normalized[0]["content"], "base\n\nlate instruction");
        assert!(normalized
            .iter()
            .skip(1)
            .all(|message| message["role"] != "system"));
        assert_eq!(normalized[3]["role"], "tool");
    }

    #[test]
    fn ollama_body_passes_tools_through_and_maps_max_tokens() {
        let body = build_body(Wire::Ollama, "m", &msgs(), &tools(), &cfg(), true);
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
        assert_eq!(body["options"]["num_predict"], json!(2048));
        assert_eq!(body["options"]["temperature"], json!(0.5));
    }

    #[test]
    fn anthropic_body_moves_system_out_and_converts_tool_traffic() {
        let body = build_body(Wire::Anthropic, "m", &msgs(), &tools(), &cfg(), false);
        assert_eq!(body["system"], json!("sys"));
        let conv = body["messages"].as_array().unwrap();
        // system removed from messages; assistant tool_call became tool_use block;
        // tool result became a user-role tool_result block
        assert!(conv.iter().all(|m| m["role"] != "system"));
        let assistant = &conv[1];
        assert_eq!(assistant["content"][1]["type"], json!("tool_use"));
        assert_eq!(assistant["content"][1]["id"], json!("call_1"));
        let result_msg = &conv[2];
        assert_eq!(result_msg["role"], json!("user"));
        assert_eq!(result_msg["content"][0]["type"], json!("tool_result"));
        assert_eq!(result_msg["content"][0]["tool_use_id"], json!("call_1"));
        // Anthropic tool shape uses input_schema
        assert!(body["tools"][0]["input_schema"].is_object());
        // max_tokens is mandatory
        assert_eq!(body["max_tokens"], json!(2048));
    }

    #[test]
    fn gemini_body_converts_roles_tools_and_schema() {
        let body = build_body(Wire::Gemini, "m", &msgs(), &tools(), &cfg(), true);
        assert!(body["systemInstruction"]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("sys"));
        let contents = body["contents"].as_array().unwrap();
        // assistant -> model role
        assert!(contents.iter().any(|c| c["role"] == "model"));
        let decl = &body["tools"][0]["functionDeclarations"][0];
        assert_eq!(decl["name"], json!("read_file"));
    }

    #[test]
    fn parse_openai_sse_extracts_content_reasoning_tools_and_usage() {
        let mut state = StreamState::default();
        let line = r#"data: {"choices":[{"delta":{"content":"hey","reasoning_content":"think","tool_calls":[{"index":0,"id":"c1","function":{"name":"grep","arguments":"{\"pat"}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":3}}"#;
        let deltas = parse_stream_line(Wire::OpenAI, line, &mut state);
        assert_eq!(deltas.len(), 1);
        let d = &deltas[0];
        assert_eq!(d.content.as_deref(), Some("hey"));
        assert_eq!(d.reasoning.as_deref(), Some("think"));
        assert_eq!(d.tool_calls[0].name.as_deref(), Some("grep"));
        assert_eq!(d.prompt_tokens, Some(10));
        assert!(!d.done);
        let done = parse_stream_line(Wire::OpenAI, "data: [DONE]", &mut state);
        assert!(done[0].done);
    }

    #[test]
    fn parse_anthropic_sse_assigns_stable_tool_indices() {
        let mut state = StreamState::default();
        // text block at index 0, tool_use blocks at indexes 1 and 2
        parse_stream_line(
            Wire::Anthropic,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}"#,
            &mut state,
        );
        parse_stream_line(
            Wire::Anthropic,
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"a1","name":"grep"}}"#,
            &mut state,
        );
        let frag = parse_stream_line(
            Wire::Anthropic,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"x\":1}"}}"#,
            &mut state,
        );
        assert_eq!(frag[0].tool_calls[0].index, 0);
        assert_eq!(
            frag[0].tool_calls[0].arguments.as_deref(),
            Some("{\"x\":1}")
        );
        parse_stream_line(
            Wire::Anthropic,
            r#"data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"a2","name":"glob"}}"#,
            &mut state,
        );
        let frag2 = parse_stream_line(
            Wire::Anthropic,
            r#"data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}"#,
            &mut state,
        );
        // second tool block gets the next tool index, not a restart at 0
        assert_eq!(frag2[0].tool_calls[0].index, 1);
    }

    #[test]
    fn parse_ollama_line_reads_message_and_done() {
        let mut state = StreamState::default();
        let line = r#"{"message":{"content":"hi","tool_calls":[{"function":{"name":"grep","arguments":{"p":"x"}}}]},"done":true,"prompt_eval_count":7,"eval_count":2}"#;
        let deltas = parse_stream_line(Wire::Ollama, line, &mut state);
        let d = &deltas[0];
        assert_eq!(d.content.as_deref(), Some("hi"));
        assert_eq!(d.tool_calls[0].name.as_deref(), Some("grep"));
        assert!(d.done);
        assert_eq!(d.prompt_tokens, Some(7));
    }

    #[test]
    fn parse_gemini_sse_counts_tool_calls_across_chunks() {
        let mut state = StreamState::default();
        let one = parse_stream_line(
            Wire::Gemini,
            r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"grep","args":{"p":1}}}]}}]}"#,
            &mut state,
        );
        let two = parse_stream_line(
            Wire::Gemini,
            r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"glob","args":{}}}]}}]}"#,
            &mut state,
        );
        assert_eq!(one[0].tool_calls[0].index, 0);
        assert_eq!(
            two[0].tool_calls[0].index, 1,
            "tool indices must not restart per chunk"
        );
    }

    #[test]
    fn parse_full_response_openai_and_anthropic() {
        let openai = json!({ "choices": [{ "message": {
            "content": "done", "reasoning_content": "r",
            "tool_calls": [{ "id": "c9", "function": { "name": "grep", "arguments": { "p": "x" } } }]
        }}], "usage": { "prompt_tokens": 5, "completion_tokens": 6 }});
        let (content, reasoning, calls, pt, ct) = parse_full_response(Wire::OpenAI, &openai);
        assert_eq!(content, "done");
        assert_eq!(reasoning, "r");
        assert_eq!(calls[0].id, "c9");
        // non-string arguments objects are serialized, not dropped
        assert!(calls[0].arguments.contains("\"p\""));
        assert_eq!((pt, ct), (5, 6));

        let anthropic = json!({ "content": [
            { "type": "text", "text": "hello" },
            { "type": "thinking", "thinking": "hmm" },
            { "type": "tool_use", "id": "t1", "name": "grep", "input": { "p": 1 } }
        ], "usage": { "input_tokens": 3, "output_tokens": 4 }});
        let (content, reasoning, calls, pt, ct) = parse_full_response(Wire::Anthropic, &anthropic);
        assert_eq!(content, "hello");
        assert_eq!(reasoning, "hmm");
        assert_eq!(calls[0].name, "grep");
        assert_eq!((pt, ct), (3, 4));
    }

    #[test]
    fn gemini_schema_sanitizer_strips_unsupported_keys() {
        let dirty = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": { "x": { "type": "string", "default": "a" } }
        });
        let clean = sanitize_gemini_schema(&dirty);
        assert!(clean.get("additionalProperties").is_none());
        assert!(clean["properties"]["x"].get("default").is_none());
    }
}
