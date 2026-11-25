use super::{ExecutionChunk, TOOL_CANCELLED_ERROR};
use crate::text::{utf8_prefix, IncrementalUtf8Decoder};
use crate::workspace;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

const PROCESS_OUTPUT_LIMIT_BYTES: usize = 256 * 1024; // shared by stdout and stderr
const PROCESS_READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const PROCESS_READER_ABORT_TIMEOUT: Duration = Duration::from_millis(250);
pub(super) const PROCESS_OUTPUT_TRUNCATION_NOTICE: &str =
    "\n[Process output truncated after 256 KiB; additional stdout/stderr was discarded.]\n";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

pub(super) async fn wait_for_cancel(receiver: &mut watch::Receiver<bool>) {
    if *receiver.borrow() {
        return;
    }
    while receiver.changed().await.is_ok() {
        if *receiver.borrow() {
            return;
        }
    }
}

struct CapturedProcessOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

#[derive(Debug)]
pub(super) struct ProcessOutputBudget {
    remaining: AtomicUsize,
    truncated: AtomicBool,
    truncation_notice_sent: AtomicBool,
}

impl ProcessOutputBudget {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            remaining: AtomicUsize::new(limit),
            truncated: AtomicBool::new(false),
            truncation_notice_sent: AtomicBool::new(false),
        }
    }

    fn reserve(&self, requested: usize) -> usize {
        let mut remaining = self.remaining.load(Ordering::Acquire);
        loop {
            let reserved = remaining.min(requested);
            match self.remaining.compare_exchange_weak(
                remaining,
                remaining - reserved,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return reserved,
                Err(actual) => remaining = actual,
            }
        }
    }

    fn restore_unused(&self, unused: usize) {
        if unused > 0 {
            self.remaining.fetch_add(unused, Ordering::Release);
        }
    }
}

pub(super) struct ProcessReaderTask {
    stream: &'static str,
    output: Arc<Mutex<String>>,
    output_tx: Option<mpsc::UnboundedSender<ExecutionChunk>>,
    handle: JoinHandle<Result<(), String>>,
}

fn push_captured_output(output: &Arc<Mutex<String>>, content: &str) {
    output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push_str(content);
}

pub(super) fn clone_captured_output(output: &Arc<Mutex<String>>) -> String {
    output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn emit_process_output(
    stream: &'static str,
    content: &str,
    output_tx: &Option<mpsc::UnboundedSender<ExecutionChunk>>,
    output: &Arc<Mutex<String>>,
) {
    if content.is_empty() {
        return;
    }
    if let Some(sender) = output_tx {
        let _ = sender.send(ExecutionChunk {
            stream,
            content: content.to_string(),
        });
    }
    push_captured_output(output, content);
}

pub(super) fn capture_process_output(
    stream: &'static str,
    decoded: &str,
    output_tx: &Option<mpsc::UnboundedSender<ExecutionChunk>>,
    output: &Arc<Mutex<String>>,
    budget: &Arc<ProcessOutputBudget>,
) {
    if decoded.is_empty() || budget.truncated.load(Ordering::Acquire) {
        return;
    }

    let reserved = budget.reserve(decoded.len());
    let accepted = utf8_prefix(decoded, reserved);
    budget.restore_unused(reserved.saturating_sub(accepted.len()));
    emit_process_output(stream, accepted, output_tx, output);

    if accepted.len() < decoded.len() {
        budget.truncated.store(true, Ordering::Release);
        if !budget.truncation_notice_sent.swap(true, Ordering::AcqRel) {
            emit_process_output(stream, PROCESS_OUTPUT_TRUNCATION_NOTICE, output_tx, output);
        }
    }
}

async fn read_process_stream<R>(
    mut reader: R,
    stream: &'static str,
    output_tx: Option<mpsc::UnboundedSender<ExecutionChunk>>,
    output: Arc<Mutex<String>>,
    budget: Arc<ProcessOutputBudget>,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = [0_u8; 8192];
    let mut decoder = IncrementalUtf8Decoder::default();

    loop {
        let read = reader
            .read(&mut bytes)
            .await
            .map_err(|e| format!("Failed to read process {}: {}", stream, e))?;
        if read == 0 {
            break;
        }
        let decoded = decoder.push(&bytes[..read]);
        capture_process_output(stream, &decoded, &output_tx, &output, &budget);
    }

    let tail = decoder.finish();
    capture_process_output(stream, &tail, &output_tx, &output, &budget);
    Ok(())
}

pub(super) fn spawn_process_reader<R>(
    reader: R,
    stream: &'static str,
    output_tx: Option<mpsc::UnboundedSender<ExecutionChunk>>,
    budget: Arc<ProcessOutputBudget>,
) -> ProcessReaderTask
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let output = Arc::new(Mutex::new(String::new()));
    let handle = tokio::spawn(read_process_stream(
        reader,
        stream,
        output_tx.clone(),
        output.clone(),
        budget,
    ));
    ProcessReaderTask {
        stream,
        output,
        output_tx,
        handle,
    }
}

