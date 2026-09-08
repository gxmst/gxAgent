# gxAgent Studio

[简体中文](./README.zh-CN.md)

gxAgent Studio is a cross-platform desktop AI agent built with Tauri v2, React 19, TypeScript, and Rust. It combines everyday chat, agentic coding workflows, local tools, web search, multi-session management, and MCP extension support in one local-first app.

## Features

### Agent Workflows

- Chat Mode for daily conversations, brainstorming, writing, and prompt assistance.
- Code Mode for agentic workspace tasks with file access, command execution, Python execution, web search, and MCP tools.
- Runtime steering lets you redirect a running Code Mode task without restarting the session.
- Workspace rules are loaded from files such as `.gxagent.md`, `AGENTS.md`, and `CLAUDE.md`.
- Git auto-checkpoints run before modifying file writes or command execution in Git workspaces.

### Model Providers

- Built-in presets for DeepSeek, OpenAI, Anthropic Claude, Google Gemini, Ollama, and OpenAI-compatible endpoints.
- Decoupled wire format setting: choose OpenAI, Anthropic, Gemini, or Ollama protocol independently of the provider preset.
- Streaming responses, tool calls, and tool results are normalized internally across supported wire formats.
- API profiles store provider, base URL, model, API key, and wire format for quick switching.
- Model picker and model list fetching are available from the settings flow.

### Safety And Cost Controls

- API keys are encrypted at rest with AES-256-GCM using a machine-local Argon2-derived v3 key.
- Legacy `enc:v1` and `enc:v2` keys are migrated automatically to v3 after they are successfully decrypted.
- Imported encrypted keys that cannot be decrypted on the current device are cleared and the user is asked to re-enter them.
- MCP server environment variables block common injection hooks such as `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONHOME`, `RUBYOPT`, `PERL5OPT`, `BASH_ENV`, `ENV`, and `GIT_CONFIG_*`.
- `PATH` and proxy variables are allowed so enterprise and local MCP setups keep working.
- Agent resource budgets are configurable:
  - `max_agent_loops`, default `10`, hard-capped at `20`.
  - `max_tool_calls_per_request`, default `30`, hard-capped at `100`.
- Tool failures, search failures, and budget-limit observations are returned to the model so it can decide whether to recover, summarize, or ask the user to continue.
- User cancellation, approval rejection, policy blocks, and API protocol errors remain explicit stop conditions.

### Interface

- GitHub Flavored Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Streaming output with separate reasoning display when available.
- Context divider and history compaction to reduce context size.
- Multiple color themes: light, dark, Yuzu Study, Ember Terminal, Midnight Grape, and Twilight Amber.
- Resizable layout, smart scrolling, session search, role presets, and keyboard shortcuts.
- Secret fields are masked by default with a reveal toggle.

## Workbench And Coding Engines

The shared sidebar groups tasks by project and keeps standalone chats alongside them. Chat / Work switches the current session's mode. Drafts and selected files stay with their task. The optional workspace panel contains Changes, Files, Runs, Context, and Preview; Git review includes a per-run checkpoint when available.

In **Settings > Connections**, select the default coding engine. A Work session can override it in its response options or session settings. Chat continues to use gxAgent's provider profiles.

