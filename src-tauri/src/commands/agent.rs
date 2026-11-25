use crate::agent::{self, ImageAttachment};
use crate::config::AppConfig;
use crate::provider;
use crate::tools;
use crate::{codex, mcp, workspace};
use serde_json::{json, Value};
use tauri::Emitter;

/// Start an agent session with the given config and prompt
// Tauri command: the parameter list is the frontend invoke contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_agent_session(
    window: tauri::Window,
    request_id: Option<String>,
    prompt: String,
    config: AppConfig,
    session_messages: Vec<Value>,
    session_mode: Option<String>,
    search_mode: Option<String>,
    image_attachments: Option<Vec<ImageAttachment>>,
    codex_thread_id: Option<String>,
    retrieval_query: Option<String>,
) -> Result<(), String> {
    workspace::ensure_workspace_dir(&config.default_work_dir, false)?;
    let mode = session_mode.unwrap_or_else(|| "chat".to_string());
    let smode = search_mode.unwrap_or_else(|| "auto".to_string());
    let images = image_attachments.unwrap_or_default();
    let request_id = request_id.unwrap_or_else(|| {
        format!(
            "req-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        )
    });
    let query = retrieval_query.unwrap_or_else(|| prompt.clone());
    let result = if mode == "code" && config.code_engine == "codex" {
        codex::run(
            window.clone(),
            request_id.clone(),
            prompt,
            config,
            session_messages,
            codex_thread_id,
            images,
            query,
        )
        .await
    } else {
        agent::start_agent_loop(
            window.clone(),
            request_id.clone(),
            prompt,
            config,
            session_messages,
            mode,
            smode,
            images,
            query,
        )
        .await
    };
    if let Err(ref e) = result {
        let _ = window.emit(
            "agent-stream-chunk",
            json!({
                "requestId": request_id,
                "content": format!("\nError: {}\n", e),
            }),
        );
        let _ = window.emit(
            "agent-stream-done",
            json!({
                "requestId": request_id,
                "content": format!("Error: {}", e),
                "loopCount": 0,
                "ttftMs": 0,
                "responseTimeMs": 0,
            }),
        );
        let _ = window.emit(
            "agent-complete",
            json!({
                "requestId": request_id,
                "status": "error",
            }),
        );
        return Ok(());
    }
    result
}

/// Resolve a pending tool approval request from the frontend
#[tauri::command]
pub async fn resolve_tool_approval(
    request_id: String,
    approved_ids: Vec<String>,
    rejected_ids: Vec<String>,
) -> Result<(), String> {
    if let Some(result) = codex::approve(&request_id, &approved_ids, &rejected_ids).await {
        return result;
    }
    let mut results: Vec<(String, bool)> = Vec::new();
    for id in approved_ids {
        results.push((id, true));
    }
    for id in rejected_ids {
        results.push((id, false));
    }
    agent::resolve_approval(&request_id, results).await
}

/// Cancel an active agent session by request id
#[tauri::command]
pub async fn cancel_agent_session(request_id: String) -> Result<(), String> {
    if let Some(result) = codex::interrupt(&request_id).await {
        return result;
    }
    agent::cancel_agent_request(&request_id).await
}

/// Fetch available models for the given wire format (OpenAI/Anthropic/Gemini).
#[tauri::command]
pub async fn fetch_models(
    base_url: String,
    api_key: String,
    wire_format: Option<String>,
) -> Result<Vec<Value>, String> {
    let wire = provider::Wire::from_str(&wire_format.unwrap_or_default());
    agent::fetch_models(wire, &base_url, &api_key).await
}

/// Check if Python is available on the system
#[tauri::command]
pub async fn check_python_available() -> bool {
    tools::check_python_available().await
}

/// Fetch available models from a local Ollama instance
#[tauri::command]
pub async fn fetch_ollama_models(base_url: String) -> Result<Vec<Value>, String> {
    mcp::fetch_ollama_models(&base_url).await
}

/// Push a steering message into the agent's intervention queue
#[tauri::command]
pub async fn push_steering_message(message: String, request_id: String) -> Result<(), String> {
    if let Some(result) = codex::steer(&request_id, message.clone()).await {
        return result;
    }
    agent::push_steering_message(request_id, message).await;
    Ok(())
}

/// Answer a native `ask_user_question` tool prompt
#[tauri::command]
pub async fn answer_agent_question(
    interaction_id: String,
    answers: std::collections::HashMap<String, Vec<String>>,
) -> Result<(), String> {
    agent::resolve_question(&interaction_id, answers).await
}