pub(super) async fn finish_process_reader(
    mut task: ProcessReaderTask,
    shutdown_timeout: Duration,
    report_inherited_pipe: bool,
) -> Result<String, String> {
    match tokio::time::timeout(shutdown_timeout, &mut task.handle).await {
        Ok(joined) => {
            joined.map_err(|error| format!("{} reader task failed: {}", task.stream, error))??
        }
        Err(_) => {
            task.handle.abort();
            let _ = tokio::time::timeout(PROCESS_READER_ABORT_TIMEOUT, &mut task.handle).await;
            if report_inherited_pipe {
                let notice = format!(
                    "\n[Stopped waiting for the {} pipe after the process exited; a descendant process may still have it open.]\n",
                    task.stream
                );
                emit_process_output(task.stream, &notice, &task.output_tx, &task.output);
            }
        }
    }
    Ok(clone_captured_output(&task.output))
}

pub(super) fn should_scrub_env_var(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "OPENAI_API_KEY"
            | "ANTHROPIC_API_KEY"
            | "GEMINI_API_KEY"
            | "GOOGLE_API_KEY"
            | "DEEPSEEK_API_KEY"
            | "TAVILY_API_KEY"
            | "OPENROUTER_API_KEY"
    ) {
        return true;
    }
    upper.starts_with("GXAGENT_")
        && ["KEY", "SECRET", "TOKEN", "PASSWORD"]
            .iter()
            .any(|needle| upper.contains(needle))
}

fn scrub_sensitive_env(command: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if let Some(name) = key.to_str() {
            if should_scrub_env_var(name) {
                command.env_remove(name);
            }
        }
    }
}

#[cfg(windows)]
fn configure_process(command: &mut Command) {
    scrub_sensitive_env(command);
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(windows))]
fn configure_process(command: &mut Command) {
    scrub_sensitive_env(command);
    command.process_group(0);
}

#[cfg(windows)]
pub(crate) async fn terminate_process_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        taskkill.creation_flags(CREATE_NO_WINDOW);
        taskkill.stdout(Stdio::null()).stderr(Stdio::null());
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), taskkill.status()).await;
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
}

#[cfg(not(windows))]
pub(crate) async fn terminate_process_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        let process_group = format!("-{}", pid);
        let _ = Command::new("kill")
            .args(["-TERM", &process_group])
            .status()
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let _ = Command::new("kill")
            .args(["-KILL", &process_group])
            .status()
            .await;
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
}

async fn run_captured_process(
    command: &mut Command,
    timeout_secs: u64,
    cancel_rx: Option<watch::Receiver<bool>>,
    output_tx: Option<mpsc::UnboundedSender<ExecutionChunk>>,
) -> Result<CapturedProcessOutput, String> {
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_process(command);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start process: {}", e))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture process stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture process stderr".to_string())?;
    let output_budget = Arc::new(ProcessOutputBudget::new(PROCESS_OUTPUT_LIMIT_BYTES));
    let stdout_task =
        spawn_process_reader(stdout, "stdout", output_tx.clone(), output_budget.clone());
    let stderr_task = spawn_process_reader(stderr, "stderr", output_tx, output_budget);

    enum Completion {
        Exited(std::io::Result<ExitStatus>),
        TimedOut,
        Cancelled,
    }

    let completion = {
        let wait = child.wait();
        tokio::pin!(wait);
        let timeout = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs.max(1)));
        tokio::pin!(timeout);
        if let Some(mut receiver) = cancel_rx {
            tokio::select! {
                status = &mut wait => Completion::Exited(status),
                _ = &mut timeout => Completion::TimedOut,
                _ = wait_for_cancel(&mut receiver) => Completion::Cancelled,
            }
        } else {
            tokio::select! {
                status = &mut wait => Completion::Exited(status),
                _ = &mut timeout => Completion::TimedOut,
            }
        }
    };

    let status = match completion {
        Completion::Exited(status) => {
            status.map_err(|e| format!("Failed to wait for process: {}", e))?
        }
        Completion::TimedOut => {
            terminate_process_tree(&mut child).await;
            let _ = tokio::join!(
                finish_process_reader(stdout_task, PROCESS_READER_SHUTDOWN_TIMEOUT, false),
                finish_process_reader(stderr_task, PROCESS_READER_SHUTDOWN_TIMEOUT, false),
            );
            return Err(format!("Process timed out after {}s", timeout_secs.max(1)));
        }
        Completion::Cancelled => {
            terminate_process_tree(&mut child).await;
            let _ = tokio::join!(
                finish_process_reader(stdout_task, PROCESS_READER_SHUTDOWN_TIMEOUT, false),
                finish_process_reader(stderr_task, PROCESS_READER_SHUTDOWN_TIMEOUT, false),
            );
            return Err(TOOL_CANCELLED_ERROR.to_string());
        }
    };

    let (stdout, stderr) = tokio::join!(
        finish_process_reader(stdout_task, PROCESS_READER_SHUTDOWN_TIMEOUT, true),
        finish_process_reader(stderr_task, PROCESS_READER_SHUTDOWN_TIMEOUT, true),
    );
    Ok(CapturedProcessOutput {
        status,
        stdout: stdout?,
        stderr: stderr?,
    })
}

