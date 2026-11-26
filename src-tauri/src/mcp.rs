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

enum McpTransport {
    Stdio {
        child: Option<Child>,
        stdin: std::sync::Arc<Mutex<tokio::process::ChildStdin>>,
        pending: PendingMap,
        reader_handle: tokio::task::JoinHandle<()>,
        closed: std::sync::Arc<std::sync::atomic::AtomicBool>,
        stderr_handle: tokio::task::JoinHandle<()>,
    },
    Http(HttpTransport),
}

struct HttpTransport {
    client: reqwest::Client,
    config: McpServerConfig,
    session: Mutex<HttpSession>,
}

#[derive(Default)]
enum HttpSession {
    #[default]
    Stateless,
    Active(String),
    Expired,
    Closed,
}

impl HttpTransport {
    async fn post(&self, message: &Value) -> Result<reqwest::Response, String> {
        let mut request = self
            .client
            .post(self.config.url.trim())
            .header("Accept", "application/json, text/event-stream");
        for (key, value) in &self.config.headers {
            request = request.header(key.trim(), value);
        }
        let mut session = self.session.lock().await;
        match &*session {
            HttpSession::Active(id) => request = request.header("Mcp-Session-Id", id),
            HttpSession::Stateless => {}
            HttpSession::Expired | HttpSession::Closed => {
                return Err("MCP HTTP session is closed".into())
            }
        }
        let response = request
            .json(message)
            .send()
            .await
            .map_err(|e| format!("MCP HTTP request failed: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND && matches!(*session, HttpSession::Active(_)) {
            *session = HttpSession::Expired;
            return Err("MCP HTTP session expired (404)".into());
        }
        if !status.is_success() {
            let body = read_http_bytes(response).await?;
            return Err(format!(
                "MCP HTTP error ({status}): {}",
                String::from_utf8_lossy(&body)
            ));
        }
        if let Some(id) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            *session = HttpSession::Active(id.to_owned());
        }
        Ok(response)
    }
}

/// Running MCP server connection (stdio subprocess or Streamable HTTP/SSE) with its tool definitions
pub struct McpServer {
    transport: McpTransport,
    tool_definitions: Vec<Value>,
    next_id: Mutex<u64>,
}

impl Drop for McpServer {
    fn drop(&mut self) {
        if let McpTransport::Stdio {
            child,
            reader_handle,
            stderr_handle,
            ..
        } = &mut self.transport
        {
            // Descendant processes may keep pipes open after the server exits.
            reader_handle.abort();
            stderr_handle.abort();
            if let Some(mut proc) = child.take() {
                if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                    runtime.spawn(async move {
                        crate::tools::terminate_process_tree(&mut proc).await;
                    });
                } else {
                    let _ = proc.start_kill();
                }
            }
        }
    }
}

pub(crate) fn is_http_transport(config: &McpServerConfig) -> bool {
    let t = config.transport.trim();
    t.eq_ignore_ascii_case("http") || t.eq_ignore_ascii_case("sse")
}

