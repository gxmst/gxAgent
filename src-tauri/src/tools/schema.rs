use serde_json::{json, Value};

pub fn get_all_tool_definitions() -> Vec<Value> {
    let (shell_description, command_description) = if cfg!(target_os = "windows") {
        (
            "Execute a shell command on the local Windows machine using PowerShell and return stdout/stderr. Use this to run scripts, install packages, manage files, or diagnose system issues. IMPORTANT: Use PowerShell syntax only — do NOT use || or &&, use ; to chain commands. Use 2>$null to suppress errors.",
            "The PowerShell command to execute",
        )
    } else {
        (
            "Execute a shell command on the local machine using sh and return stdout/stderr. Use this to run scripts, install packages, manage files, or diagnose system issues.",
            "The POSIX shell command to execute",
        )
    };
    vec![
        json!({
            "type": "function",
            "function": {
                "name": "execute_command",
                "description": shell_description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": command_description }
                    },
                    "required": ["command"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the content of a local file. Pass optional start_line and end_line (1-indexed, inclusive) for large source files so you only inspect the needed range with line numbers.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute or relative file path to read" },
                        "start_line": { "type": "integer", "description": "Optional 1-indexed starting line number." },
                        "end_line": { "type": "integer", "description": "Optional 1-indexed inclusive ending line number." },
                        "line_numbers": { "type": "boolean", "description": "Include line numbers in the output. Defaults to true when slicing lines." }
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
                "name": "web_fetch",
                "description": "Fetch a public HTTP(S) web page or documentation URL and extract readable text/Markdown.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "Public http:// or https:// URL to fetch" },
                        "max_chars": { "type": "integer", "description": "Optional character cap (500-50000, default 20000)." }
                    },
                    "required": ["url"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_current_time",
                "description": "Get the current local time and UTC time. Use this for questions about the current date or time instead of guessing. The optional timezone accepts only 'local' or 'utc'.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "timezone": { "type": "string", "enum": ["local", "utc"], "description": "Which clock to put first. Defaults to local." }
                    }
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
        json!({
            "type": "function",
            "function": {
                "name": "spawn_agent",
                "description": "Ask a focused read-only subagent to investigate a bounded task and return a concise report. Subagents have no tools and cannot create nested agents.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": { "type": "string", "description": "The focused task for the subagent." },
                        "context_hint": { "type": "string", "description": "Optional context or files that may help the subagent." }
                    },
                    "required": ["task"]
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
