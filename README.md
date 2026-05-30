# gxAgent Studio

跨平台 AI Agent 桌面应用，基于 Tauri + React + TypeScript + Rust 构建。支持对话/编程双模式、多会话管理、工具集成、联网搜索等功能。

A cross-platform AI agent desktop application built with Tauri + React + TypeScript + Rust. Supports Chat and Code modes, multi-session management, tool integration, web search, and more.

---

## 功能特性 / Features

### 核心 / Core
- **双模式 / Dual Mode**：对话模式用于日常聊天，编程模式用于 Agent 自主编码任务 / Chat mode for conversations, Code mode for agentic coding tasks
- **多会话 / Multi-Session**：创建、切换、搜索、排序、导入/导出会话 / Create, switch, search, reorder, import/export sessions
- **流式输出 / Streaming Response**：实时流式输出，带打字光标动画 / Real-time streaming output with typing cursor animation
- **多 LLM 供应商 / Multi-LLM Provider**：支持 DeepSeek、OpenAI、Gemini、Ollama 及任何 OpenAI 兼容 API / Support DeepSeek, OpenAI, Gemini, Ollama and any OpenAI-compatible API
- **API 配置管理 / API Profile Management**：保存和切换多组 API 配置（地址、密钥、模型）/ Save and switch between multiple API configurations (base URL, key, model)
- **模型选择器 / Model Picker**：输入栏快速切换当前会话模型 / Quick model switch per session from the input bar

### 对话与消息 / Chat & Messages
- **Markdown 渲染 / Markdown Rendering**：完整 GFM 支持，含语法高亮、数学公式 (KaTeX)、Mermaid 图表 / Full GFM support with syntax highlighting, math (KaTeX), Mermaid diagrams
- **代码块 / Code Block**：点击语言标签复制代码，带视觉反馈 / Click language tag to copy code with visual feedback
- **消息编辑 / Message Editing**：编辑已发送消息，文本框自动适配内容高度 / Edit any sent message; textarea auto-sizes to match original content
- **上下文截断 / Context Divider**：在指定位置插入截断线，忽略上方上下文以减少 Token 消耗 / Isolate context above a certain point to reduce token usage
- **时间戳 / Timestamps**：每条消息显示发送时间 / Each message shows its send time
- **联网搜索 / Web Search**：集成 DuckDuckGo / Tavily 搜索，带状态指示 / Integrated DuckDuckGo / Tavily search with status indicator
- **文件附件 / File Attachments**：拖放或选择图片和文本文件附加到消息 / Attach images and text files to messages

### 会话管理 / Session Management
- **自动标题 / Auto Title**：会话标题根据首条消息自动生成 / Session titles auto-generated from first message content
- **搜索过滤 / Search & Filter**：防抖搜索会话标题和消息内容 / Debounced search across session titles and message content
- **排序 / Reorder**：右键菜单上移/下移会话 / Move sessions up/down via context menu
- **导入/导出 / Import/Export**：支持 JSON 和 Markdown 格式 / JSON and Markdown format support
- **删除确认 / Delete Confirmation**：防止误删会话 / Prevent accidental session deletion
- **元数据显示 / Metadata Display**：显示消息数和最后活跃时间 / Message count and last active time per session

### Agent 模式 / Agent Mode (v1.4)
- **运行时干预队列 / Runtime Steering Queue**：编程模式下 Agent 运行时可随时发送指令干预方向 / Send instructions at any time while the agent is running in Code Mode to steer its execution dynamically
- **工作区规则自动加载 / Workspace Rules Autoloading**：自动扫描目标目录中的 `.gxagent.md`、`AGENTS.md`、`CLAUDE.md` 规则文件 / Automatically scans for and incorporates rules from `.gxagent.md`, `AGENTS.md`, or `CLAUDE.md` into the system prompt
- **动态上下文压缩 / Dynamic Context Compaction**：自动压缩消息历史，截断过长输出以安全保持在 LLM 上下文限制内 / Automatically compresses message history and truncates large outputs to stay within LLM context limits
- **Git 自动检查点 / Git Auto-Checkpoint**：执行修改命令或写入文件前自动保存 Git 检查点 / Automatically saves Git checkpoints before running modifying commands or file writes

### 设置 / Settings (Tabbed UI)
- **外观 / Appearance**：主题（浅色/深色）、语言（中文/English）、字体大小 / Theme (light/dark), language (中文/English), font size
- **API**：配置管理、供应商预设、地址、密钥、模型选择、系统提示词、温度、Top-P、最大 Token、上下文限制 / Profile management, provider presets, base URL, API key, model selection, system prompt, temperature, top-P, max tokens, context limit
- **行为 / Behavior**：审批策略、工作目录、工具开关、白名单、沙箱、命令超时、搜索引擎 / Approval policy, working directory, tool toggles, whitelist, sandbox, command timeout, search provider
- **高级 / Advanced**：MCP 服务器管理、配置导入/导出、清除会话 / MCP server management, config export/import, session clearing

