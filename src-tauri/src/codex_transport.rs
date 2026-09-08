use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub struct CodexTransport {
    child: Option<Child>,
    stdin: Box<dyn AsyncWrite + Unpin + Send>,
    messages: mpsc::Receiver<Result<Value, String>>,
    reader: JoinHandle<()>,
    stderr_reader: Option<JoinHandle<()>>,
    deferred: VecDeque<Value>,
    sequence: u64,
}

pub fn resolve_executable(configured: &str) -> Result<PathBuf, String> {
    let configured = configured.trim();
    let configured = if configured.is_empty() {
        "codex"
    } else {
        configured
    };
    if configured != "codex" {
        let path = PathBuf::from(configured);
        if !path.is_file() {
            return Err(
                "Codex executable was not found. Select its executable in engine settings.".into(),
            );
        }
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                ["cmd", "bat", "ps1"]
                    .iter()
                    .any(|wrapper| ext.eq_ignore_ascii_case(wrapper))
            })
        {
            return Err("Select the Codex executable, not a shell wrapper.".into());
        }
        return Ok(path);
    }
    for folder in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let binary = folder.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        if binary.is_file() {
            return Ok(binary);
        }
        #[cfg(windows)]
        {
            let arch = if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            };
            let triple = if arch == "arm64" {
                "aarch64-pc-windows-msvc"
            } else {
                "x86_64-pc-windows-msvc"
            };
            for prefix in [
                "node_modules/@openai/codex/node_modules/@openai",
                "node_modules/@openai",
            ] {
                for leaf in ["bin/codex.exe", "codex/codex.exe"] {
                    let candidate = folder
                        .join(prefix)
                        .join(format!("codex-win32-{arch}/vendor/{triple}/{leaf}"));
                    if candidate.is_file() {
                        return Ok(candidate);
                    }
                }
            }
        }
    }
    Err("Codex is not installed or is not on PATH. Install Codex CLI or select its executable in engine settings.".into())
}

impl CodexTransport {
    pub async fn connect(executable: &str) -> Result<Self, String> {
        let mut command = Command::new(resolve_executable(executable)?);
        command
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start Codex: {error}"))?;
        let stdin = child.stdin.take().ok_or("Codex stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Codex stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Codex stderr unavailable")?;
        let mut transport = Self::from_io(stdin, stdout);
        transport.child = Some(child);
        // Always drain stderr; a full pipe otherwise stalls a healthy server.
        transport.stderr_reader = Some(tokio::spawn(async move {
            let _ = tokio::io::copy(&mut BufReader::new(stderr), &mut tokio::io::sink()).await;
        }));
        transport.call("initialize", json!({"clientInfo":{"name":"gxagent","title":"gxAgent","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        transport
            .send(json!({"method":"initialized","params":{}}))
            .await?;
        Ok(transport)
    }

    pub(crate) fn from_io(
        stdin: impl AsyncWrite + Unpin + Send + 'static,
        stdout: impl AsyncRead + Unpin + Send + 'static,
    ) -> Self {
        let (tx, messages) = mpsc::channel(256);
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                let message = match lines.next_line().await {
                    Ok(Some(line)) if line.len() <= 16 * 1024 * 1024 => serde_json::from_str(&line)
                        .map_err(|error| format!("Invalid Codex event: {error}")),
                    Ok(Some(_)) => Err("Codex event exceeds the 16 MB limit".into()),
                    Ok(None) => break,
                    Err(error) => Err(format!("Codex connection closed: {error}")),
                };
                let failed = message.is_err();
                if tx.send(message).await.is_err() || failed {
                    break;
                }
            }
        });
        Self {
            child: None,
            stdin: Box::new(stdin),
            messages,
            reader,
            stderr_reader: None,
            deferred: VecDeque::new(),
            sequence: 0,
        }
    }

    pub async fn send(&mut self, message: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|error| format!("Could not send to Codex: {error}"))?;
        self.stdin.flush().await.map_err(|error| error.to_string())
    }

    pub async fn request(&mut self, method: &str, params: Value) -> Result<u64, String> {
        self.sequence += 1;
        let id = self.sequence;
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        Ok(id)
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.request(method, params).await?;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let message = self.messages.recv().await.ok_or("Codex exited before replying")??;
                if message.get("method").is_none() && message["id"] == id {
                    return response_result(message);
                }
                if method == "initialize" && message.get("id").is_some() && message.get("method").is_some() {
                    self.send(json!({"id":message["id"],"error":{"code":-32601,"message":"Interaction is unavailable during initialization"}})).await?;
                } else {
                    self.deferred.push_back(message);
                }
            }
        }).await.map_err(|_| format!("Codex {method} timed out"))?
    }

    pub async fn next(&mut self) -> Result<Value, String> {
        if let Some(message) = self.deferred.pop_front() {
            return Ok(message);
        }
        self.messages
            .recv()
            .await
            .ok_or("Codex exited before the turn completed")?
    }

    pub async fn close(&mut self) {
        let _ = self.stdin.shutdown().await;
        if let Some(child) = &mut self.child {
            if tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
        }
        self.reader.abort();
        if let Some(reader) = &self.stderr_reader {
            reader.abort();
        }
    }
}

impl Drop for CodexTransport {
    fn drop(&mut self) {
        self.reader.abort();
        if let Some(reader) = &self.stderr_reader {
            reader.abort();
        }
    }
}

pub fn response_result(message: Value) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        return Err(error["message"]
            .as_str()
            .unwrap_or("Codex request failed")
            .to_string());
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| "Codex response has no result".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn startup_preserves_events_and_server_requests_until_the_driver_takes_over() {
        let (client, server) = tokio::io::duplex(16 * 1024);
        let (input, output) = tokio::io::split(client);
        let mut rpc = CodexTransport::from_io(output, input);
        let (input, mut output) = tokio::io::split(server);
        let mut lines = BufReader::new(input).lines();
        let server = async {
            let request: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            for message in [
                json!({"method":"item/started","params":{"item":{"id":"command"}}}),
                json!({"id":"approval","method":"item/commandExecution/requestApproval","params":{}}),
                json!({"id":request["id"],"result":{"turn":{"id":"turn"}}}),
            ] {
                let mut bytes = serde_json::to_vec(&message).unwrap();
                bytes.push(b'\n');
                output.write_all(&bytes).await.unwrap();
            }
        };
        let (turn, ()) = tokio::join!(rpc.call("turn/start", json!({})), server);
        assert_eq!(turn.unwrap()["turn"]["id"], "turn");
        assert_eq!(rpc.next().await.unwrap()["method"], "item/started");
        assert_eq!(rpc.next().await.unwrap()["id"], "approval");
        rpc.close().await;
    }

    #[test]
    fn rpc_errors_cannot_be_mistaken_for_success() {
        assert_eq!(
            response_result(json!({"id":1,"error":{"message":"Turn already completed"}})),
            Err("Turn already completed".into())
        );
        assert!(response_result(json!({"id":1})).is_err());
        assert_eq!(
            response_result(json!({"id":1,"result":{}})).unwrap(),
            json!({})
        );
    }

    #[tokio::test]
    #[ignore = "requires an installed Codex CLI; does not start a model turn"]
    async fn installed_codex_handshake_and_models() {
        let mut rpc = CodexTransport::connect("codex").await.unwrap();
        let models = rpc.call("model/list", json!({"limit":100})).await.unwrap();
        assert!(models["data"].is_array());
        rpc.close().await;
    }
}