fn validate_http_mcp(config: &McpServerConfig) -> Result<(), String> {
    let url_str = config.url.trim();
    if url_str.is_empty() {
        return Err("MCP URL cannot be empty".into());
    }
    let parsed = reqwest::Url::parse(url_str).map_err(|e| format!("Invalid MCP URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("MCP URL must use http:// or https://".into());
    }
    if parsed.host_str().is_none() {
        return Err("MCP URL must include a host".into());
    }
    for (k, v) in &config.headers {
        let key = k.trim();
        if key.is_empty() || key.contains(['\r', '\n', '\0', ':']) || v.contains(['\r', '\n', '\0'])
        {
            return Err(format!("Invalid MCP HTTP header: '{k}'"));
        }
    }
    Ok(())
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

    let mut names = std::collections::HashSet::new();
    for var in env.keys() {
        if var.is_empty() || var.contains(['=', '\0']) || env[var].contains('\0') {
            return Err("Invalid MCP environment variable".into());
        }
        let upper = var.to_ascii_uppercase();
        if !names.insert(upper.clone()) {
            return Err("Duplicate MCP environment variable names".into());
        }
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

pub fn validate_server_config(config: &McpServerConfig) -> Result<(), String> {
    if is_http_transport(config) {
        return validate_http_mcp(config);
    }
    if !config.transport.trim().is_empty() && !config.transport.eq_ignore_ascii_case("stdio") {
        return Err(format!("Unsupported MCP transport '{}'", config.transport));
    }
    validate_mcp_command(&config.command)?;
    validate_env_vars(&config.env)?;
    if config.args.iter().any(|arg| arg.contains('\0')) {
        return Err("MCP arguments contain a NUL character".into());
    }
    Ok(())
}

fn server_command(config: &McpServerConfig) -> Command {
    #[cfg(windows)]
    {
        // npm installs npx.cmd on Windows. Invoke its JS entry through Node so
        // JSON arguments never pass through cmd.exe quoting or interpolation.
        let path = std::path::Path::new(config.command.trim());
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if stem.eq_ignore_ascii_case("npx") || stem.eq_ignore_ascii_case("npm") {
            let task_path = config
                .env
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("PATH"))
                .map(|(_, value)| std::ffi::OsString::from(value))
                .unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default());
            let mut folders = Vec::new();
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                folders.push(parent.to_path_buf());
            }
            folders.extend(std::env::split_paths(&task_path));
            for folder in &folders {
                let script = folder.join(format!(
                    "node_modules/npm/bin/{}-cli.js",
                    stem.to_ascii_lowercase()
                ));
                if script.is_file() {
                    if let Some(node) = folders
                        .iter()
                        .map(|dir| dir.join("node.exe"))
                        .find(|node| node.is_file())
                    {
                        let mut command = Command::new(node);
                        command.arg(script);
                        return command;
                    }
                }
            }
        }
    }
    Command::new(config.command.trim())
}

struct PendingRequestGuard {
    pending: PendingMap,
    id: u64,
    stdin: std::sync::Arc<Mutex<tokio::process::ChildStdin>>,
}
impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        let pending = self.pending.clone();
        let id = self.id;
        let stdin = self.stdin.clone();
        tokio::spawn(async move {
            if pending.lock().await.remove(&id).is_some() {
                let cancelled = json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"Client cancelled or timed out"}});
                let write = async {
                    let mut input = stdin.lock().await;
                    input.write_all(format!("{cancelled}\n").as_bytes()).await?;
                    input.flush().await
                };
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), write).await;
            }
        });
    }
}

fn select_rpc_response(value: Value, id: u64) -> Option<Result<Value, String>> {
    if let Value::Array(batch) = value {
        return batch
            .into_iter()
            .find_map(|item| select_rpc_response(item, id));
    }
    if value.get("id").and_then(Value::as_u64) != Some(id) || value.get("method").is_some() {
        return None;
    }
    if let Some(error) = value.get("error") {
        return Some(Err(error.to_string()));
    }
    value.get("result")?;
    Some(Ok(value))
}

#[derive(Default)]
struct SseResponse {
    line: Vec<u8>,
    data: Vec<u8>,
    after_cr: bool,
}

impl SseResponse {
    fn push(&mut self, chunk: &[u8], id: u64) -> Option<Result<Value, String>> {
        for &byte in chunk {
            if byte == b'\n' && self.after_cr {
                self.after_cr = false;
                continue;
            }
            self.after_cr = byte == b'\r';
            if matches!(byte, b'\r' | b'\n') {
                if let Some(response) = self.end_line(id) {
                    return Some(response);
                }
            } else {
                self.line.push(byte);
            }
        }
        None
    }

    fn end_line(&mut self, id: u64) -> Option<Result<Value, String>> {
        if self.line.is_empty() {
            if self.data.is_empty() {
                return None;
            }
            let message = serde_json::from_slice(&self.data).ok();
            self.data.clear();
            return message.and_then(|value| select_rpc_response(value, id));
        }
        if let Some(value) = self.line.strip_prefix(b"data:") {
            self.data
                .extend_from_slice(value.strip_prefix(b" ").unwrap_or(value));
            self.data.push(b'\n');
        }
        self.line.clear();
        None
    }

    fn finish(&mut self, id: u64) -> Result<Value, String> {
        self.end_line(id)
            .or_else(|| self.end_line(id))
            .unwrap_or_else(|| Err("MCP SSE stream omitted matching request id".into()))
    }
}

