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

- Node.js 18 or newer
- Rust and Cargo stable
- Platform-specific Tauri prerequisites from the [Tauri setup guide](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
npm install
npm run tauri dev
```

### Validation

```bash
npm run build
cd src-tauri
cargo check
cargo test
```

### Production Build

```bash
npm run tauri build
```

Build outputs are written under `src-tauri/target/release/` and `src-tauri/target/release/bundle/`.

## Configuration And Security

Configuration and API profiles are stored in the standard app config directory:

- Windows: `%APPDATA%\gxAgent\config.json`
- macOS: `~/Library/Application Support/gxAgent/config.json`
- Linux: `~/.config/gxAgent/config.json`

API keys are encrypted before being written to disk. Do not share `config.json` if it contains active credentials, even though the keys are encrypted for the local machine.

## License

Private project. All rights reserved.
