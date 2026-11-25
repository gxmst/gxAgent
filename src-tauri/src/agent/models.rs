use crate::provider;
use serde_json::{json, Value};

/// Fetch the available model list for the given wire format. Each provider
/// exposes a different models endpoint, auth scheme, and response shape; this
/// normalizes them all into `[{ "id": "<model>" }, ...]`.
pub async fn fetch_models(
    wire: provider::Wire,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let base = base_url.trim_end_matches('/');

    match wire {
        provider::Wire::Gemini => {
            // Gemini: GET /v1beta/models?key=API_KEY -> { models: [{ name: "models/x" }] }
            if api_key.is_empty() {
                return Err("Gemini requires an API key to list models.".to_string());
            }
            let prefix = if base.contains("/v1beta") || base.ends_with("/v1") {
                base.to_string()
            } else {
                format!("{}/v1beta", base)
            };
            let url = format!("{}/models", prefix);
            let body =
                fetch_models_json(client.get(&url).header("x-goog-api-key", api_key)).await?;
            let models = body["models"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|m| {
                    // Strip the "models/" prefix so the id matches what the user types.
                    let name = m["name"].as_str()?;
                    let id = name.strip_prefix("models/").unwrap_or(name);
                    // Gemini reports the context window as inputTokenLimit;
                    // surface it under the same key OpenAI-compatible lists use
                    // so the frontend has one field to read.
                    let mut model = json!({ "id": id });
                    if let Some(limit) = m["inputTokenLimit"].as_u64() {
                        model["context_length"] = json!(limit);
                    }
                    Some(model)
                })
                .collect();
            Ok(models)
        }
        provider::Wire::Anthropic => {
            // Anthropic: GET /v1/models with x-api-key + version -> { data: [{ id }] }
            if api_key.is_empty() {
                return Err("Anthropic requires an API key to list models.".to_string());
            }
            // Don't double up /v1 when the user already typed the versioned URL.
            let url = if base.ends_with("/v1") {
                format!("{}/models", base)
            } else {
                format!("{}/v1/models", base)
            };
            let request = client
                .get(&url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01");
            let body = fetch_models_json(request).await?;
            Ok(extract_openai_shaped_models(&body))
        }
        provider::Wire::Ollama => {
            // Ollama has its own command (fetch_ollama_models); shouldn't reach here.
            Err("Use the Ollama model fetch for local models.".to_string())
        }
        provider::Wire::OpenAI => {
            // OpenAI-compatible: GET /models with Bearer -> { data: [{ id }] }
            let url = format!("{}/models", base);
            let mut request = client.get(&url).header("Content-Type", "application/json");
            if !api_key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", api_key));
            }
            let body = fetch_models_json(request).await?;
            Ok(extract_openai_shaped_models(&body))
        }
    }
}

async fn fetch_models_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Models API error ({}): {}", status, error_text));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {}", e))
}

fn extract_openai_shaped_models(body: &Value) -> Vec<Value> {
    body["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m["id"].as_str().is_some())
        .collect()
}
