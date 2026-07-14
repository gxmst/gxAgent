use crate::text::{utf8_prefix, IncrementalUtf8Decoder};
use crate::workspace;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

const FILE_SIZE_LIMIT: usize = 1024 * 1024; // 1MB
const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 300; // 5 minutes
const PROCESS_OUTPUT_LIMIT_BYTES: usize = 256 * 1024; // shared by stdout and stderr
const PROCESS_READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const PROCESS_READER_ABORT_TIMEOUT: Duration = Duration::from_millis(250);
const PROCESS_OUTPUT_TRUNCATION_NOTICE: &str =
    "\n[Process output truncated after 256 KiB; additional stdout/stderr was discarded.]\n";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

pub const TOOL_CANCELLED_ERROR: &str = "__GX_AGENT_CANCELLED__";

#[derive(Debug, Clone)]
pub struct ExecutionChunk {
    pub stream: &'static str,
    pub content: String,
}

const BLOCKED_PATH_PREFIXES: &[&str] = &[
    r"\Windows\System32",
    r"\Windows\SysWOW64",
    r"\Windows\System32\config",
    r"\ProgramData",
    r"\Users\All Users",
    r"\.ssh",
    r"\.gnupg",
    r"\.aws",
    r"\.kube",
    r"\.config\gcloud",
    r"\AppData\Roaming\Microsoft\Credentials",
    r"\AppData\Local\Microsoft\Credentials",
];

pub fn get_all_tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "execute_command",
                "description": "Execute a shell command on the local Windows machine using PowerShell and return stdout/stderr. Use this to run scripts, install packages, manage files, or diagnose system issues. IMPORTANT: Use PowerShell syntax only — do NOT use || or &&, use ; to chain commands. Use 2>$null to suppress errors.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "The PowerShell command to execute" }
                    },
                    "required": ["command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the content of a local file. Use this to inspect configuration, source code, logs, or any text file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path to read" }
                    },
                    "required": ["path"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write content to a local file. Creates the file if it doesn't exist, overwrites if it does. Parent directories are created automatically.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path to write to" },
                        "content": { "type": "string", "description": "Complete content to write into the file" }
                    },
                    "required": ["path", "content"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List files and subdirectories in a local directory. Returns names with type indicators (file/dir).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Directory path to list. Defaults to current working directory." }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "run_python",
                "description": "Execute a Python script locally and return stdout/stderr. Useful for data analysis, calculations, or running utilities.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "code": { "type": "string", "description": "Python code to execute" }
                    },
                    "required": ["code"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web using DuckDuckGo. Returns top search results with titles, URLs, and snippets. No API key required.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query" }
                    },
                    "required": ["query"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Make a precise, in-place edit to an existing file by replacing an exact string. STRONGLY PREFER this over write_file for modifying existing files — it avoids rewriting the whole file and is safer for large files. The old_string must match EXACTLY (including whitespace and indentation) and must be UNIQUE in the file, otherwise the edit is rejected. Include enough surrounding context to make it unique. To insert new code, include an anchor line in both old_string and new_string.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path to edit" },
                        "old_string": { "type": "string", "description": "The exact text to find and replace. Must be unique in the file." },
                        "new_string": { "type": "string", "description": "The text to replace it with." },
                        "replace_all": { "type": "boolean", "description": "Replace all occurrences instead of requiring uniqueness. Defaults to false." }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search file contents for a regular expression across the workspace. Returns matching lines with file path and line number. Use this to find where symbols, functions, or text are defined/used — far faster and more reliable than shell commands. Results are capped to avoid flooding context.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Regular expression to search for (Rust regex syntax)." },
                        "path": { "type": "string", "description": "Directory or file to search in. Defaults to the workspace root." },
                        "glob": { "type": "string", "description": "Optional filename glob to filter files, e.g. '*.rs' or '*.{ts,tsx}'." },
                        "case_insensitive": { "type": "boolean", "description": "Case-insensitive match. Defaults to false." }
                    },
                    "required": ["pattern"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "glob",
                "description": "Find files by name using a glob pattern (e.g. '**/*.rs', 'src/**/*.tsx'). Returns matching file paths. Use this to discover files before reading them.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Glob pattern to match file paths against." },
                        "path": { "type": "string", "description": "Directory to search in. Defaults to the workspace root." }
                    },
                    "required": ["pattern"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "todo_write",
                "description": "Record or update a structured task list for the current multi-step task. Use this at the start of any non-trivial task to lay out the plan, and update it as you complete steps (mark items done, add newly discovered work). This keeps long tasks organized and visible to the user. Pass the full list every time — it replaces the previous one.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "todos": {
                            "type": "array",
                            "description": "The complete current task list, in order.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "content": { "type": "string", "description": "Short description of the task." },
                                    "status": { "type": "string", "enum": ["pending", "in_progress", "completed"], "description": "Current status." }
                                },
                                "required": ["content", "status"]
                            }
                        }
                    },
                    "required": ["todos"]
                }
            }
        }),
    ]
}

