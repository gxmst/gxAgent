use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::process::Command;

const FILE_SIZE_LIMIT: usize = 1024 * 1024; // 1MB
const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 300; // 5 minutes
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    let args: Value = serde_json::from_str(args_str).unwrap_or(Value::Null);
    match name {
        "execute_command" => {
            let cmd = args["command"].as_str().unwrap_or("");
            match run_execute_command(cmd, work_dir, timeout_secs).await {
                Ok(out) => out,
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
            match run_python(code, work_dir, timeout_secs).await {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "web_search" => {
            let query = args["query"].as_str().unwrap_or("");
            let search_timeout = std::time::Duration::from_secs(timeout_secs.min(20));
            match tokio::time::timeout(search_timeout, run_web_search(query, search_provider, search_api_key)).await {
                Ok(Ok(out)) => out,
                Ok(Err(e)) => format!("Error: {}", e),
                Err(_) => format!("Error: Search timed out after {}s. DuckDuckGo may be blocked in your network — consider using Tavily API instead.", search_timeout.as_secs()),
            }
        }
        _ => format!("Unknown tool: {}", name),
    }
}

async fn run_execute_command(
    command: &str,
    work_dir: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    // Prepend UTF-8 encoding setup to avoid garbled Chinese output
    let full_command = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
        command
    );

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &full_command]);

    // Only set current_dir if work_dir is valid and exists
    if !work_dir.is_empty() {
        let path = Path::new(work_dir);
        if path.exists() {
            cmd.current_dir(work_dir);
        }
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        cmd.creation_flags(CREATE_NO_WINDOW).output(),
    )
    .await
    .map_err(|_| format!("Command timed out after {}s", timeout_secs))?
    .map_err(|e| format!("Failed to execute command: {}", e))?;

    // Try UTF-8 decoding first, fallback to lossy conversion
    let stdout = String::from_utf8(result.stdout)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).to_string());
    let stderr = String::from_utf8(result.stderr)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).to_string());

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

async fn run_python(code: &str, work_dir: &str, timeout_secs: u64) -> Result<String, String> {
    // Check Python availability
    let python_check = Command::new("python")
        .args(["--version"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await;

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

    if !work_dir.is_empty() {
        let path = Path::new(work_dir);
        if path.exists() {
            cmd.current_dir(work_dir);
        }
    }

    let execution_result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        cmd.creation_flags(CREATE_NO_WINDOW).output(),
    )
    .await;

    // Always cleanup temp file
    let cleanup_result = tokio::fs::remove_file(&file_path).await;
    if cleanup_result.is_err() {
        eprintln!(
            "[warning] Failed to cleanup temp Python file: {:?}",
            file_path
        );
    }

    let result = execution_result
        .map_err(|_| format!("Python execution timed out after {}s", timeout_secs))?
        .map_err(|e| format!("Failed to run python: {}", e))?;

    let stdout = String::from_utf8_lossy(&result.stdout).to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).to_string();

    if result.status.success() {
        if stdout.is_empty() {
            Ok("(no output)".to_string())
        } else {
            Ok(stdout)
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
    let p = Path::new(path);

    if work_dir.is_empty() {
        let normalized = normalize_path(p);
        if has_escaping_parent(p) {
            return Err(format!(
                "Path traversal detected: '{}' escapes to parent directories without a work directory constraint",
                path
            ));
        }
        let resolved = if p.is_absolute() {
            match std::fs::canonicalize(p) {
                Ok(c) => c.to_string_lossy().to_string(),
                Err(_) => normalized.to_string_lossy().to_string(),
            }
        } else {
            normalized.to_string_lossy().to_string()
        };
        check_blocked_path(&resolved)?;
        return Ok(resolved);
    }

    let resolved = if p.is_absolute() {
        p.to_path_buf()
    } else {
        PathBuf::from(work_dir).join(p)
    };

    let normalized = normalize_path(&resolved);
    let work_dir_normalized = normalize_path(&PathBuf::from(work_dir));

    let canonical_resolved = match std::fs::canonicalize(&normalized) {
        Ok(c) => c,
        Err(_) => normalized.clone(),
    };

    let canonical_workdir = match std::fs::canonicalize(&work_dir_normalized) {
        Ok(c) => c,
        Err(_) => work_dir_normalized.clone(),
    };

    if !canonical_resolved.starts_with(&canonical_workdir) {
        return Err(format!(
            "Access denied: path '{}' resolves outside of work directory '{}'",
            path, work_dir
        ));
    }

    check_blocked_path(&canonical_resolved.to_string_lossy())?;

    Ok(canonical_resolved.to_string_lossy().to_string())
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

/// Check if a path contains `..` components that would escape above the root.
fn has_escaping_parent(path: &Path) -> bool {
    let mut depth = 0;
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                if depth > 0 {
                    depth -= 1;
                } else {
                    return true; // Escapes above root
                }
            }
            std::path::Component::CurDir => {}
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                depth = 0;
            }
            _ => {
                depth += 1;
            }
        }
    }
    false
}

/// Normalize a path without requiring it to exist on disk.
/// Resolves `.` and `..` components.
/// Returns the normalized path; if `..` would escape above root, those components
/// are preserved (not silently dropped) so the caller can detect the issue.
fn normalize_path(path: &Path) -> PathBuf {
    let mut components: Vec<std::path::Component> = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                // Only pop if there's a normal component to go back from
                if let Some(last) = components.last() {
                    match last {
                        std::path::Component::Normal(_) => {
                            components.pop();
                        }
                        // Don't pop prefixes or root dirs
                        _ => components.push(component),
                    }
                } else {
                    // No previous component — preserve the `..` so callers can detect escape
                    components.push(component);
                }
            }
            c => components.push(c),
        }
    }
    components.iter().collect()
}

/// Check if Python is available on the system
pub async fn check_python_available() -> bool {
    Command::new("python")
        .args(["--version"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::is_safe_url;

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
}