fn check_http_size(total: usize) -> Result<(), String> {
    if total as u64 > MCP_MAX_FRAME_BYTES {
        Err("MCP HTTP response exceeds the 8 MB limit".into())
    } else {
        Ok(())
    }
}

async fn read_http_bytes(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to read MCP body: {e}"))?
    {
        check_http_size(body.len().saturating_add(chunk.len()))?;
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn read_http_rpc(mut response: reqwest::Response, id: u64) -> Result<Value, String> {
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("text/event-stream")
        });
    let mut sse = SseResponse::default();
    if is_sse {
        let mut total = 0usize;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Failed to read MCP event: {e}"))?
        {
            total = total.saturating_add(chunk.len());
            check_http_size(total)?;
            if let Some(result) = sse.push(&chunk, id) {
                return result;
            }
        }
        return sse.finish(id);
    }
    let body = read_http_bytes(response).await?;
    let body = body.trim_ascii_start();
    if body.starts_with(b"event:") || body.starts_with(b"data:") {
        return sse.push(body, id).unwrap_or_else(|| sse.finish(id));
    }
    let message = serde_json::from_slice(body)
        .map_err(|e| format!("Invalid JSON from MCP HTTP server: {e}"))?;
    select_rpc_response(message, id).ok_or("MCP HTTP response omitted matching request id")?
}

impl McpServer {
    async fn start_stdio_transport(config: &McpServerConfig) -> Result<McpTransport, String> {
        let mut cmd = server_command(config);
        cmd.args(&config.args)
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        #[cfg(not(windows))]
        cmd.process_group(0);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start MCP server '{}': {}", config.command, e))?;

        let stdin =
            std::sync::Arc::new(Mutex::new(child.stdin.take().ok_or("Failed to get stdin")?));
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

        let pending: PendingMap = std::sync::Arc::new(Mutex::new(HashMap::new()));
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        let reader_pending = pending.clone();
        let reader_closed = closed.clone();
        let reader_stdin = stdin.clone();
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
                    if let Some(method) = msg.get("method").and_then(Value::as_str) {
                        if let Some(id) = msg.get("id") {
                            let reply = if method == "ping" {
                                json!({"jsonrpc":"2.0","id":id,"result":{}})
                            } else {
                                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client does not support this server request"}})
                            };
                            let write = async {
                                let mut input = reader_stdin.lock().await;
                                input.write_all(format!("{reply}\n").as_bytes()).await?;
                                input.flush().await
                            };
                            let _ = tokio::time::timeout(
                                std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECS),
                                write,
                            )
                            .await;
                        }
                        continue;
                    }
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
            reader_closed.store(true, std::sync::atomic::Ordering::Release);
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

