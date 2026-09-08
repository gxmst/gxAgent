use crate::config::McpServerConfig;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

type PendingMap = std::sync::Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
const MCP_REQUEST_TIMEOUT_SECS: u64 = 20;
const MCP_MAX_FRAME_BYTES: u64 = 8 * 1024 * 1024;

async fn read_frame(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<String>, String> {
    let mut line = String::new();
    let bytes = reader
        .take(MCP_MAX_FRAME_BYTES + 1)
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;
    if bytes as u64 > MCP_MAX_FRAME_BYTES {
        return Err("MCP message exceeds the 8 MB limit".into());
    }
    Ok((bytes > 0).then_some(line))
}

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

impl Drop for McpServer {
    fn drop(&mut self) {
        // Descendant processes may keep pipes open after the server exits.
        self._reader_handle.abort();
        self._stderr_handle.abort();
    }
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
            let mut reader = BufReader::new(stdout);
            let failure = loop {
                let line = match read_frame(&mut reader).await {
                    Ok(Some(line)) => line,
                    Ok(None) => break "MCP server closed its output stream".to_string(),
                    Err(error) => break error,
                };
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
            };
            let mut map = reader_pending.lock().await;
            for (_, sender) in map.drain() {
                let _ = sender.send(Err(failure.clone()));
            }
        });

        let stderr_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            while let Ok(Some(line)) = read_frame(&mut reader).await {
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
        let init_result = server
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
        let version = init_result["result"]["protocolVersion"]
            .as_str()
            .ok_or("MCP initialize omitted protocolVersion")?;
        if !["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].contains(&version) {
            return Err(format!("Unsupported MCP protocol version: {version}"));
        }
        if !init_result["result"]["capabilities"]["tools"].is_object() {
            return Err("MCP server does not advertise tools capability".into());
        }

        // Send initialized notification
        server
            .send_notification("notifications/initialized", json!({}))
            .await?;

        // Fetch tool definitions
        let mut cursor = None;
        let mut cursors = std::collections::HashSet::new();
        let mut names = std::collections::HashSet::new();
        loop {
            let params = cursor
                .as_ref()
                .map(|c| json!({"cursor":c}))
                .unwrap_or(json!({}));
            let tools_result = server.send_request("tools/list", params).await?;
            let tools = tools_result["result"]["tools"]
                .as_array()
                .ok_or("Invalid MCP tools/list response")?;
            for tool in tools {
                let name = tool["name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("Invalid MCP tool name")?;
                if !names.insert(name.to_owned()) {
                    return Err(format!("Duplicate MCP tool: {name}"));
                }
                server.tool_definitions.push(tool.clone());
            }
            if server.tool_definitions.len() > 1000 {
                return Err("MCP tool catalog exceeds 1000 tools".into());
            }
            cursor = tools_result["result"]["nextCursor"]
                .as_str()
                .map(str::to_string);
            match &cursor {
                Some(c) if !cursors.insert(c.clone()) || cursors.len() > 32 => {
                    return Err("Invalid MCP pagination cursor".into())
                }
                Some(_) => {}
                None => break,
            }
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

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECS),
            async {
                self.write_message(&request).await?;
                rx.await
                    .map_err(|_| "MCP server closed connection".to_string())?
            },
        )
        .await
        .map_err(|_| format!("MCP request '{method}' timed out after {MCP_REQUEST_TIMEOUT_SECS}s"));
        self.pending.lock().await.remove(&id);
        result?
    }

    /// Send a JSON-RPC notification (no response expected)
    async fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let notification = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        tokio::time::timeout(
            std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECS),
            self.write_message(&notification),
        )
        .await
        .map_err(|_| "MCP notification timed out".to_string())?
    }

    /// Call a tool on this MCP server
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<String, String> {
        let result = self.call_tool_raw(name, arguments).await?;
        let output = serde_json::to_string(&result).map_err(|e| e.to_string())?;
        if result["isError"].as_bool() == Some(true) {
            Err(format!("MCP tool failed: {output}"))
        } else {
            Ok(output)
        }
    }

    pub async fn call_tool_raw(&self, name: &str, arguments: Value) -> Result<Value, String> {
        let tool = self
            .tool_definitions
            .iter()
            .find(|t| t["name"].as_str() == Some(name))
            .ok_or("Unknown MCP tool")?;
        if !arguments.is_object() {
            return Err("Tool arguments must be a JSON object".into());
        }
        if let Some(schema) = tool.get("inputSchema") {
            let validator = jsonschema::validator_for(schema)
                .map_err(|e| format!("Invalid tool schema: {e}"))?;
            if let Err(error) = validator.validate(&arguments) {
                return Err(format!("Invalid tool arguments: {error}"));
            }
        }
        let result = self
            .send_request(
                "tools/call",
                json!({
                    "name": name,
                    "arguments": arguments
                }),
            )
            .await?;
        result
            .get("result")
            .filter(|v| v.is_object())
            .cloned()
            .ok_or("Invalid MCP tools/call response".into())
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
        if content.len() as u64 > MCP_MAX_FRAME_BYTES {
            return Err("MCP message exceeds the 8 MB limit".into());
        }
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
        self._reader_handle.abort();
        self._stderr_handle.abort();
        for (_, sender) in self.pending.lock().await.drain() {
            let _ = sender.send(Err("MCP server stopped".into()));
        }
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
                    all_tools.extend(tools.iter().map(|tool| {
                        let mut definition = mcp_tool_to_openai(tool);
                        definition["function"]["name"] =
                            json!(tool_alias(name, tool["name"].as_str().unwrap_or_default()));
                        definition["function"]["description"] = json!(format!(
                            "[{} / {}] {}",
                            name,
                            tool["name"].as_str().unwrap_or_default(),
                            tool["description"].as_str().unwrap_or_default()
                        ));
                        definition
                    }));
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
                let original = tool_def["name"].as_str().unwrap_or_default();
                if tool_alias(server_name, original) == tool_name {
                    return server
                        .call_tool(original, arguments)
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

fn tool_alias(server: &str, tool: &str) -> String {
    let digest = Sha256::digest(format!("{server}\0{tool}").as_bytes());
    let readable: String = tool
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(30)
        .collect();
    format!("mcp_{}_{readable}", hex::encode(&digest[..10]))
}

#[tauri::command]
pub async fn inspect_mcp_tools(config: McpServerConfig) -> Result<Vec<Value>, String> {
    let mut server = McpServer::start(&config).await?;
    let tools = server.tool_definitions().to_vec();
    server.kill().await;
    Ok(tools)
}

#[tauri::command]
pub async fn call_mcp_debug(
    config: McpServerConfig,
    tool: String,
    arguments: Value,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let mut server = McpServer::start(&config).await?;
    let result = server.call_tool_raw(&tool, arguments).await;
    server.kill().await;
    result.map(|result| json!({"result": result, "durationMs": started.elapsed().as_millis()}))
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

    #[tokio::test]
    async fn framing_preserves_messages_and_rejects_oversize_input() {
        let mut reader = BufReader::new(&b"one\ntwo\n"[..]);
        assert_eq!(
            read_frame(&mut reader).await.unwrap().as_deref(),
            Some("one\n")
        );
        assert_eq!(
            read_frame(&mut reader).await.unwrap().as_deref(),
            Some("two\n")
        );
        assert!(read_frame(&mut reader).await.unwrap().is_none());
        let input = vec![b'x'; MCP_MAX_FRAME_BYTES as usize + 1];
        assert!(read_frame(&mut BufReader::new(input.as_slice()))
            .await
            .unwrap_err()
            .contains("8 MB"));
    }

    #[test]
    fn aliases_isolate_servers_and_fit_model_tool_name_limits() {
        assert_ne!(
            tool_alias("first", "read_file"),
            tool_alias("second", "read_file")
        );
        let alias = tool_alias("docs/server", &"tool!".repeat(100));
        assert!(alias.len() <= 64);
        assert!(alias.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    }

    #[test]
    #[ignore = "subprocess fixture, launched by the stdio integration test"]
    fn protocol_fixture() {
        use std::io::{BufRead, Write};
        if std::env::var("GX_MCP_FIXTURE").as_deref() != Ok("1") {
            return;
        }
        for line in std::io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let Some(id) = request.get("id") else {
                continue;
            };
            let result = match request["method"].as_str().unwrap_or("") {
                "initialize" => json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}}}),
                "tools/list" => {
                    if request["params"]["cursor"].is_string() {
                        json!({"tools":[{"name":"second","inputSchema":{"type":"object"}}]})
                    } else {
                        json!({"tools":[{"name":"echo","inputSchema":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}],"nextCursor":"page2"})
                    }
                }
                "tools/call" => {
                    json!({"content":[{"type":"text","text":"response"}],"structuredContent":{"value":request["params"]["arguments"]["value"]},"isError":request["params"]["arguments"]["value"]=="fail"})
                }
                _ => json!({}),
            };
            println!("{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
            std::io::stdout().flush().unwrap();
        }
    }

    #[tokio::test]
    async fn stdio_catalog_pagination_validation_and_errors() {
        let config = McpServerConfig {
            command: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: vec![
                "--ignored".into(),
                "--exact".into(),
                "mcp::tests::protocol_fixture".into(),
                "--nocapture".into(),
            ],
            env: HashMap::from([("GX_MCP_FIXTURE".into(), "1".into())]),
        };
        let mut server = McpServer::start(&config).await.unwrap();
        assert_eq!(server.tool_definitions().len(), 2);
        assert!(server
            .call_tool("echo", json!({"value":42}))
            .await
            .unwrap_err()
            .contains("Invalid tool arguments"));
        let raw = server
            .call_tool_raw("echo", json!({"value":"hello"}))
            .await
            .unwrap();
        assert_eq!(raw["structuredContent"]["value"], "hello");
        assert!(server
            .call_tool("echo", json!({"value":"fail"}))
            .await
            .unwrap_err()
            .contains("MCP tool failed"));
        server.kill().await;
    }

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
