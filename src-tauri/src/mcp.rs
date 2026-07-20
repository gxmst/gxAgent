use crate::config::McpServerConfig;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

type PendingMap = std::sync::Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
const MCP_REQUEST_TIMEOUT_SECS: u64 = 20;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub status: String,
    pub tool_count: usize,
    pub tool_names: Vec<String>,
    pub error: Option<String>,
}

pub struct McpStartReport {
    pub tool_definitions: Vec<Value>,
    pub servers: Vec<McpServerStatus>,
}

/// Running MCP server process with its tool definitions
pub struct McpServer {
    child: Child,
    stdin: Mutex<tokio::process::ChildStdin>,
    tool_definitions: Vec<Value>,
    next_id: Mutex<u64>,
    pending: PendingMap,
    _reader_handle: tokio::task::JoinHandle<()>,
    _stderr_handle: tokio::task::JoinHandle<()>,
}

/// Validate MCP server command before starting
fn validate_mcp_command(command: &str) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("MCP command cannot be empty".to_string());
    }

    if command.contains('\0') || command.contains('\n') || command.contains('\r') {
        return Err("MCP command contains invalid characters".to_string());
    }

    // Plain executable names such as `npx`, `uvx`, `node`, or `python` are resolved by PATH.
    if !command.contains('\\') && !command.contains('/') {
        return Ok(());
    }

    let path = std::path::Path::new(command);
    if !path.exists() {
        return Err(format!("MCP command path does not exist: {}", command));
    }
    if !path.is_file() {
        return Err(format!("MCP command is not a file: {}", command));
    }

    Ok(())
}

/// Validate environment variables to prevent malicious injection
fn validate_env_vars(env: &std::collections::HashMap<String, String>) -> Result<(), String> {
    // Block environment variables that commonly inject code/config into child
    // runtimes. PATH and proxy variables are intentionally not blocked because
    // many legitimate MCP setups rely on them; this is a hard denylist for
    // high-risk injection hooks, not a full sandbox.
    let dangerous_vars = [
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "PYTHONHOME",
        "RUBYOPT",
        "PERL5OPT",
        "BASH_ENV",
        "ENV",
        "GIT_CONFIG",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
    ];

    for var in env.keys() {
        let upper = var.to_ascii_uppercase();
        let blocked = dangerous_vars.iter().any(|dangerous| upper == *dangerous)
            || upper.starts_with("GIT_CONFIG_");
        if blocked {
            return Err(format!(
                "Environment variable '{}' is not allowed for security reasons",
                var
            ));
        }
    }

    Ok(())
}

