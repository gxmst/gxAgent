pub mod background;
mod edit;
mod fs;
mod process;
mod schema;
mod search_files;
mod web_fetch;
mod web_search;

use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use tokio::sync::{mpsc, watch};

pub use process::check_python_available;
pub(crate) use process::{scrub_sensitive_env, terminate_process_tree};
pub use schema::get_enabled_tool_definitions;

const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 300; // 5 minutes
pub const TOOL_CANCELLED_ERROR: &str = "__GX_AGENT_CANCELLED__";

#[derive(Debug, Clone)]
pub struct ExecutionChunk {
    pub stream: &'static str,
    pub content: String,
}

#[derive(Deserialize)]
struct WriteFileArgs {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct EditFileArgs {
    path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

#[derive(Deserialize)]
struct CommandArgs {
    command: String,
}

#[derive(Deserialize)]
struct PythonArgs {
    code: String,
}

fn parse_tool_args<T: DeserializeOwned>(name: &str, args: &str) -> Result<T, String> {
    serde_json::from_str(args)
        .map_err(|error| format!("Error: Invalid arguments for {name}: {error}"))
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

    let args: Value = match parse_tool_args(name, args_str) {
        Ok(Value::Object(args)) => Value::Object(args),
        Ok(_) => return format!("Error: Invalid arguments for {name}: expected an object"),
        Err(error) => return error,
    };
    match name {
        "execute_command" => {
            let args: CommandArgs = match parse_tool_args(name, args_str) {
                Ok(args) => args,
                Err(error) => return error,
            };
            match process::run_execute_command(
                &args.command,
                work_dir,
                timeout_secs,
                cancel_rx,
                output_tx,
            )
            .await
            {
                Ok(out) => out,
                Err(e) if e == TOOL_CANCELLED_ERROR => e,
                Err(e) => format!("Error: {}", e),
            }
        }
        "read_file" => {
            let path = args["path"].as_str().unwrap_or("");
            let start_line = args["start_line"].as_u64().map(|n| n as usize);
            let end_line = args["end_line"].as_u64().map(|n| n as usize);
            let line_numbers = args["line_numbers"]
                .as_bool()
                .unwrap_or(start_line.is_some() || end_line.is_some());
            match fs::run_read_file_with_options(path, work_dir, start_line, end_line, line_numbers)
                .await
            {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "write_file" => {
            let args: WriteFileArgs = match parse_tool_args(name, args_str) {
                Ok(args) => args,
                Err(error) => return error,
            };
            match fs::run_write_file(&args.path, &args.content, work_dir).await {
                Ok(_) => "File written successfully.".to_string(),
                Err(e) => format!("Error: {}", e),
            }
        }
        "list_dir" => {
            let path = args["path"].as_str().unwrap_or(".");
            match fs::run_list_dir(path, work_dir).await {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "run_python" => {
            let args: PythonArgs = match parse_tool_args(name, args_str) {
                Ok(args) => args,
                Err(error) => return error,
            };
            match process::run_python(&args.code, work_dir, timeout_secs, cancel_rx, output_tx)
                .await
            {
                Ok(out) => out,
                Err(e) if e == TOOL_CANCELLED_ERROR => e,
                Err(e) => format!("Error: {}", e),
            }
        }
        "web_search" => {
            let query = args["query"].as_str().unwrap_or("");
            let search_timeout = std::time::Duration::from_secs(timeout_secs.min(20));
            let search = web_search::run_web_search(query, search_provider, search_api_key);
            tokio::pin!(search);
            if let Some(mut receiver) = cancel_rx {
                tokio::select! {
                    result = tokio::time::timeout(search_timeout, &mut search) => match result {
                        Ok(Ok(out)) => out,
                        Ok(Err(e)) => format!("Error: {}", e),
                        Err(_) => format!("Error: Search timed out after {}s. DuckDuckGo may be blocked in your network - consider using Tavily API instead.", search_timeout.as_secs()),
                    },
                    _ = process::wait_for_cancel(&mut receiver) => TOOL_CANCELLED_ERROR.to_string(),
                }
            } else {
                match tokio::time::timeout(search_timeout, &mut search).await {
                    Ok(Ok(out)) => out,
                    Ok(Err(e)) => format!("Error: {}", e),
                    Err(_) => format!("Error: Search timed out after {}s. DuckDuckGo may be blocked in your network - consider using Tavily API instead.", search_timeout.as_secs()),
                }
            }
        }
        "web_fetch" => {
            let url = args["url"].as_str().unwrap_or("");
            let max_chars = args["max_chars"].as_u64().map(|n| n as usize);
            let fetch_timeout = std::time::Duration::from_secs(timeout_secs.min(25));
            let fetch = web_fetch::run_web_fetch(url, max_chars);
            tokio::pin!(fetch);
            if let Some(mut receiver) = cancel_rx {
                tokio::select! {
                    result = tokio::time::timeout(fetch_timeout, &mut fetch) => match result {
                        Ok(Ok(out)) => out,
                        Ok(Err(e)) => format!("Error: {}", e),
                        Err(_) => format!("Error: Fetch timed out after {}s.", fetch_timeout.as_secs()),
                    },
                    _ = process::wait_for_cancel(&mut receiver) => TOOL_CANCELLED_ERROR.to_string(),
                }
            } else {
                match tokio::time::timeout(fetch_timeout, &mut fetch).await {
                    Ok(Ok(out)) => out,
                    Ok(Err(e)) => format!("Error: {}", e),
                    Err(_) => format!("Error: Fetch timed out after {}s.", fetch_timeout.as_secs()),
                }
            }
        }
        "get_current_time" => fs::run_current_time(&args),
        "edit_file" => {
            let args: EditFileArgs = match parse_tool_args(name, args_str) {
                Ok(args) => args,
                Err(error) => return error,
            };
            match edit::run_edit_file(
                &args.path,
                &args.old_string,
                &args.new_string,
                args.replace_all,
                work_dir,
            )
            .await
            {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "grep" => {
            let pattern = args["pattern"].as_str().unwrap_or("");
            let path = args["path"].as_str().unwrap_or(".");
            let glob = args["glob"].as_str();
            let case_insensitive = args["case_insensitive"].as_bool().unwrap_or(false);
            match search_files::run_grep(pattern, path, glob, case_insensitive, work_dir).await {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "glob" => {
            let pattern = args["pattern"].as_str().unwrap_or("");
            let path = args["path"].as_str().unwrap_or(".");
            match search_files::run_glob(pattern, path, work_dir).await {
                Ok(out) => out,
                Err(e) => format!("Error: {}", e),
            }
        }
        "todo_write" => fs::run_todo_write(&args),
        "start_background_process" => {
            let command = args["command"].as_str().unwrap_or("");
            let label = args["label"].as_str();
            match background::start_background_process(command, work_dir, label).await {
                Ok(info) => serde_json::to_string_pretty(&info).unwrap_or_default(),
                Err(e) => format!("Error: {}", e),
            }
        }
        "read_background_output" => {
            let process_id = args["process_id"].as_str().unwrap_or("");
            let tail_lines = args["tail_lines"].as_u64().unwrap_or(100) as usize;
            match background::read_background_output(process_id, tail_lines).await {
                Ok(out) => serde_json::to_string_pretty(&out).unwrap_or_default(),
                Err(e) => format!("Error: {}", e),
            }
        }
        "stop_background_process" => {
            let process_id = args["process_id"].as_str().unwrap_or("");
            match background::stop_background_process(process_id).await {
                Ok(msg) => msg,
                Err(e) => format!("Error: {}", e),
            }
        }
        "list_background_processes" => {
            let list = background::list_background_processes_internal().await;
            serde_json::to_string_pretty(&list).unwrap_or_else(|_| "[]".to_string())
        }
        "save_memory" => {
            let category = args["category"].as_str().unwrap_or("project");
            let key = args["key"].as_str().unwrap_or("");
            let content = args["content"].as_str().unwrap_or("");
            match crate::memory::upsert_memory(work_dir, category, key, content) {
                Ok(entry) => serde_json::to_string_pretty(&entry).unwrap_or_default(),
                Err(e) => format!("Error: {}", e),
            }
        }
        "delete_memory" => {
            let key_or_id = args["key_or_id"].as_str().unwrap_or("");
            match crate::memory::remove_memory(work_dir, key_or_id) {
                Ok(true) => format!("Deleted memory '{}'.", key_or_id),
                Ok(false) => format!("No memory matched '{}'.", key_or_id),
                Err(e) => format!("Error: {}", e),
            }
        }
        "list_memories" => match crate::memory::load_memories(work_dir) {
            Ok(list) => serde_json::to_string_pretty(&list).unwrap_or_else(|_| "[]".to_string()),
            Err(e) => format!("Error: {}", e),
        },
        _ => format!("Unknown tool: {}", name),
    }
}

#[cfg(test)]
mod tests {
    use super::edit::{common_indent, locate_edit, nearest_match_hint, EditMatchKind};
    use super::fs::{run_current_time, run_read_file_with_options};
    use super::process::{
        capture_process_output, clone_captured_output, finish_process_reader, should_scrub_env_var,
        spawn_process_reader, ProcessOutputBudget, PROCESS_OUTPUT_TRUNCATION_NOTICE,
    };
    use super::schema::get_all_tool_definitions;
    use super::search_files::glob_to_regex;
    use super::web_fetch::{html_to_readable_text, run_web_fetch};
    use super::web_search::{
        format_tavily_response, is_safe_url, run_web_search, tavily_error_detail,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn invalid_write_arguments_leave_existing_file_untouched() {
        let dir = std::env::temp_dir().join(format!("gx-tool-args-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("example.txt");
        std::fs::write(&file, "original text").unwrap();
        for (tool, args) in [
            ("write_file", r#"{"path":"example.txt"}"#),
            ("write_file", r#"{"path":"example.txt","content":null}"#),
            ("write_file", r#"{"path":"example.txt","content":123}"#),
            ("write_file", r#"{"path":"example.txt","content":"""#),
            (
                "edit_file",
                r#"{"path":"example.txt","old_string":"original"}"#,
            ),
            (
                "edit_file",
                r#"{"path":"example.txt","old_string":"original","new_string":false}"#,
            ),
            (
                "edit_file",
                r#"{"path":"example.txt","old_string":"original","new_string":"","replace_all":"yes"}"#,
            ),
            ("execute_command", "{}"),
            ("run_python", "{}"),
        ] {
            let result = super::execute_tool(tool, args, dir.to_str().unwrap(), "", "").await;
            assert!(
                result.starts_with("Error: Invalid arguments"),
                "{tool}: {result}"
            );
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "original text");
        }
        let result = super::execute_tool(
            "edit_file",
            r#"{"path":"example.txt","old_string":"original","new_string":""}"#,
            dir.to_str().unwrap(),
            "",
            "",
        )
        .await;
        assert!(!result.starts_with("Error:"), "{result}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), " text");
        let result = super::execute_tool(
            "write_file",
            r#"{"path":"example.txt","content":""}"#,
            dir.to_str().unwrap(),
            "",
            "",
        )
        .await;
        assert!(!result.starts_with("Error:"), "{result}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "");
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn apply_edit(
        original: &str,
        old: &str,
        new: &str,
        replace_all: bool,
    ) -> Option<(String, EditMatchKind)> {
        let located = locate_edit(original, old, new)?;
        let spans = if replace_all {
            located.spans.as_slice()
        } else {
            &located.spans[..1]
        };
        let mut updated = original.to_string();
        for (start, end, replacement) in spans.iter().rev() {
            updated.replace_range(*start..*end, replacement);
        }
        Some((updated, located.kind))
    }

    #[test]
    fn edit_prefers_exact_match_and_preserves_rest_of_file() {
        let src = "fn a() {\n    let x = 1;\n}\n";
        let (out, kind) = apply_edit(src, "let x = 1;", "let x = 2;", false).expect("match");
        assert_eq!(kind, EditMatchKind::Exact);
        assert_eq!(out, "fn a() {\n    let x = 2;\n}\n");
    }

    #[test]
    fn edit_matches_despite_trailing_whitespace_difference() {
        let src = "fn a() {\n    let x = 1;   \n    let y = 2;\n}\n";
        let (out, kind) = apply_edit(
            src,
            "    let x = 1;\n    let y = 2;",
            "    let x = 9;\n    let y = 8;",
            false,
        )
        .expect("match");
        assert_eq!(kind, EditMatchKind::TrailingWhitespace);
        assert_eq!(out, "fn a() {\n    let x = 9;\n    let y = 8;\n}\n");
    }

    #[test]
    fn edit_keeps_exact_match_when_needle_is_a_substring_of_a_padded_line() {
        let src = "fn a() {\n    let x = 1;   \n}\n";
        let (out, kind) =
            apply_edit(src, "    let x = 1;", "    let x = 2;", false).expect("match");
        assert_eq!(kind, EditMatchKind::Exact);
        assert_eq!(out, "fn a() {\n    let x = 2;   \n}\n");
    }

    #[test]
    fn edit_matches_dedented_needle_and_reindents_replacement() {
        let src = "impl T {\n    fn a() {\n        step();\n    }\n}\n";
        let (out, kind) = apply_edit(
            src,
            "fn a() {\n    step();\n}",
            "fn a() {\n    step();\n    more();\n}",
            false,
        )
        .expect("match");
        assert_eq!(kind, EditMatchKind::Reindented);
        assert_eq!(
            out,
            "impl T {\n    fn a() {\n        step();\n        more();\n    }\n}\n"
        );
    }

    #[test]
    fn edit_reports_all_occurrences_for_replace_all() {
        let src = "a();\nb();\na();\n";
        let located = locate_edit(src, "a();", "z();").expect("match");
        assert_eq!(located.spans.len(), 2);
        let (out, _) = apply_edit(src, "a();", "z();", true).expect("match");
        assert_eq!(out, "z();\nb();\nz();\n");
    }

    #[test]
    fn edit_returns_none_when_nothing_resembles_the_needle() {
        let src = "fn a() {\n    let x = 1;\n}\n";
        assert!(locate_edit(src, "let completely = different;", "x").is_none());
    }

    #[test]
    fn nearest_match_hint_points_at_the_closest_line() {
        let src = "fn alpha() {\n    let value = compute(1);\n}\n";
        let hint = nearest_match_hint(src, "let value = compute(2);");
        assert!(hint.contains("line 2"), "unexpected hint: {hint}");
        assert!(hint.contains("compute(1)"), "unexpected hint: {hint}");
    }

    #[test]
    fn nearest_match_hint_stays_silent_on_weak_similarity() {
        let src = "fn alpha() {\n    let value = 1;\n}\n";
        assert_eq!(nearest_match_hint(src, "totally unrelated tokens here"), "");
    }

    #[test]
    fn common_indent_ignores_blank_lines() {
        assert_eq!(common_indent("    a\n\n    b\n"), 4);
        assert_eq!(common_indent("a\n    b\n"), 0);
    }

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
    fn current_time_tool_is_exposed_and_returns_both_clocks() {
        let names: Vec<String> = get_all_tool_definitions()
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str().map(String::from))
            .collect();
        assert!(names.iter().any(|name| name == "get_current_time"));

        let local = run_current_time(&json!({"timezone": "local"}));
        assert!(local.starts_with("Current local time:"));
        assert!(local.contains("UTC:"));

        let utc = run_current_time(&json!({"timezone": "utc"}));
        assert!(utc.starts_with("Current UTC time:"));
        assert!(utc.contains("Local time:"));
    }

    #[tokio::test]
    async fn web_search_rejects_empty_queries_before_contacting_a_provider() {
        let error = run_web_search("  \n ", "tavily", "secret")
            .await
            .expect_err("empty query must be rejected");
        assert!(error.contains("missing or empty"));
    }

    #[test]
    fn tavily_output_keeps_sources_when_an_answer_is_present() {
        let output = format_tavily_response(&json!({
            "answer": "A synthesized answer",
            "results": [{
                "title": "Example source",
                "url": "https://example.com/article",
                "content": "Supporting evidence"
            }]
        }));
        assert!(output.contains("Answer: A synthesized answer"));
        assert!(output.contains("Title: Example source"));
        assert!(output.contains("Link: https://example.com/article"));
    }

    #[test]
    fn tavily_error_detail_extracts_json_and_limits_raw_bodies() {
        assert_eq!(
            tavily_error_detail(r#"{"detail":"invalid api key"}"#),
            "invalid api key"
        );
        assert_eq!(tavily_error_detail(""), "No error details returned.");
        assert_eq!(tavily_error_detail(&"x".repeat(800)).len(), 500);
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

    #[tokio::test]
    async fn read_file_supports_line_slices_and_line_numbers() {
        let dir = std::env::temp_dir().join(format!("gx-read-lines-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.txt");
        std::fs::write(&file, "alpha\nbeta\ngamma\ndelta\n").unwrap();

        let raw =
            run_read_file_with_options("sample.txt", dir.to_str().unwrap(), None, None, false)
                .await
                .unwrap();
        assert_eq!(raw, "alpha\nbeta\ngamma\ndelta\n");

        let slice =
            run_read_file_with_options("sample.txt", dir.to_str().unwrap(), Some(2), Some(3), true)
                .await
                .unwrap();
        assert!(slice.starts_with("[Lines 2-3 of 4]"));
        assert!(slice.contains("2: beta"));
        assert!(slice.contains("3: gamma"));
        assert!(!slice.contains("alpha"));
        assert!(!slice.contains("delta"));

        let err =
            run_read_file_with_options("sample.txt", dir.to_str().unwrap(), Some(99), None, true)
                .await
                .unwrap_err();
        assert!(err.contains("exceeds file length"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn web_fetch_rejects_private_urls_and_strips_html() {
        let err = run_web_fetch("http://127.0.0.1:8080/secret", None)
            .await
            .unwrap_err();
        assert!(err.contains("blocked"));

        let text = html_to_readable_text(
            "<html><head><style>.x{}</style><script>alert(1)</script></head>\
             <body><h1>Docs</h1><p>Hello &amp; welcome</p><ul><li>Item 1</li></ul></body></html>",
        );
        assert!(text.contains("Docs"));
        assert!(text.contains("Hello & welcome"));
        assert!(text.contains("- Item 1"));
        assert!(!text.contains("alert(1)"));
    }

    #[test]
    fn env_scrubbing_targets_api_keys_and_gxagent_secrets() {
        assert!(should_scrub_env_var("OPENAI_API_KEY"));
        assert!(should_scrub_env_var("anthropic_api_key"));
        assert!(should_scrub_env_var("GXAGENT_MASTER_SECRET"));
        assert!(!should_scrub_env_var("PATH"));
        assert!(!should_scrub_env_var("GXAGENT_WORK_DIR"));
    }
}