pub fn get_enabled_tool_definitions(enabled: &[String]) -> Vec<Value> {
    let all = get_all_tool_definitions();
    all.into_iter()
        .filter(|t| {
            t["function"]["name"]
                .as_str()
                .map(|n| enabled.contains(&n.to_string()))
                .unwrap_or(false)
        })
        .collect()
}

pub async fn execute_tool(
    name: &str,
    args_str: &str,
    work_dir: &str,
    search_provider: &str,
    search_api_key: &str,
) -> String {
    execute_tool_with_timeout(
        name,
        args_str,
        work_dir,
        search_provider,
        search_api_key,
        DEFAULT_COMMAND_TIMEOUT_SECS,
    )
    .await
}

pub async fn execute_tool_with_timeout(
    name: &str,
    args_str: &str,
    work_dir: &str,
    search_provider: &str,
    search_api_key: &str,
    timeout_secs: u64,
) -> String {
    execute_tool_with_control(
        name,
        args_str,
        work_dir,
        search_provider,
        search_api_key,
        timeout_secs,
        None,
        None,
    )
    .await
}

/// Execute a tool with cooperative cancellation and optional stdout/stderr
/// streaming. Process-backed tools additionally terminate their complete
/// process tree before returning on cancellation or timeout.
#[allow(clippy::too_many_arguments)]
pub async fn execute_tool_with_control(
    name: &str,
    args_str: &str,
    work_dir: &str,
    search_provider: &str,
    search_api_key: &str,
    timeout_secs: u64,
    cancel_rx: Option<watch::Receiver<bool>>,
    output_tx: Option<mpsc::UnboundedSender<ExecutionChunk>>,
) -> String {
    if cancel_rx
        .as_ref()
        .map(|receiver| *receiver.borrow())
        .unwrap_or(false)
    {
        return TOOL_CANCELLED_ERROR.to_string();
    }

    let args: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
    match name {
        "execute_command" => {
            let cmd = args["command"].as_str().unwrap_or("");
            match run_execute_command(cmd, work_dir, timeout_secs, cancel_rx, output_tx).await {
                Ok(out) => out,
                Err(e) if e == TOOL_CANCELLED_ERROR => e,
                Err(e) => format!("Error: {}", e),
            }
        }
        "read_file" => {
            let path = args["path"].as_str().unwrap_or("");
            match run_read_file(path, work_dir).await {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "write_file" => {
            let path = args["path"].as_str().unwrap_or("");
            let content = args["content"].as_str().unwrap_or("");
            match run_write_file(path, content, work_dir).await {
                Ok(_) => "File written successfully.".to_string(),
                Err(e) => format!("Error: {}", e),
            }
        }
        "list_dir" => {
            let path = args["path"].as_str().unwrap_or(".");
            match run_list_dir(path, work_dir).await {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "run_python" => {
            let code = args["code"].as_str().unwrap_or("");
            match run_python(code, work_dir, timeout_secs, cancel_rx, output_tx).await {
                Ok(out) => out,
                Err(e) if e == TOOL_CANCELLED_ERROR => e,
                Err(e) => format!("Error: {}", e),
            }
        }
        "web_search" => {
            let query = args["query"].as_str().unwrap_or("");
            let search_timeout = std::time::Duration::from_secs(timeout_secs.min(20));
            let search = run_web_search(query, search_provider, search_api_key);
            tokio::pin!(search);
            if let Some(mut receiver) = cancel_rx {
                tokio::select! {
                    result = tokio::time::timeout(search_timeout, &mut search) => match result {
                        Ok(Ok(out)) => out,
                        Ok(Err(e)) => format!("Error: {}", e),
                        Err(_) => format!("Error: Search timed out after {}s. DuckDuckGo may be blocked in your network - consider using Tavily API instead.", search_timeout.as_secs()),
                    },
                    _ = wait_for_cancel(&mut receiver) => TOOL_CANCELLED_ERROR.to_string(),
                }
            } else {
                match tokio::time::timeout(search_timeout, &mut search).await {
                    Ok(Ok(out)) => out,
                    Ok(Err(e)) => format!("Error: {}", e),
                    Err(_) => format!("Error: Search timed out after {}s. DuckDuckGo may be blocked in your network - consider using Tavily API instead.", search_timeout.as_secs()),
                }
            }
        }
        "edit_file" => {
            let path = args["path"].as_str().unwrap_or("");
            let old_string = args["old_string"].as_str().unwrap_or("");
            let new_string = args["new_string"].as_str().unwrap_or("");
            let replace_all = args["replace_all"].as_bool().unwrap_or(false);
            match run_edit_file(path, old_string, new_string, replace_all, work_dir).await {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "grep" => {
            let pattern = args["pattern"].as_str().unwrap_or("");
            let path = args["path"].as_str().unwrap_or(".");
            let glob = args["glob"].as_str();
            let case_insensitive = args["case_insensitive"].as_bool().unwrap_or(false);
            match run_grep(pattern, path, glob, case_insensitive, work_dir).await {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "glob" => {
            let pattern = args["pattern"].as_str().unwrap_or("");
            let path = args["path"].as_str().unwrap_or(".");
            match run_glob(pattern, path, work_dir).await {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "todo_write" => run_todo_write(&args),
        _ => format!("Unknown tool: {}", name),
    }
}

async fn wait_for_cancel(receiver: &mut watch::Receiver<bool>) {
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
struct ProcessOutputBudget {
    remaining: AtomicUsize,
    truncated: AtomicBool,
    truncation_notice_sent: AtomicBool,
}

impl ProcessOutputBudget {
    fn new(limit: usize) -> Self {
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

struct ProcessReaderTask {
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

fn clone_captured_output(output: &Arc<Mutex<String>>) -> String {
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

fn capture_process_output(
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

fn spawn_process_reader<R>(
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

async fn finish_process_reader(
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

#[cfg(windows)]
fn configure_process(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(windows))]
fn configure_process(command: &mut Command) {
    command.process_group(0);
}

#[cfg(windows)]
async fn terminate_process_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        taskkill.creation_flags(CREATE_NO_WINDOW);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), taskkill.status()).await;
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
}

#[cfg(not(windows))]
async fn terminate_process_tree(child: &mut tokio::process::Child) {
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

async fn run_execute_command(
    command: &str,
    work_dir: &str,
    timeout_secs: u64,
    cancel_rx: Option<watch::Receiver<bool>>,
    output_tx: Option<mpsc::UnboundedSender<ExecutionChunk>>,
) -> Result<String, String> {
    // Prepend UTF-8 encoding setup to avoid garbled Chinese output
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

async fn run_read_file(path: &str, work_dir: &str) -> Result<String, String> {
    let full_path = resolve_path(path, work_dir)?;

    let metadata = tokio::fs::metadata(&full_path)
        .await
        .map_err(|e| format!("Cannot access file: {}", e))?;

    if metadata.len() as usize > FILE_SIZE_LIMIT {
        // Read only the first FILE_SIZE_LIMIT bytes to avoid OOM on large files
        use tokio::io::AsyncReadExt;
        let file = tokio::fs::File::open(&full_path)
            .await
            .map_err(|e| format!("Failed to open file: {}", e))?;
        let mut reader = tokio::io::BufReader::new(file);
        let mut buffer = vec![0u8; FILE_SIZE_LIMIT];
        let bytes_read = reader
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file: {}", e))?;
        buffer.truncate(bytes_read);
        let content = String::from_utf8(buffer)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).to_string());
        Ok(format!(
            "{}\n\n[File truncated at {}KB]",
            &content,
            FILE_SIZE_LIMIT / 1024
        ))
    } else {
        tokio::fs::read_to_string(&full_path)
            .await
            .map_err(|e| format!("Failed to read file: {}", e))
    }
}

async fn run_write_file(path: &str, content: &str, work_dir: &str) -> Result<(), String> {
    let full_path = resolve_path(path, work_dir)?;
    if let Some(parent) = Path::new(&full_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    tokio::fs::write(&full_path, content)
        .await
        .map_err(|e| format!("Failed to write file: {}", e))
}

/// Precise in-place edit: replace an exact `old_string` with `new_string`.
/// Requires the match to be unique unless `replace_all` is set. This is the
/// safe alternative to rewriting a whole file with `write_file`.
async fn run_edit_file(
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    work_dir: &str,
) -> Result<String, String> {
    if old_string.is_empty() {
        return Err("old_string must not be empty. Use write_file to create a new file.".into());
    }
    if old_string == new_string {
        return Err("old_string and new_string are identical — nothing to change.".into());
    }

    let full_path = resolve_path(path, work_dir)?;
    let original = tokio::fs::read_to_string(&full_path)
        .await
        .map_err(|e| format!("Failed to read file for editing: {}", e))?;

    let occurrences = original.matches(old_string).count();
    if occurrences == 0 {
        return Err(
            "old_string not found in the file. It must match exactly, including whitespace and indentation. Read the file again to copy the exact text.".into(),
        );
    }

    let (updated, replaced) = if replace_all {
        (original.replace(old_string, new_string), occurrences)
    } else {
        if occurrences > 1 {
            return Err(format!(
                "old_string is not unique — it matches {} places. Add more surrounding context to make it unique, or set replace_all: true.",
                occurrences
            ));
        }
        (original.replacen(old_string, new_string, 1), 1)
    };

    tokio::fs::write(&full_path, &updated)
        .await
        .map_err(|e| format!("Failed to write edited file: {}", e))?;

    Ok(format!(
        "Edited {} ({} replacement{}).",
        path,
        replaced,
        if replaced == 1 { "" } else { "s" }
    ))
}

/// Directories that are never worth walking for grep/glob — noise and huge.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode",
];

const GREP_MAX_MATCHES: usize = 200;
const GLOB_MAX_RESULTS: usize = 500;

fn should_skip_dir(entry: &walkdir::DirEntry) -> bool {
    entry.file_type().is_dir()
        && entry
            .file_name()
            .to_str()
            .map(|n| SKIP_DIRS.contains(&n))
            .unwrap_or(false)
}

/// Translate a simple glob pattern into a regex. Supports `**` (any depth),
/// `*` (any run within a segment), `?` (single char), and `{a,b}` alternation.
fn glob_to_regex(glob: &str) -> Result<regex::Regex, String> {
    let mut re = String::from("(?i)^");
    let mut chars = glob.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` or `**` — match across directory separators
                    if chars.peek() == Some(&'/') {
                        chars.next();
                    }
                    re.push_str(".*");
                } else {
                    re.push_str("[^/\\\\]*");
                }
            }
            '?' => re.push_str("[^/\\\\]"),
            '{' => re.push('('),
            '}' => re.push(')'),
            ',' => re.push('|'),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '[' | ']' => {
                re.push('\\');
                re.push(c);
            }
            '/' => re.push_str("[/\\\\]"),
            _ => re.push(c),
        }
    }
    re.push('$');
    regex::Regex::new(&re).map_err(|e| format!("Invalid glob pattern: {}", e))
}

async fn run_grep(
    pattern: &str,
    path: &str,
    glob: Option<&str>,
    case_insensitive: bool,
    work_dir: &str,
) -> Result<String, String> {
    if pattern.is_empty() {
        return Err("pattern must not be empty.".into());
    }
    let root = resolve_path(path, work_dir)?;

    let re = regex::RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|e| format!("Invalid regex pattern: {}", e))?;

    let name_re = match glob {
        Some(g) if !g.is_empty() => Some(glob_to_regex(g)?),
        _ => None,
    };

    // Blocking filesystem walk on the blocking pool.
    let root_path = PathBuf::from(&root);
    let root_is_file = root_path.is_file();
    let root_clone = root_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut out = String::new();
        let mut match_count = 0usize;
        let mut files_with_matches = 0usize;
        'walk: for entry in walkdir::WalkDir::new(&root_clone)
            .into_iter()
            .filter_entry(|e| !should_skip_dir(e))
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let entry_path = entry.path();
            let rel = if root_is_file {
                entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| entry_path.to_string_lossy().to_string())
            } else {
                entry_path
                    .strip_prefix(&root_clone)
                    .unwrap_or(entry_path)
                    .to_string_lossy()
                    .replace('\\', "/")
            };
            if let Some(nre) = &name_re {
                let fname = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                if !nre.is_match(fname) && !nre.is_match(&rel) {
                    continue;
                }
            }
            // Skip files that are too large or binary.
            if let Ok(meta) = entry_path.metadata() {
                if meta.len() as usize > FILE_SIZE_LIMIT {
                    continue;
                }
            }
            let content = match std::fs::read_to_string(entry_path) {
                Ok(c) => c,
                Err(_) => continue, // binary / unreadable
            };
            let mut file_hit = false;
            for (lineno, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    file_hit = true;
                    // Truncate on a char boundary — byte slicing at 300 could
                    // land mid-codepoint on UTF-8 (Chinese/emoji) and panic.
                    let trimmed: String = line.chars().take(300).collect();
                    out.push_str(&format!("{}:{}:{}\n", rel, lineno + 1, trimmed.trim_end()));
                    match_count += 1;
                    if match_count >= GREP_MAX_MATCHES {
                        out.push_str(&format!(
                            "\n[Truncated at {} matches. Narrow the pattern or path.]",
                            GREP_MAX_MATCHES
                        ));
                        break 'walk;
                    }
                }
            }
            if file_hit {
                files_with_matches += 1;
            }
        }
        (out, match_count, files_with_matches)
    })
    .await
    .map_err(|e| format!("grep task failed: {}", e))?;

    let (out, match_count, files_with_matches) = result;
    if match_count == 0 {
        Ok(format!("No matches for /{}/.", pattern))
    } else {
        Ok(format!(
            "{} match(es) in {} file(s):\n{}",
            match_count, files_with_matches, out
        ))
    }
}

async fn run_glob(pattern: &str, path: &str, work_dir: &str) -> Result<String, String> {
    if pattern.is_empty() {
        return Err("pattern must not be empty.".into());
    }
    let root = resolve_path(path, work_dir)?;
    let re = glob_to_regex(pattern)?;

    let root_clone = root.clone();
    let matches = tokio::task::spawn_blocking(move || {
        let mut found: Vec<String> = Vec::new();
        for entry in walkdir::WalkDir::new(&root_clone)
            .into_iter()
            .filter_entry(|e| !should_skip_dir(e))
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let entry_path = entry.path();
            let rel = entry_path
                .strip_prefix(&root_clone)
                .unwrap_or(entry_path)
                .to_string_lossy()
                .replace('\\', "/");
            if re.is_match(&rel) {
                found.push(rel);
                if found.len() >= GLOB_MAX_RESULTS {
                    break;
                }
            }
        }
        found
    })
    .await
    .map_err(|e| format!("glob task failed: {}", e))?;

    if matches.is_empty() {
        Ok(format!("No files match '{}'.", pattern))
    } else {
        Ok(format!(
            "{} file(s):\n{}",
            matches.len(),
            matches.join("\n")
        ))
    }
}

/// Render an agent-managed todo list into a compact checklist. The model owns
/// the list; this tool just echoes a normalized view back as the tool result so
/// the plan stays visible in the transcript and steers the next steps.
fn run_todo_write(args: &Value) -> String {
    let todos = match args["todos"].as_array() {
        Some(t) if !t.is_empty() => t,
        _ => {
            return "Error: todos must be a non-empty array of { content, status } items."
                .to_string()
        }
    };

    let mut out = String::from("Todo list updated:\n");
    let mut pending = 0usize;
    let mut in_progress = 0usize;
    let mut completed = 0usize;
    for item in todos {
        let content = item["content"].as_str().unwrap_or("").trim();
        if content.is_empty() {
            continue;
        }
        let status = item["status"].as_str().unwrap_or("pending");
        let (marker, label) = match status {
            "completed" => {
                completed += 1;
                ("[x]", "")
            }
            "in_progress" => {
                in_progress += 1;
                ("[~]", " (in progress)")
            }
            _ => {
                pending += 1;
                ("[ ]", "")
            }
        };
        out.push_str(&format!("{} {}{}\n", marker, content, label));
    }
    out.push_str(&format!(
        "\n{} done · {} in progress · {} pending.",
        completed, in_progress, pending
    ));
    out
}

async fn run_list_dir(path: &str, work_dir: &str) -> Result<String, String> {
    let full_path = resolve_path(path, work_dir)?;

    let path_obj = Path::new(&full_path);
    if !path_obj.exists() {
        return Err(format!("Directory not found: {}", full_path));
    }

    let mut entries = tokio::fs::read_dir(&full_path)
        .await
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            result.push(format!("{}/", name));
        } else {
            result.push(name);
        }
    }

    if result.is_empty() {
        Ok("(empty directory)".to_string())
    } else {
        Ok(result.join("\n"))
    }
}

async fn run_python(
    code: &str,
    work_dir: &str,
    timeout_secs: u64,
    cancel_rx: Option<watch::Receiver<bool>>,
    output_tx: Option<mpsc::UnboundedSender<ExecutionChunk>>,
) -> Result<String, String> {
    let workspace = workspace::ensure_workspace_dir(work_dir, false)?;
    // Check Python availability
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

    // Write code to temp file using tempfile crate pattern
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

    // Always cleanup temp file
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

async fn run_web_search(query: &str, provider: &str, api_key: &str) -> Result<String, String> {
    match provider {
        "tavily" => {
            if api_key.is_empty() {
                return Err(
                    "Tavily API Key is missing. Please configure it in settings.".to_string(),
                );
            }
            run_tavily_search(query, api_key).await
        }
        "searxng" => run_searxng_search(query).await,
        _ => {
            // DDG → Tavily fallback → error
            let ddg_timeout = std::time::Duration::from_secs(8);
            match tokio::time::timeout(ddg_timeout, run_duckduckgo_search(query)).await {
                Ok(Ok(results)) => Ok(results),
                Ok(Err(e)) => {
                    eprintln!("[search] DuckDuckGo failed: {}, trying fallback", e);
                    if !api_key.is_empty() {
                        eprintln!("[search] Falling back to Tavily");
                        run_tavily_search(query, api_key).await
                    } else {
                        Err(format!("DuckDuckGo search failed: {}. Consider configuring a Tavily API key in settings for more reliable search.", e))
                    }
                }
                Err(_) => {
                    eprintln!("[search] DuckDuckGo timed out after 8s, trying fallback");
                    if !api_key.is_empty() {
                        eprintln!("[search] Falling back to Tavily");
                        run_tavily_search(query, api_key).await
                    } else {
                        Err("DuckDuckGo search timed out. Consider configuring a Tavily API key in settings for more reliable search.".to_string())
                    }
                }
            }
        }
    }
}

fn is_safe_url(url: &str) -> bool {
    use std::net::IpAddr;

    let parsed = match url.parse::<reqwest::Url>() {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };

    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }

    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']).to_lowercase();

    if host == "localhost"
        || host.ends_with(".localhost")
        || host.chars().all(|c| c.is_ascii_digit())
    {
        return false;
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ip) => {
                if ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
                {
                    return false;
                }
            }
            IpAddr::V6(ip) => {
                if ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
                    || ip.to_ipv4_mapped().is_some_and(|mapped| {
                        mapped.is_private()
                            || mapped.is_loopback()
                            || mapped.is_link_local()
                            || mapped.is_unspecified()
                    })
                {
                    return false;
                }
            }
        }
    }

    true
}

async fn run_tavily_search(query: &str, api_key: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let response = client
        .post("https://api.tavily.com/search")
        .json(&json!({
            "api_key": api_key,
            "query": query,
            "search_depth": "basic",
            "include_answer": true
        }))
        .send()
        .await
        .map_err(|e| format!("Tavily request failed: {}", e))?;

    let val: Value = response
        .json()
        .await
        .map_err(|e| format!("Tavily response parse error: {}", e))?;

    // Reset failure counter on successful Tavily response
    CONSECUTIVE_FAILURES.store(0, Ordering::Relaxed);

    if let Some(answer) = val["answer"].as_str() {
        if !answer.is_empty() {
            return Ok(answer.to_string());
        }
    }

    // Fallback to results array
    if let Some(results) = val["results"].as_array() {
        let items: Vec<String> = results
            .iter()
            .take(5)
            .filter_map(|r| {
                let title = r["title"].as_str().unwrap_or("");
                let url = r["url"].as_str().unwrap_or("");
                let content = r["content"].as_str().unwrap_or("");
                // SECURITY: Filter out internal URLs
                if !is_safe_url(url) {
                    return None;
                }
                if title.is_empty() && content.is_empty() {
                    None
                } else {
                    Some(format!(
                        "Title: {}\nLink: {}\nSnippet: {}",
                        title, url, content
                    ))
                }
            })
            .collect();
        if items.is_empty() {
            return Ok("No results found.".to_string());
        }
        return Ok(items.join("\n---\n"));
    }

    Ok("No results found.".to_string())
}

async fn run_searxng_search(query: &str) -> Result<String, String> {
    let instances = [
        "https://searx.be",
        "https://search.sapti.me",
        "https://searxng.ch",
    ];

    let client = reqwest::Client::builder()
        .user_agent(GXAGENT_UA)
        .timeout(std::time::Duration::from_secs(5))
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let encoded = urlencoding::encode(query);

    for instance in &instances {
        let url = format!(
            "{}/search?q={}&format=json&categories=general",
            instance, encoded
        );
        match client.get(&url).send().await {
            Ok(response) => {
                if !response.status().is_success() {
                    continue;
                }
                match response.json::<Value>().await {
                    Ok(val) => {
                        if let Some(results) = val["results"].as_array() {
                            let items: Vec<String> = results
                                .iter()
                                .take(5)
                                .filter_map(|r| {
                                    let title = r["title"].as_str().unwrap_or("");
                                    let url = r["url"].as_str().unwrap_or("");
                                    let snippet = r["content"].as_str().unwrap_or("");
                                    // SECURITY: Filter out internal URLs
                                    if !is_safe_url(url) {
                                        return None;
                                    }
                                    if title.is_empty() && snippet.is_empty() {
                                        None
                                    } else {
                                        Some(format!(
                                            "Title: {}\nLink: {}\nSnippet: {}",
                                            title, url, snippet
                                        ))
                                    }
                                })
                                .collect();
                            if !items.is_empty() {
                                return Ok(items.join("\n---\n"));
                            }
                        }
                    }
                    Err(_) => continue,
                }
            }
            Err(_) => continue,
        }
    }

    Err("All search services unavailable. Please try Tavily API or check your network.".to_string())
}

static LAST_SEARCH_TIME: AtomicU64 = AtomicU64::new(0);
static CONSECUTIVE_FAILURES: AtomicU64 = AtomicU64::new(0);
const MIN_SEARCH_INTERVAL_SECS: u64 = 2;
const MAX_CONSECUTIVE_FAILURES: u64 = 5;
const GXAGENT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 gxAgent/1.4 (Contact: support@gxagent.dev; open-source-client)";

fn check_search_rate_limit() -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let failures = CONSECUTIVE_FAILURES.load(Ordering::Relaxed);
    if failures >= MAX_CONSECUTIVE_FAILURES {
        return Err("Search service is temporarily unavailable due to rate limiting. Please try again later or use Tavily API for a more reliable experience.".to_string());
    }

    let last = LAST_SEARCH_TIME.load(Ordering::Relaxed);
    if now.saturating_sub(last) < MIN_SEARCH_INTERVAL_SECS {
        return Err("Search rate limit: please wait a moment before searching again.".to_string());
    }

    LAST_SEARCH_TIME.store(now, Ordering::Relaxed);
    Ok(())
}

async fn run_duckduckgo_search(query: &str) -> Result<String, String> {
    check_search_rate_limit()?;

    let client = reqwest::Client::builder()
        .user_agent(GXAGENT_UA)
        .timeout(std::time::Duration::from_secs(7))
        .connect_timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let encoded = urlencoding::encode(query);
    let url = format!("https://html.duckduckgo.com/html/?q={}", encoded);

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Search request failed: {}", e))?;

    let status = response.status();
    if status.as_u16() == 403 || status.as_u16() == 503 {
        let failures = CONSECUTIVE_FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
        if failures >= MAX_CONSECUTIVE_FAILURES {
            return Err("Search service is temporarily busy. Please proceed with current context or try again later. Consider using Tavily API for reliable search.".to_string());
        }
        return Err(format!(
            "Search service returned {} (attempt {}/{}). Please try again or use Tavily API.",
            status, failures, MAX_CONSECUTIVE_FAILURES
        ));
    }

    if !status.is_success() {
        return Err(format!("Search request failed with status: {}", status));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    CONSECUTIVE_FAILURES.store(0, Ordering::Relaxed);

    parse_duckduckgo_results(&html)
}

fn parse_duckduckgo_results(html: &str) -> Result<String, String> {
    use scraper::{Html, Selector};

    let document = Html::parse_document(html);

    let result_selector =
        Selector::parse(".result").unwrap_or_else(|_| Selector::parse("div").unwrap());
    let title_selector =
        Selector::parse(".result__a").unwrap_or_else(|_| Selector::parse("a").unwrap());
    let snippet_selector =
        Selector::parse(".result__snippet").unwrap_or_else(|_| Selector::parse("span").unwrap());

    let mut results = Vec::new();

    for result_el in document.select(&result_selector) {
        if results.len() >= 5 {
            break;
        }

        let title = result_el
            .select(&title_selector)
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default()
            .trim()
            .to_string();

        let raw_link = result_el
            .select(&title_selector)
            .next()
            .and_then(|el| el.value().attr("href"))
            .unwrap_or("")
            .to_string();

        let link = if raw_link.contains("uddg=") {
            raw_link
                .split("uddg=")
                .nth(1)
                .and_then(|s| s.split('&').next())
                .and_then(|s| urlencoding::decode(s).ok())
                .map(|s| s.to_string())
                .unwrap_or(raw_link.clone())
        } else if raw_link.contains("duckduckgo.com/y.js")
            || raw_link.contains("duckduckgo.com/d.js")
            || raw_link.contains("duckduckgo.com/l/")
        {
            String::new()
        } else if raw_link.starts_with("/")
            || (raw_link.contains("duckduckgo.com") && !raw_link.starts_with("http"))
        {
            String::new()
        } else {
            raw_link.clone()
        };

        let snippet = result_el
            .select(&snippet_selector)
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default()
            .trim()
            .to_string();

        // SECURITY: Filter out internal URLs
        if !link.is_empty() && !is_safe_url(&link) {
            continue;
        }

        if !title.is_empty() && !link.is_empty() {
            results.push(format!(
                "Title: {}\nLink: {}\nSnippet: {}",
                title, link, snippet
            ));
        } else if !title.is_empty() || !snippet.is_empty() {
            results.push(format!("Title: {}\nSnippet: {}", title, snippet));
        }
    }

    if results.is_empty() {
        Ok("No results found.".to_string())
    } else {
        Ok(results.join("\n---\n"))
    }
}

/// Resolve a path against the working directory.
/// When `work_dir` is set, ALL paths (absolute or relative) must resolve within
/// the work_dir boundary. This prevents both traversal attacks and absolute-path
/// sandbox escapes (e.g. reading `C:\Users\...\.ssh\id_rsa`).
fn resolve_path(path: &str, work_dir: &str) -> Result<String, String> {
    let resolved = workspace::resolve_within_workspace(path, work_dir)?;
    let resolved = resolved.to_string_lossy().to_string();
    check_blocked_path(&resolved)?;
    Ok(resolved)
}

fn check_blocked_path(resolved: &str) -> Result<(), String> {
    let lower = resolved.to_lowercase();
    for prefix in BLOCKED_PATH_PREFIXES {
        if lower.contains(&prefix.to_lowercase()) {
            return Err(format!(
                "Access denied: path '{}' is in a protected system directory",
                resolved
            ));
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::{
        capture_process_output, clone_captured_output, finish_process_reader, glob_to_regex,
        is_safe_url, spawn_process_reader, ProcessOutputBudget, PROCESS_OUTPUT_TRUNCATION_NOTICE,
    };
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn safe_url_allows_public_http_urls() {
        assert!(is_safe_url("https://example.com/search?q=gxagent"));
        assert!(is_safe_url("http://example.org/path"));
    }

    #[test]
    fn safe_url_rejects_non_http_and_invalid_urls() {
        assert!(!is_safe_url("javascript:alert(1)"));
        assert!(!is_safe_url(
            "file:///C:/Windows/System32/drivers/etc/hosts"
        ));
        assert!(!is_safe_url("not a url"));
    }

    #[test]
    fn safe_url_rejects_local_and_private_hosts() {
        assert!(!is_safe_url("http://localhost:3000"));
        assert!(!is_safe_url("http://127.0.0.1"));
        assert!(!is_safe_url("http://0.0.0.0"));
        assert!(!is_safe_url("http://10.0.0.1"));
        assert!(!is_safe_url("http://172.31.0.1"));
        assert!(!is_safe_url("http://192.168.1.1"));
        assert!(!is_safe_url("http://169.254.1.1"));
        assert!(!is_safe_url("http://[::1]"));
        assert!(!is_safe_url("http://[fd00::1]"));
    }

    #[test]
    fn glob_regex_matches_relative_paths() {
        let re = glob_to_regex("src/**/*.tsx").expect("valid glob");
        assert!(re.is_match("src/App.tsx"));
        assert!(re.is_match("src/components/Chat/Message.tsx"));
        assert!(!re.is_match("tests/App.tsx"));
    }

    #[test]
    fn filename_glob_still_matches_basenames() {
        let re = glob_to_regex("*.rs").expect("valid glob");
        assert!(re.is_match("tools.rs"));
        assert!(!re.is_match("src/tools.rs"));
    }

    #[test]
    fn process_output_budget_caps_capture_and_streaming_once() {
        let budget = Arc::new(ProcessOutputBudget::new(10));
        let stdout = Arc::new(Mutex::new(String::new()));
        let stderr = Arc::new(Mutex::new(String::new()));
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let output_tx = Some(sender);

        capture_process_output("stdout", "abcdef", &output_tx, &stdout, &budget);
        capture_process_output("stderr", "ghijklmnop", &output_tx, &stderr, &budget);
        capture_process_output("stdout", "ignored", &output_tx, &stdout, &budget);
        drop(output_tx);

        let stdout = clone_captured_output(&stdout);
        let stderr = clone_captured_output(&stderr);
        assert_eq!(stdout, "abcdef");
        assert_eq!(stderr, format!("ghij{}", PROCESS_OUTPUT_TRUNCATION_NOTICE));

        let mut streamed = String::new();
        while let Ok(chunk) = receiver.try_recv() {
            streamed.push_str(&chunk.content);
        }
        assert_eq!(
            streamed,
            format!("abcdefghij{}", PROCESS_OUTPUT_TRUNCATION_NOTICE)
        );
        assert_eq!(
            streamed.matches(PROCESS_OUTPUT_TRUNCATION_NOTICE).count(),
            1
        );
    }

    #[test]
    fn process_output_cap_preserves_utf8_boundaries() {
        let budget = Arc::new(ProcessOutputBudget::new(5));
        let output = Arc::new(Mutex::new(String::new()));

        capture_process_output("stdout", "中文", &None, &output, &budget);

        assert_eq!(
            clone_captured_output(&output),
            format!("中{}", PROCESS_OUTPUT_TRUNCATION_NOTICE)
        );
    }

    #[tokio::test]
    async fn reader_shutdown_aborts_an_inherited_open_pipe() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let budget = Arc::new(ProcessOutputBudget::new(1024));
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let task = spawn_process_reader(reader, "stdout", Some(sender), budget);

        writer.write_all(b"hello").await.expect("write test output");
        let first_chunk = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("reader should emit promptly")
            .expect("stream should remain open");
        assert_eq!(first_chunk.content, "hello");

        let output = tokio::time::timeout(
            Duration::from_secs(1),
            finish_process_reader(task, Duration::from_millis(20), true),
        )
        .await
        .expect("reader shutdown must be bounded")
        .expect("reader output should remain available");

        assert!(output.starts_with("hello"));
        assert!(output.contains("descendant process may still have it open"));
        drop(writer);
    }
}