pub(super) async fn run_execute_command(
    command: &str,
    work_dir: &str,
    timeout_secs: u64,
    cancel_rx: Option<watch::Receiver<bool>>,
    output_tx: Option<mpsc::UnboundedSender<ExecutionChunk>>,
) -> Result<String, String> {
    let full_command = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
        command
    );

    let workspace = workspace::ensure_workspace_dir(work_dir, false)?;
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &full_command]);
    cmd.current_dir(workspace);

    let result = run_captured_process(&mut cmd, timeout_secs, cancel_rx, output_tx).await?;
    let stdout = result.stdout;
    let stderr = result.stderr;

    let exit_code = result
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "terminated".to_string());
    let stdout = stdout.trim_end().to_string();
    let stderr = stderr.trim_end().to_string();

    if !result.status.success() {
        let mut details = format!("Command exited with code {}", exit_code);
        if !stdout.is_empty() {
            details.push_str(&format!("\nStdout:\n{}", stdout));
        }
        if !stderr.is_empty() {
            details.push_str(&format!("\nStderr:\n{}", stderr));
        }
        if stdout.is_empty() && stderr.is_empty() {
            details.push_str("\n(no stdout/stderr)");
        }
        return Err(details);
    }

    if stdout.is_empty() && stderr.is_empty() {
        Ok("Command completed successfully (exit code 0) with no stdout/stderr. If you expected data, the command may have launched a GUI app, written output to a file, or require a different CLI flag for console output.".to_string())
    } else if stderr.is_empty() {
        Ok(format!("Exit code: 0\nStdout:\n{}", stdout))
    } else if stdout.is_empty() {
        Ok(format!("Exit code: 0\nStderr:\n{}", stderr))
    } else {
        Ok(format!(
            "Exit code: 0\nStdout:\n{}\nStderr:\n{}",
            stdout, stderr
        ))
    }
}

pub(super) async fn run_python(
    code: &str,
    work_dir: &str,
    timeout_secs: u64,
    cancel_rx: Option<watch::Receiver<bool>>,
    output_tx: Option<mpsc::UnboundedSender<ExecutionChunk>>,
) -> Result<String, String> {
    let workspace = workspace::ensure_workspace_dir(work_dir, false)?;
    let mut python_check_command = Command::new("python");
    python_check_command.args(["--version"]);
    #[cfg(windows)]
    python_check_command.creation_flags(CREATE_NO_WINDOW);
    let python_check = python_check_command.output().await;

    if python_check.is_err() {
        return Err(
            "Python is not installed or not in PATH. Please install Python to use this feature."
                .to_string(),
        );
    }

    let temp_dir = std::env::temp_dir();
    let file_name = format!("gxagent_{}.py", uuid::Uuid::new_v4());
    let file_path = temp_dir.join(&file_name);
    tokio::fs::write(&file_path, code)
        .await
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    let mut cmd = Command::new("python");
    cmd.arg(&file_path);
    cmd.current_dir(workspace);

    let execution_result = run_captured_process(&mut cmd, timeout_secs, cancel_rx, output_tx).await;

    let cleanup_result = tokio::fs::remove_file(&file_path).await;
    if cleanup_result.is_err() {
        eprintln!(
            "[warning] Failed to cleanup temp Python file: {:?}",
            file_path
        );
    }

    let result = execution_result?;
    let stdout = result.stdout;
    let stderr = result.stderr;

    if result.status.success() {
        match (stdout.is_empty(), stderr.is_empty()) {
            (true, true) => Ok("(no output)".to_string()),
            (false, true) => Ok(stdout),
            (true, false) => Ok(format!("Stderr:\n{}", stderr)),
            (false, false) => Ok(format!("Stdout:\n{}\nStderr:\n{}", stdout, stderr)),
        }
    } else {
        Ok(format!(
            "Exit code: {}\nStdout:\n{}\nStderr:\n{}",
            result.status.code().unwrap_or(-1),
            stdout,
            stderr
        ))
    }
}

/// Check if Python is available on the system
pub async fn check_python_available() -> bool {
    let mut command = Command::new("python");
    command.args(["--version"]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}
