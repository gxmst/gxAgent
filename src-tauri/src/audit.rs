use serde_json::json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct AuditLogger {
    log_path: PathBuf,
    buffer: Arc<Mutex<Vec<String>>>,
}

impl AuditLogger {
    pub fn new() -> Self {
        let log_dir = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("gxAgent")
            .join("audit");

        let _ = std::fs::create_dir_all(&log_dir);

        let timestamp = chrono::Local::now().format("%Y%m%d");
        let log_path = log_dir.join(format!("audit_{}.jsonl", timestamp));

        Self {
            log_path,
            buffer: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn log_command(&self, tool: &str, args: &str, approved: bool, user: &str) {
        let entry = json!({
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "tool": tool,
            "args": self.sanitize_args(args),
            "approved": approved,
            "user": user,
        });

        let mut buffer = self.buffer.lock().await;
        buffer.push(entry.to_string());

        if buffer.len() >= 10 {
            let _ = self.flush_buffer(&mut buffer).await;
        }
    }

    async fn flush_buffer(&self, buffer: &mut Vec<String>) -> std::io::Result<()> {
        if buffer.is_empty() {
            return Ok(());
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)?;

        for entry in buffer.drain(..) {
            writeln!(file, "{}", entry)?;
        }

        file.flush()?;
        Ok(())
    }

    fn sanitize_args(&self, args: &str) -> String {
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
            return "[REDACTED]".to_string();
        }
        if args.chars().count() > 500 {
            let truncated: String = args.chars().take(500).collect();
            format!("{}... [truncated]", truncated)
        } else {
            args.to_string()
        }
    }

    pub async fn shutdown(&self) {
        let mut buffer = self.buffer.lock().await;
        let _ = self.flush_buffer(&mut buffer).await;
    }
}

impl Drop for AuditLogger {
    fn drop(&mut self) {
        // Best effort flush on drop
        if let Ok(mut buffer) = self.buffer.try_lock() {
            let _ = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(self.flush_buffer(&mut buffer))
            });
        }
    }
}