- **gxAgent** uses the existing provider adapters, local tools, tool switches, trust patterns, resource budgets, and manual history compaction.
- **Codex** starts an installed Codex CLI through the official [app-server protocol](https://developers.openai.com/codex/app-server). Install and authenticate the CLI first, then use **Check Codex connection**. The check reads account state and the model catalog without starting a model turn. Windows can discover a standard npm installation; a custom path must point to the native executable.

Codex supports thread continuation, text and image input, reasoning, tool activity, command/file approvals, user questions, steering, and interruption. Edited, retried, or isolated history starts a new thread with the visible context. Selecting an HTML or SVG file opens it in Preview. Planning uses a read-only sandbox; ordinary work uses workspace-write with on-request approvals (strict policy uses untrusted). Explicit full trust grants full access without approvals.

Codex uses its own authentication, tools, context management, and CLI configuration, including project rules. gxAgent's provider sampling parameters, native tool switches (except web search), trust patterns, and loop/tool budgets do not constrain Codex. Configured MCP servers are passed as Codex configuration overrides. Manual `/compact` is currently available with the gxAgent engine; unsupported Codex server interactions return an explicit error. This integration does not implement the entire Codex desktop feature set.

## Recovery And Learning Tools

| Capability | Entry point and behavior |
| :--- | :--- |
| Persistence and recovery | Streaming progress is saved every five seconds. Settings > Data provides snapshots, restoration as a separate task, and damaged-session repair. Interrupted tools are never replayed automatically. |
| MCP inspector | Settings > Tools & MCP lists schemas, accepts JSON arguments, and displays full results, errors, and timing for local stdio servers. |
| Context inspector | Inspect context below a response or use the Context workspace tab to view messages, tool definitions, skills, and retrieval evidence, with JSON export. Codex snapshots show the input supplied by gxAgent to the CLI. |
| Skills | Settings > Skills discovers global and project `SKILL.md` files, supports explicit enablement, checks MCP dependencies, and previews reference files. Session settings override global selections. |
| Local knowledge | Settings > Knowledge supports document indexing, chunk settings, BM25 search, citations, and fixed-question retrieval evaluations with saved reports. |

Retrieval uses SQLite FTS5 / BM25 with CJK bigrams. Indexing and search run locally; retrieved passages are sent to the selected model when answering. Vector embeddings, reranking, and OCR are not implemented. Evaluations measure document hit rate and reciprocal rank, not generated-answer quality. PDF extraction requires `pdftotext` in PATH; Office extraction is currently Windows-only.

Snapshots preserve previous valid sessions at most once per five minutes during ordinary saves, and before deletion or bulk replacement. Manual snapshots first flush pending saves. Restoring a copy or repairing a damaged task disconnects its old Codex thread. Existing backups and damaged original bytes are retained. Knowledge data lives in the system application data directory under `gxAgent/knowledge.sqlite3`; snapshots live in `gxAgent/sessions/backups/`.

Skills are discovered in `~/.agents/skills`, `<project>/.agents/skills`, `<project>/.gxagent/skills`, and configured roots. Enabled instructions are injected for each request; scripts are not run automatically. Codex CLI's own skill discovery is configured separately. Context inspection retains the latest six calls per response, omits image payloads and common credential fields, and marks oversized snapshots as truncated. It does not expose Codex's internal context.

See the [Chinese learning guide](docs/learning-lab.zh-CN.md) for examples and a repeatable learning workflow.

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl + N` | Create a new session |
| `Ctrl + Shift + N` | Toggle Chat / Code mode |
| `Ctrl + ,` | Open Settings |
| `Enter` | Send message |
| `Shift + Enter` | Insert a new line |
| `Esc` | Close modals and active panels |

## Tech Stack

| Layer | Technologies |
| :--- | :--- |
| Frontend | React 19, TypeScript, Vite |
| Desktop shell | Tauri v2, Rust, Tokio |
| LLM transport | Reqwest, provider adapters for OpenAI / Anthropic / Gemini / Ollama |
| Knowledge and skills | SQLite FTS5 / BM25, YAML metadata, JSON Schema validation |
| Rendering | react-markdown, remark-gfm, remark-math, rehype-katex, Mermaid |
| Security | AES-256-GCM, Argon2, policy approvals, MCP environment validation |

## Project Structure

```text
gxAgent/
|-- src/                         # Frontend React + TypeScript
|   |-- App.tsx                  # Main app shell and view state
|   |-- App.css                  # Global styles and theme tokens
|   |-- types.ts                 # Shared TypeScript declarations
|   |-- rolePresets.ts           # Built-in role presets
|   `-- main.tsx                 # Frontend entry point
|-- src-tauri/                   # Rust backend and Tauri shell
|   |-- src/
|   |   |-- lib.rs               # Tauri commands and app startup
|   |   |-- agent.rs             # Agent loop, tools, streaming orchestration
|   |   |-- provider.rs          # Wire-format adapters
|   |   |-- config.rs            # App config and defaults
|   |   |-- crypto.rs            # API key encryption and migration
|   |   |-- tools.rs             # Built-in tool implementations
|   |   |-- policy.rs            # Approval and command policy engine
|   |   `-- mcp.rs               # MCP server manager
|   |-- Cargo.toml
|   `-- tauri.conf.json
|-- package.json
`-- README.md
```

## Getting Started

### Prerequisites

- Node.js 22.12 or newer
- Rust and Cargo stable
- Platform-specific Tauri prerequisites from the [Tauri setup guide](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
npm install
npm run tauri dev
```

### Validation

```bash
npm test
npm run test:ui
npm run build
cd src-tauri
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
```

Browser tests use an isolated Tauri fixture and never run real model tasks. Each run starts its own Vite server on port `1421` (override with `PLAYWRIGHT_PORT`). On Windows they use Edge; set `PLAYWRIGHT_CHANNEL` to select another installed browser. Rust tests exercise an actual stdio MCP subprocess, local SQLite retrieval/evaluation, and snapshot recovery in temporary directories. Screenshots are temporary files in `.shots/workbench/`. `npm run build` produces the frontend bundle in `dist/`, not a desktop executable.

### Production Build

```bash
npm run tauri build
```

Cargo normally writes binaries and installers under `src-tauri/target/release/` and `src-tauri/target/release/bundle/`; a configured `CARGO_TARGET_DIR` changes that root. A shared Cargo target remains disposable build cache. Ordinary builds do not create a durable delivery archive.

On Windows, `npm run build:desktop` builds the executable and MSI/NSIS installers and reports their actual paths. `npm run build:archive` additionally copies final deliverables and full third-party notices into `../_build_artifacts/<project>/<timestamp>-<commit>[-dirty]/`, verifies SHA-256 checksums, and writes a build manifest. Set `GXAGENT_ARTIFACTS_DIR` to override the archive root. `LATEST.txt` contains only the relative archive directory name. Archives exclude compiler caches and user data. The executable requires WebView2 and uses the normal Windows user profile; it is not a portable-data package. Local unsigned builds are not public releases.

## Configuration And Security

Configuration and API profiles are stored in the standard app config directory:

- Windows: `%APPDATA%\gxAgent\config.json`
- macOS: `~/Library/Application Support/gxAgent/config.json`
- Linux: `~/.config/gxAgent/config.json`

API keys are encrypted before being written to disk. Do not share `config.json` if it contains active credentials, even though the keys are encrypted for the local machine.

## License

Private project. All rights reserved.