impl McpServer {
    /// Start an MCP server process and initialize it
    pub async fn start(config: &McpServerConfig) -> Result<Self, String> {
        // Validate command path
        validate_mcp_command(&config.command)?;

        // Validate environment variables
        validate_env_vars(&config.env)?;

        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start MCP server '{}': {}", config.command, e))?;

        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

        let pending: PendingMap = std::sync::Arc::new(Mutex::new(HashMap::new()));

        let reader_pending = pending.clone();
        let reader_handle = tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                        let mut map = reader_pending.lock().await;
                        if let Some(sender) = map.remove(&id) {
                            if let Some(error) = msg.get("error") {
                                let _ = sender.send(Err(error.to_string()));
                            } else {
                                let _ = sender.send(Ok(msg));
                            }
                        }
                    }
                }
            }
            let mut map = reader_pending.lock().await;
            for (_, sender) in map.drain() {
                let _ = sender.send(Err("MCP server closed its output stream".to_string()));
            }
        });

        let stderr_handle = tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    eprintln!("[MCP stderr] {}", line);
                }
            }
        });

        let stdin = Mutex::new(stdin);
        let mut server = McpServer {
            child,
            stdin,
            tool_definitions: Vec::new(),
            next_id: Mutex::new(1),
            pending,
            _reader_handle: reader_handle,
            _stderr_handle: stderr_handle,
        };

        // Send initialize request
        let _init_result = server
            .send_request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "gxAgent",
                        "version": "1.0.0"
                    }
                }),
            )
            .await?;

        // Send initialized notification
        server
            .send_notification("notifications/initialized", json!({}))
            .await?;

        // Fetch tool definitions
        let tools_result = server.send_request("tools/list", json!({})).await?;
        if let Some(tools) = tools_result["result"]["tools"].as_array() {
            server.tool_definitions = tools.clone();
        }

        Ok(server)
    }

    /// Send a JSON-RPC request and wait for the response via oneshot channel
    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = {
            let mut next_id = self.next_id.lock().await;
            let id = *next_id;
            *next_id += 1;
            id
        };

        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        // Register a oneshot channel for this request id
        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.pending.lock().await;
            map.insert(id, tx);
        }

        self.write_message(&request).await.inspect_err(|_e| {
            if let Ok(mut map) = self.pending.try_lock() {
                map.remove(&id);
            }
        })?;

        // Wait for the reader task to deliver the response
        match tokio::time::timeout(std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECS), rx)
            .await
        {
            Ok(result) => result.map_err(|_| "MCP server closed connection".to_string())?,
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!(
                    "MCP request '{}' timed out after {}s",
                    method, MCP_REQUEST_TIMEOUT_SECS
                ))
            }
        }
    }

    /// Send a JSON-RPC notification (no response expected)
    async fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let notification = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        self.write_message(&notification).await
    }

    /// Call a tool on this MCP server
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<String, String> {
        let result = self
            .send_request(
                "tools/call",
                json!({
                    "name": name,
                    "arguments": arguments
                }),
            )
            .await?;

        // Extract text content from the result
        if let Some(content) = result["result"]["content"].as_array() {
            let texts: Vec<String> = content
                .iter()
                .filter_map(|c| {
                    if c["type"] == "text" {
                        c["text"].as_str().map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            return Ok(texts.join("\n"));
        }

        Ok(result.to_string())
    }

    /// Get the tool definitions from this server
    pub fn tool_definitions(&self) -> &[Value] {
        &self.tool_definitions
    }

    /// Write a JSON-RPC message to stdin
    async fn write_message(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let mut content = serde_json::to_string(message).map_err(|e| e.to_string())?;
        content.push('\n');
        stdin
            .write_all(content.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to MCP server: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush MCP server stdin: {}", e))?;
        Ok(())
    }

    /// Kill the server process
    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

/// Convert an MCP-native tool definition (`{name, description, inputSchema}`)
/// into the canonical OpenAI function shape the rest of the agent (and the
/// provider adapters) expect. Servers keep the native shape internally for
/// `tools/call` routing; only the definitions handed to the LLM are converted.
fn mcp_tool_to_openai(tool: &Value) -> Value {
    let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
    let description = tool
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    let parameters = tool
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        }
    })
}

/// Manager for all MCP server connections
pub struct McpManager {
    servers: HashMap<String, McpServer>,
}

impl McpManager {
    pub fn new() -> Self {
        McpManager {
            servers: HashMap::new(),
        }
    }

    /// Start all configured MCP servers and collect their tool definitions
    pub async fn start_all(
        &mut self,
        configs: &HashMap<String, McpServerConfig>,
    ) -> McpStartReport {
        let mut all_tools = Vec::new();
        let mut statuses = Vec::with_capacity(configs.len());

        for (name, config) in configs {
            match McpServer::start(config).await {
                Ok(server) => {
                    let tools = server.tool_definitions().to_vec();
                    let tool_names = tools
                        .iter()
                        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect::<Vec<_>>();
                    statuses.push(McpServerStatus {
                        name: name.clone(),
                        status: "started".to_string(),
                        tool_count: tools.len(),
                        tool_names,
                        error: None,
                    });
                    all_tools.extend(tools.iter().map(mcp_tool_to_openai));
                    self.servers.insert(name.clone(), server);
                }
                Err(e) => {
                    eprintln!("Failed to start MCP server '{}': {}", name, e);
                    statuses.push(McpServerStatus {
                        name: name.clone(),
                        status: "error".to_string(),
                        tool_count: 0,
                        tool_names: Vec::new(),
                        error: Some(e),
                    });
                }
            }
        }

        McpStartReport {
            tool_definitions: all_tools,
            servers: statuses,
        }
    }

    /// Route a tool call by tool name — searches all servers for the tool
    pub async fn route_tool_call(
        &mut self,
        tool_name: &str,
        arguments: Value,
    ) -> Result<String, String> {
        for (server_name, server) in self.servers.iter() {
            for tool_def in server.tool_definitions() {
                if tool_def["name"].as_str() == Some(tool_name) {
                    return server
                        .call_tool(tool_name, arguments)
                        .await
                        .map_err(|e| format!("MCP server '{}': {}", server_name, e));
                }
            }
        }
        Err(format!("Unknown tool: {}", tool_name))
    }

    /// Shutdown all servers
    pub async fn shutdown(&mut self) {
        for (_, server) in self.servers.iter_mut() {
            server.kill().await;
        }
        self.servers.clear();
    }
}

pub async fn test_server(name: String, config: McpServerConfig) -> McpServerStatus {
    match McpServer::start(&config).await {
        Ok(mut server) => {
            let tool_names = server
                .tool_definitions()
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect::<Vec<_>>();
            server.kill().await;
            McpServerStatus {
                name,
                status: "ready".to_string(),
                tool_count: tool_names.len(),
                tool_names,
                error: None,
            }
        }
        Err(error) => McpServerStatus {
            name,
            status: "error".to_string(),
            tool_count: 0,
            tool_names: Vec::new(),
            error: Some(error),
        },
    }
}

/// Fetch available models from a local Ollama instance
pub async fn fetch_ollama_models(base_url: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Ollama API error ({}): {}", status, error_text));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;

    let models = body["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let name = m["name"].as_str().unwrap_or("unknown").to_string();
            json!({
                "id": name,
                "object": "model",
                "owned_by": "ollama"
            })
        })
        .collect();

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_tool_definitions_convert_to_openai_function_shape() {
        let native = json!({
            "name": "query_db",
            "description": "Run a read-only SQL query",
            "inputSchema": {
                "type": "object",
                "properties": { "sql": { "type": "string" } },
                "required": ["sql"]
            }
        });
        let converted = mcp_tool_to_openai(&native);
        assert_eq!(converted["type"], "function");
        assert_eq!(converted["function"]["name"], "query_db");
        assert_eq!(
            converted["function"]["description"],
            "Run a read-only SQL query"
        );
        assert_eq!(converted["function"]["parameters"], native["inputSchema"]);
    }

    #[test]
    fn mcp_tool_without_schema_gets_empty_object_parameters() {
        let native = json!({ "name": "no_args_tool" });
        let converted = mcp_tool_to_openai(&native);
        assert_eq!(converted["function"]["name"], "no_args_tool");
        assert_eq!(converted["function"]["parameters"]["type"], "object");
    }
}
