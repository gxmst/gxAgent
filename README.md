# gxAgent Studio

[![简体中文](https://img.shields.io/badge/Language-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)](./README.zh-CN.md)

A powerful, cross-platform AI Agent desktop application built with **Tauri v2, React 19, TypeScript, and Rust**. Designed to support seamless daily conversations, advanced agentic coding workflows, multi-session management, and custom tools.

---

## ✨ Features

### 🤖 Intelligent Core
* **Dual Modes**:
  * **Chat Mode**: Tailored for daily conversations, brainstorming, and prompt assistance.
  * **Code Mode (Agent)**: An autonomous coding agent that executes tasks directly in your workspace.
* **Steerable Runtime Queue**: Intervene or redirect the agent's behavior at any time while it is running in Code Mode.
* **Workspace Rules Autoloading**: Automatically scans your target directory for rules files like `.gxagent.md`, `AGENTS.md`, or `CLAUDE.md` to customize system behavior dynamically.
* **Git Auto-Checkpoint**: Safely saves Git checkpoints before running modifying commands or file writes, ensuring zero code loss.

### 💬 Experience & Interface
* **Markdown & Mermaid Support**: Full GitHub Flavored Markdown (GFM) rendering with syntax highlighting, math formulas (KaTeX), and interactive Mermaid diagrams.
* **Context Divider**: Isolate chat context above a certain point to drastically reduce token consumption.
* **Stream Response**: Smooth, real-time typing animation for instant feedback.
* **Rich UI Features**: Resizable split panels (persisted layout), smart auto-scrolling, dark/light themes, and full keyboard shortcut support.

### ⚙️ Power & Security
* **Multi-LLM Provider Integration**: Native presets and configuration for DeepSeek, OpenAI, Gemini, Ollama, and any OpenAI-compatible API.
* **API Profile Manager**: Save, switch, and customize multiple API configurations (base URL, keys, system prompts, models, parameters).
* **Model Picker**: Quickly swap active session models directly from the chat input bar.
* **Encrypted at Rest**: All API profiles and keys are securely encrypted with AES-256-GCM before being written to disk.
* **MCP Integration**: Full Model Context Protocol (MCP) server support to extend your agent with custom tools.

---

## 🎹 Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl + N` | Create a new session |
| `Ctrl + Shift + N` | Toggle Chat / Code mode |
| `Ctrl + ,` | Open Settings panel |
| `Enter` | Send message |
| `Shift + Enter` | Insert new line in input |
| `Esc` | Close modals and active panels |

---

## 🛠️ Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | React 19, TypeScript, Vite |
| **Desktop Shell** | Tauri v2 (Rust, Tokio) |
| **Markdown** | react-markdown, remark-gfm, remark-math, rehype-katex |
| **Visualizations** | Mermaid, react-syntax-highlighter, Lucide Icons |
| **Communication** | Reqwest (Rust), Tauri IPC |
| **Security** | AES-256-GCM |

---

## 📂 Project Structure

```
gxAgent/
├── src/                          # Frontend React + TypeScript
│   ├── App.tsx                   # Main layout and view state
│   ├── App.css                   # Global styles & theme tokens
│   ├── types.ts                  # Shared TypeScript declarations
│   ├── rolePresets.ts            # Custom system prompt definitions
│   └── main.tsx                  # Frontend entry point
├── src-tauri/                    # Backend Rust & Tauri Shell
│   ├── src/
│   │   ├── lib.rs                # App startup & Tauri command handlers
│   │   ├── agent.rs              # LLM client & streaming agent orchestrator
│   │   ├── config.rs             # Application profiles & storage manager
│   │   ├── crypto.rs             # Hardware-accelerated AES key encryption
│   │   ├── tools.rs              # Core agent tools (file access, commands)
│   │   ├── policy.rs             # Command execution approval engine
│   │   └── mcp.rs                # MCP client coordinator
│   ├── Cargo.toml                # Rust dependencies
│   └── tauri.conf.json           # Tauri bundle & capability config
└── package.json                  # Frontend dependencies
```

---

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed on your machine:
* [Node.js](https://nodejs.org/) (v18 or higher)
* [Rust & Cargo](https://www.rust-lang.org/tools/install) (stable release)
* Platform-specific Tauri prerequisites (see the [Tauri Setup Guide](https://v2.tauri.app/start/prerequisites/))

### Installation & Run

1. Clone the repository and navigate to the project root.
2. Install frontend dependencies:
   ```bash
   npm install
   ```
3. Run the application in development mode:
   ```bash
   npm run tauri dev
   ```

### Production Build

To compile a highly optimized standalone executable:
```bash
npm run tauri build
```

The compiled binaries will be output to:
* **Standalone Executable**: `src-tauri/target/release/gxAgent.exe`
* **MSI Installer**: `src-tauri/target/release/bundle/msi/...`
* **NSIS Installer**: `src-tauri/target/release/bundle/nsis/...`

---

## 🔒 Configuration & Security

Configuration, API profiles, and session histories are securely stored in the standard app data directory of your operating system:
* **Windows**: `%APPDATA%\gxAgent\config.json`
* **macOS**: `~/Library/Application Support/gxAgent/config.json`
* **Linux**: `~/.config/gxAgent/config.json`

> [!WARNING]
> Your API keys are encrypted using a local hardware-linked AES-256-GCM key before being persisted. Do not share your `config.json` file if it contains active credentials.

---

## 📄 License

Private project. All rights reserved.