        Ok(McpTransport::Stdio {
            child: Some(child),
            stdin,
            pending,
            reader_handle,
            closed,
            stderr_handle,
        })
    }

    fn start_http_transport(config: &McpServerConfig) -> Result<McpTransport, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("Failed to build MCP HTTP client: {e}"))?;
        Ok(McpTransport::Http(HttpTransport {
            client,
            config: config.clone(),
            session: Mutex::default(),
        }))
    }

    /// Start an MCP server connection (stdio or HTTP/SSE) and initialize it
    pub async fn start(config: &McpServerConfig) -> Result<Self, String> {
        validate_server_config(config)?;

        let transport = if is_http_transport(config) {
            Self::start_http_transport(config)?
        } else {
            Self::start_stdio_transport(config).await?
        };

        let mut server = McpServer {
            transport,
            tool_definitions: Vec::new(),
            next_id: Mutex::new(1),
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
                        "version": env!("CARGO_PKG_VERSION")
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
                if let Some(schema) = tool.get("inputSchema") {
                    if !schema.is_object() {
                        return Err(format!("Invalid input schema for MCP tool '{name}'"));
                    }
                    jsonschema::validator_for(schema)
                        .map_err(|e| format!("Invalid input schema for MCP tool '{name}': {e}"))?;
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

    pub async fn is_alive(&mut self) -> bool {
        match &mut self.transport {
            McpTransport::Stdio { child, closed, .. } => {
                if closed.load(std::sync::atomic::Ordering::Acquire) {
                    return false;
                }
                match child.as_mut() {
                    Some(proc) => matches!(proc.try_wait(), Ok(None)),
                    None => false,
                }
            }
            McpTransport::Http(http) => matches!(
                *http.session.lock().await,
                HttpSession::Active(_) | HttpSession::Stateless
            ),
        }
    }

    /// Send a JSON-RPC request and wait for the response
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

        match &self.transport {
            McpTransport::Stdio {
                stdin,
                pending,
                closed,
                ..
            } => {
                let (tx, rx) = oneshot::channel();
                {
                    let mut map = pending.lock().await;
                    if closed.load(std::sync::atomic::Ordering::Acquire) {
                        return Err("MCP server closed connection".into());
                    }
                    map.insert(id, tx);
                }
                let _guard = PendingRequestGuard {
                    pending: pending.clone(),
                    id,
                    stdin: stdin.clone(),
                };

                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECS),
                    async {
                        Self::write_stdio_message(stdin, &request).await?;
                        rx.await
                            .map_err(|_| "MCP server closed connection".to_string())?
                    },
                )
                .await
                .map_err(|_| {
                    format!("MCP request '{method}' timed out after {MCP_REQUEST_TIMEOUT_SECS}s")
                });
                if result.is_ok() {
                    pending.lock().await.remove(&id);
                }
                result?
            }
            McpTransport::Http(http) => read_http_rpc(http.post(&request).await?, id).await,
        }
    }

    /// Send a JSON-RPC notification (no response expected)
    async fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let notification = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        match &self.transport {
            McpTransport::Stdio { stdin, .. } => tokio::time::timeout(
                std::time::Duration::from_secs(MCP_REQUEST_TIMEOUT_SECS),
                Self::write_stdio_message(stdin, &notification),
            )
            .await
            .map_err(|_| "MCP notification timed out".to_string())?,
            McpTransport::Http(http) => http.post(&notification).await.map(|_| ()),
        }
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

    /// Write a JSON-RPC message to stdio stdin
    async fn write_stdio_message(
        stdin_lock: &Mutex<tokio::process::ChildStdin>,
        message: &Value,
    ) -> Result<(), String> {
        let mut stdin = stdin_lock.lock().await;
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

    /// Kill / close the server connection
    pub async fn kill(&mut self) {
        match &mut self.transport {
            McpTransport::Stdio {
                child,
                pending,
                reader_handle,
                closed,
                stderr_handle,
                ..
            } => {
                {
                    let mut map = pending.lock().await;
                    closed.store(true, std::sync::atomic::Ordering::Release);
                    for (_, sender) in map.drain() {
                        let _ = sender.send(Err("MCP server stopped".into()));
                    }
                }
                if let Some(mut proc) = child.take() {
                    crate::tools::terminate_process_tree(&mut proc).await;
                }
                reader_handle.abort();
                stderr_handle.abort();
            }
            McpTransport::Http(http) => {
                *http.session.lock().await = HttpSession::Closed;
            }
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

struct PooledMcpEntry {
    config: McpServerConfig,
    server: std::sync::Arc<Mutex<McpServer>>,
}

static GLOBAL_MCP_POOL: once_cell::sync::Lazy<Mutex<HashMap<String, PooledMcpEntry>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

pub async fn stop_pooled_server(name: &str) {
    let removed = GLOBAL_MCP_POOL.lock().await.remove(name);
    if let Some(entry) = removed {
        entry.server.lock().await.kill().await;
    }
}

pub async fn shutdown_all_pooled_servers() {
    let entries: Vec<_> = GLOBAL_MCP_POOL
        .lock()
        .await
        .drain()
        .map(|(_, entry)| entry)
        .collect();
    for entry in entries {
        entry.server.lock().await.kill().await;
    }
}

#[tauri::command]
pub async fn stop_mcp_server(name: String) -> Result<(), String> {
    stop_pooled_server(name.trim()).await;
    Ok(())
}

/// Manager for all MCP server connections (either request-scoped or backed by GLOBAL_MCP_POOL)
pub struct McpManager {
    servers: HashMap<String, std::sync::Arc<Mutex<McpServer>>>,
    tool_routes: HashMap<String, (String, String)>,
    pooled: bool,
}

impl McpManager {
    #[cfg(test)]
    pub fn new() -> Self {
        McpManager {
            servers: HashMap::new(),
            tool_routes: HashMap::new(),
            pooled: false,
        }
    }

    pub fn pooled() -> Self {
        McpManager {
            servers: HashMap::new(),
            tool_routes: HashMap::new(),
            pooled: true,
        }
    }

    pub fn has_tool(&self, name: &str) -> bool {
        self.tool_routes.contains_key(name)
    }

    fn record_server_tools(
        &mut self,
        name: &str,
        server: std::sync::Arc<Mutex<McpServer>>,
        tools: &[Value],
        all_tools: &mut Vec<Value>,
        statuses: &mut Vec<McpServerStatus>,
    ) {
        let tool_names = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>();
        statuses.push(McpServerStatus {
            name: name.to_string(),
            status: "started".to_string(),
            tool_count: tools.len(),
            tool_names,
            error: None,
        });
        for tool in tools {
            let orig = tool["name"].as_str().unwrap_or_default().to_string();
            let alias = tool_alias(name, &orig);
            self.tool_routes
                .insert(alias.clone(), (name.to_string(), orig.clone()));
            let mut definition = mcp_tool_to_openai(tool);
            definition["function"]["name"] = json!(alias);
            definition["function"]["description"] = json!(format!(
                "[{} / {}] {}",
                name,
                orig,
                tool["description"].as_str().unwrap_or_default()
            ));
            all_tools.push(definition);
        }
        self.servers.insert(name.to_string(), server);
    }

    /// Start (or reuse from pool) all configured MCP servers and collect their tool definitions
    pub async fn start_all(
        &mut self,
        configs: &HashMap<String, McpServerConfig>,
    ) -> McpStartReport {
        let mut all_tools = Vec::new();
        let mut statuses = Vec::with_capacity(configs.len());
        self.servers.clear();
        self.tool_routes.clear();

        let mut to_start: Vec<(String, McpServerConfig)> = Vec::new();

        if self.pooled {
            let mut stale = Vec::new();
            let mut candidates = Vec::new();
            {
                let mut pool = GLOBAL_MCP_POOL.lock().await;
                let existing_keys: Vec<String> = pool.keys().cloned().collect();
                for key in existing_keys {
                    let keep = configs
                        .get(&key)
                        .is_some_and(|cfg| pool.get(&key).is_some_and(|e| e.config == *cfg));
                    if !keep {
                        if let Some(entry) = pool.remove(&key) {
                            stale.push(entry.server);
                        }
                    }
                }
                for (name, config) in configs {
                    if let Some(entry) = pool.get(name) {
                        if entry.config == *config {
                            candidates.push((name.clone(), entry.server.clone()));
                            continue;
                        }
                    }
                    to_start.push((name.clone(), config.clone()));
                }
            }
            for s in stale {
                s.lock().await.kill().await;
            }
            for (name, server) in candidates {
                let mut guard = server.lock().await;
                let alive = guard.is_alive().await;
                let tools = guard.tool_definitions().to_vec();
                drop(guard);
                if alive {
                    self.record_server_tools(&name, server, &tools, &mut all_tools, &mut statuses);
                } else {
                    if let Some(dead) = GLOBAL_MCP_POOL.lock().await.remove(&name) {
                        dead.server.lock().await.kill().await;
                    }
                    if let Some(cfg) = configs.get(&name) {
                        to_start.push((name, cfg.clone()));
                    }
                }
            }
        } else {
            to_start = configs
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
        }

        for (name, config) in to_start {
            match McpServer::start(&config).await {
                Ok(server) => {
                    let tools = server.tool_definitions().to_vec();
                    let arc = std::sync::Arc::new(Mutex::new(server));
                    if self.pooled {
                        let replaced = GLOBAL_MCP_POOL.lock().await.insert(
                            name.clone(),
                            PooledMcpEntry {
                                config: config.clone(),
                                server: arc.clone(),
                            },
                        );
                        if let Some(old) = replaced {
                            old.server.lock().await.kill().await;
                        }
                    }
                    self.record_server_tools(&name, arc, &tools, &mut all_tools, &mut statuses);
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
        let Some((server_name, original_tool)) = self.tool_routes.get(tool_name).cloned() else {
            return Err(format!("Unknown tool: {}", tool_name));
        };
        let Some(server) = self.servers.get(&server_name).cloned() else {
            return Err(format!("MCP server '{}' is not connected", server_name));
        };
        let mut srv = server.lock().await;
        if let McpTransport::Http(http) = &srv.transport {
            if matches!(*http.session.lock().await, HttpSession::Expired) {
                *srv = McpServer::start(&http.config).await?;
            }
        }
        srv.call_tool(&original_tool, arguments)
            .await
            .map_err(|e| format!("MCP server '{}': {}", server_name, e))
    }

    /// Release request-scoped handle (and shut down processes when not pooled)
    pub async fn shutdown(&mut self) {
        self.tool_routes.clear();
        if self.pooled {
            self.servers.clear();
            return;
        }
        for (_, server) in self.servers.drain() {
            server.lock().await.kill().await;
        }
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
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
    fn environment_names_cannot_collide_after_case_folding() {
        let env = HashMap::from([("PATH".into(), "one".into()), ("Path".into(), "two".into())]);
        assert!(validate_env_vars(&env).unwrap_err().contains("Duplicate"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_npx_passes_literal_arguments_through_node() {
        let task_path = std::env::var_os("PATH").unwrap();
        let node_folder = std::env::split_paths(&task_path)
            .find(|folder| folder.join("node.exe").is_file())
            .expect("Node.js is required for the Windows MCP regression test");
        let root = std::env::temp_dir().join(format!("gxagent-npx-{}", uuid::Uuid::new_v4()));
        let folder = root.join("node_modules/npm/bin");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("npx-cli.js"),
            "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
        )
        .unwrap();
        let arguments = vec![
            "a,b".into(),
            "C:\\folder with spaces\\tool".into(),
            "x & echo injected".into(),
            "$(literal)".into(),
        ];
        let config = McpServerConfig {
            transport: "stdio".into(),
            command: root.join("npx.cmd").to_string_lossy().into_owned(),
            args: arguments.clone(),
            env: HashMap::from([("PATH".into(), node_folder.to_string_lossy().into_owned())]),
            url: String::new(),
            headers: HashMap::new(),
        };
        let result = server_command(&config)
            .args(&config.args)
            .output()
            .await
            .unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(result.status.success());
        assert_eq!(
            serde_json::from_slice::<Vec<String>>(&result.stdout).unwrap(),
            arguments
        );
    }

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
        let mut cancelled = false;
        for line in std::io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if request["method"] == "notifications/cancelled" {
                cancelled = true;
                continue;
            }
            if request.get("method").is_none() {
                continue;
            }
            let Some(id) = request.get("id") else {
                continue;
            };
            let result = match request["method"].as_str().unwrap_or("") {
                "initialize" => {
                    if std::env::var("GX_MCP_BEHAVIOR").as_deref() == Ok("ping") {
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":id,"method":"ping","params":{}})
                        );
                        std::io::stdout().flush().unwrap();
                    }
                    json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}}})
                }
                "tools/list" => {
                    if std::env::var("GX_MCP_BEHAVIOR").as_deref() == Ok("bad-schema") {
                        json!({"tools":[{"name":"bad","inputSchema":{"type":123}}]})
                    } else if request["params"]["cursor"].is_string() {
                        json!({"tools":[{"name":"second","inputSchema":{"type":"object"}}]})
                    } else {
                        json!({"tools":[{"name":"echo","inputSchema":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}],"nextCursor":"page2"})
                    }
                }
                "tools/call" => {
                    if request["params"]["arguments"]["value"] == "wait" {
                        continue;
                    }
                    if request["params"]["arguments"]["value"] == "close" {
                        std::process::exit(0);
                    }
                    json!({"content":[{"type":"text","text":"response"}],"structuredContent":{"value":request["params"]["arguments"]["value"],"cancelled":cancelled,"server":std::env::var("GX_MCP_TAG").unwrap_or_default()},"isError":request["params"]["arguments"]["value"]=="fail"})
                }
                _ => json!({}),
            };
            println!("{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
            std::io::stdout().flush().unwrap();
        }
    }

    fn fixture_config() -> McpServerConfig {
        McpServerConfig {
            transport: "stdio".into(),
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
            url: String::new(),
            headers: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn server_requests_do_not_steal_client_response_ids() {
        let mut config = fixture_config();
        config.env.insert("GX_MCP_BEHAVIOR".into(), "ping".into());
        let mut server = McpServer::start(&config).await.unwrap();
        assert_eq!(server.tool_definitions().len(), 2);
        server.kill().await;
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(1),
            server.call_tool_raw("echo", json!({"value":"after shutdown"}))
        )
        .await
        .unwrap()
        .unwrap_err()
        .contains("closed"));
    }

    #[tokio::test]
    async fn cancelled_calls_release_pending_requests_and_notify_server() {
        let mut server = McpServer::start(&fixture_config()).await.unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            server.call_tool_raw("echo", json!({"value":"wait"}))
        )
        .await
        .is_err());
        let output = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let result = server
                    .call_tool_raw("echo", json!({"value":"next"}))
                    .await
                    .unwrap();
                if result["structuredContent"]["cancelled"] == true {
                    break result;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(output["structuredContent"]["value"], "next");
        if let McpTransport::Stdio { pending, .. } = &server.transport {
            assert!(pending.lock().await.is_empty());
        } else {
            panic!("expected stdio transport");
        }
        server.kill().await;
    }

    #[tokio::test]
    async fn closed_servers_fail_promptly_and_bad_catalog_schemas_are_rejected() {
        let mut server = McpServer::start(&fixture_config()).await.unwrap();
        let closed = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            server.call_tool_raw("echo", json!({"value":"close"})),
        )
        .await
        .unwrap();
        assert!(closed.is_err());
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(1),
            server.call_tool_raw("echo", json!({"value":"next"}))
        )
        .await
        .unwrap()
        .is_err());
        server.kill().await;
        let mut invalid = fixture_config();
        invalid
            .env
            .insert("GX_MCP_BEHAVIOR".into(), "bad-schema".into());
        assert!(McpServer::start(&invalid)
            .await
            .err()
            .unwrap()
            .contains("schema"));
    }

    #[tokio::test]
    async fn manager_routes_same_named_tools_to_the_correct_server() {
        let mut first = fixture_config();
        first.env.insert("GX_MCP_TAG".into(), "first".into());
        let mut second = fixture_config();
        second.env.insert("GX_MCP_TAG".into(), "second".into());
        let mut manager = McpManager::new();
        let report = manager
            .start_all(&HashMap::from([
                ("first".into(), first),
                ("second".into(), second),
            ]))
            .await;
        assert_eq!(report.tool_definitions.len(), 4);
        assert!(!manager.has_tool("echo"));
        for name in ["first", "second"] {
            let alias = tool_alias(name, "echo");
            assert!(manager.has_tool(&alias));
            let result = manager
                .route_tool_call(&alias, json!({"value":"hello"}))
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&result).unwrap()["structuredContent"]["server"],
                name
            );
            assert!(manager
                .route_tool_call(&alias, json!({"value":"fail"}))
                .await
                .unwrap_err()
                .contains("MCP tool failed"));
        }
        manager.shutdown().await;
        assert!(!manager.has_tool(&tool_alias("first", "echo")));
    }

    #[tokio::test]
    async fn stdio_catalog_pagination_validation_and_errors() {
        let config = McpServerConfig {
            transport: "stdio".into(),
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
            url: String::new(),
            headers: HashMap::new(),
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

    #[test]
    fn http_and_sse_rpc_responses_are_parsed_by_id() {
        let json_body = r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#;
        let parsed = select_rpc_response(serde_json::from_str(json_body).unwrap(), 7)
            .unwrap()
            .unwrap();
        assert_eq!(parsed["id"], 7);
        assert!(select_rpc_response(json!({"result":{}}), 7).is_none());
        assert!(select_rpc_response(json!({"id":7,"method":"ping"}), 7).is_none());
        let mut multiline = SseResponse::default();
        let fixture = "data: {\"id\":7,\r\ndata: \"result\":\"例\"}\r\n\r\n";
        let parsed = fixture
            .as_bytes()
            .chunks(1)
            .find_map(|chunk| multiline.push(chunk, 7))
            .unwrap()
            .unwrap();
        assert_eq!(parsed["result"], "例");

        let sse_body = concat!(
            "event: message\n",
            "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n",
            "event: message\n",
            "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}\n\n",
        );
        let mut parser = SseResponse::default();
        let parsed_sse = sse_body
            .as_bytes()
            .chunks(3)
            .find_map(|chunk| parser.push(chunk, 7))
            .unwrap()
            .unwrap();
        assert_eq!(parsed_sse["result"]["content"][0]["text"], "ok");
    }

    #[tokio::test]
    async fn http_streams_return_before_eof_and_expired_calls_are_not_replayed() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let fixture = tokio::spawn(async move {
            let mut streams = Vec::new();
            for index in 0..8 {
                let mut stream = BufReader::new(listener.accept().await.unwrap().0);
                let mut line = String::new();
                let mut len = 0;
                let mut session = None;
                loop {
                    line.clear();
                    assert!(stream.read_line(&mut line).await.unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            len = value.trim().parse().unwrap();
                        }
                        if name.eq_ignore_ascii_case("mcp-session-id") {
                            session = Some(value.trim().to_owned());
                        }
                    }
                }
                let mut body = vec![0; len];
                stream.read_exact(&mut body).await.unwrap();
                let request: Value = serde_json::from_slice(&body).unwrap();
                let generation = if index < 4 { "first" } else { "second" };
                let method = [
                    "initialize",
                    "notifications/initialized",
                    "tools/list",
                    "tools/call",
                ][index % 4];
                assert_eq!(request["method"], method);
                assert_eq!(
                    session.as_deref(),
                    (method != "initialize").then_some(generation)
                );
                let mut socket = stream.into_inner();
                let id = &request["id"];
                let response = |result| json!({"jsonrpc":"2.0", "id":id, "result":result});
                let (status, headers, body) = match method {
                    "initialize" => (
                        "200 OK",
                        format!("Mcp-Session-Id: {generation}\r\n"),
                        response(
                            json!({"protocolVersion":"2025-03-26","capabilities":{"tools":{}}}),
                        )
                        .to_string(),
                    ),
                    "notifications/initialized" => ("202 Accepted", String::new(), String::new()),
                    "tools/list" => {
                        let result = response(json!({"tools":[{"name":"echo"}]}));
                        let event = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n: heartbeat\r\n\r\ndata: {{\"id\":88,\"result\":false}}\r\n\r\ndata: {result}\r\n\r\n");
                        socket.write_all(event.as_bytes()).await.unwrap();
                        streams.push(socket); // Leave the SSE response open while the next POST arrives.
                        continue;
                    }
                    _ => {
                        assert_eq!(request["params"]["arguments"]["value"], generation);
                        if index == 3 {
                            ("404 Not Found", String::new(), String::new())
                        } else {
                            (
                                "200 OK",
                                String::new(),
                                response(json!({"content":[]})).to_string(),
                            )
                        }
                    }
                };
                let reply = format!("HTTP/1.1 {status}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        let server: McpServerConfig =
            serde_json::from_value(json!({"url":url, "transport":"http"})).unwrap();
        let mut manager = McpManager::new();
        tokio::time::timeout(std::time::Duration::from_secs(8), async {
            let report = manager
                .start_all(&HashMap::from([("test".into(), server)]))
                .await;
            assert_eq!(report.tool_definitions.len(), 1, "{:?}", report.servers);
            let alias = tool_alias("test", "echo");
            let err = manager
                .route_tool_call(&alias, json!({"value":"first"}))
                .await
                .unwrap_err();
            assert!(err.contains("expired (404)"));
            let ok = manager
                .route_tool_call(&alias, json!({"value":"second"}))
                .await
                .unwrap();
            assert!(ok.contains("content"));
            fixture.await.unwrap();
        })
        .await
        .expect("a matching SSE event must finish the request promptly");
    }

    #[test]
    fn http_mcp_validation_accepts_http_and_rejects_bad_urls_or_headers() {
        let ok = McpServerConfig {
            transport: "http".into(),
            command: String::new(),
            args: Vec::new(),
            env: HashMap::new(),
            url: "http://127.0.0.1:8080/mcp".into(),
            headers: HashMap::from([("Authorization".into(), "Bearer test".into())]),
        };
        assert!(validate_server_config(&ok).is_ok());

        let bad_scheme = McpServerConfig {
            url: "file:///etc/passwd".into(),
            ..ok.clone()
        };
        assert!(validate_server_config(&bad_scheme).is_err());

        let bad_header = McpServerConfig {
            headers: HashMap::from([("Bad:Header".into(), "x".into())]),
            ..ok
        };
        assert!(validate_server_config(&bad_header).is_err());
    }
}