### 快捷键 / Keyboard Shortcuts
| 快捷键 / Shortcut | 功能 / Action |
|----------|--------|
| `Ctrl+N` | 新建会话 / New session |
| `Ctrl+Shift+N` | 切换对话/编程模式 / Toggle Chat/Code mode |
| `Ctrl+,` | 打开设置 / Open settings |
| `Enter` | 发送消息 / Send message |
| `Shift+Enter` | 输入框换行 / New line in input |
| `Esc` | 关闭弹窗/面板 / Close modal/panel |

### 界面与体验 / UI/UX
- **可调面板 / Resizable Panels**：侧边栏和右侧面板宽度可拖拽调整并持久化 / Sidebar and right panel widths are draggable and persisted
- **智能滚动 / Smart Auto-Scroll**：仅在用户位于底部时自动滚动，手动滚动时暂停 / Only auto-scrolls when user is at the bottom; respects manual scrolling
- **深色模式 / Dark Mode**：完整深色主题，对比度适当 / Full dark theme with proper contrast
- **国际化 / i18n**：中文和英文界面 / Chinese and English interface
- **配置加密 / Config Encryption**：API 密钥使用 AES-GCM 加密存储 / API keys encrypted at rest with AES-GCM
- **模型显示名 / Model Display Names**：配置名称通过 localStorage 持久化，显示 "Flash" 而非 "deepseek-chat" / Profile names persisted via localStorage; shows "Flash" instead of "deepseek-chat"

---

## 技术栈 / Tech Stack

| 层 / Layer | 技术 / Technology |
|-------|-----------|
| 前端 / Frontend | React 19, TypeScript, Vite |
| 桌面 / Desktop | Tauri v2 |
| 后端 / Backend | Rust, Tokio |
| Markdown | react-markdown, remark-gfm, remark-math, rehype-katex |
| 图表 / Diagrams | Mermaid |
| 代码高亮 / Code Highlight | react-syntax-highlighter |
| 图标 / Icons | Lucide React |
| HTTP | Reqwest (Rust), Tauri IPC |
| 加密 / Encryption | AES-256-GCM |

---

## 项目结构 / Project Structure

```
gxAgent/
├── src/                          # 前端 / Frontend (React + TypeScript)
│   ├── App.tsx                   # 主应用组件 / Main application component
│   ├── App.css                   # 全局样式 / Global styles
│   ├── types.ts                  # TypeScript 类型定义 / Type definitions
│   ├── rolePresets.ts            # 内置和自定义角色预设 / Built-in and custom role presets
│   ├── main.tsx                  # 入口 / Entry point
│   └── assets/                   # 静态资源 / Static assets
├── src-tauri/                    # 后端 / Backend (Rust + Tauri)
│   ├── src/
│   │   ├── lib.rs                # Tauri 命令与主逻辑 / Tauri commands & main logic
│   │   ├── agent.rs              # LLM Agent 与流式对话 / LLM agent & streaming chat
│   │   ├── config.rs             # 配置管理 / Configuration management
│   │   ├── crypto.rs             # AES-GCM 密钥加密 / AES-GCM encryption for API keys
│   │   ├── tools.rs              # 工具定义与执行 / Tool definitions & execution
│   │   ├── policy.rs             # 审批策略引擎 / Approval policy engine
│   │   └── mcp.rs                # MCP 服务器管理 / MCP server management
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── README.md
```

---

## 快速开始 / Getting Started

### 环境要求 / Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Tauri 环境依赖 / Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### 安装与运行 / Install & Run

```bash
# 安装前端依赖 / Install frontend dependencies
npm install

# 启动开发服务器 / Start development server
npm run tauri dev
```

### 构建 / Build

```bash
# 构建发布版本 / Build release executable
npm run tauri build
```

构建产物 / Output files:
- `src-tauri/target/release/gxAgent.exe` (独立可执行文件 / standalone executable)
- `src-tauri/target/release/bundle/msi/gxAgent_0.1.0_x64_en-US.msi` (MSI 安装包 / installer)
- `src-tauri/target/release/bundle/nsis/gxAgent_0.1.0_x64-setup.exe` (NSIS 安装包 / installer)

---

## 配置 / Configuration

配置文件存储路径 / Configuration is stored at:
- **Windows**: `%APPDATA%\gxAgent\config.json`
- **macOS**: `~/Library/Application Support/gxAgent/config.json`
- **Linux**: `~/.config/gxAgent/config.json`

API 密钥在写入磁盘前使用 AES-256-GCM 加密 / API keys are encrypted with AES-256-GCM before saving to disk.

---

## 许可证 / License

私有项目，保留所有权利 / Private project. All rights reserved.
