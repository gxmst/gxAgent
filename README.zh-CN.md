# gxAgent Studio

[![English](https://img.shields.io/badge/Language-English-blue)](./README.md)

基于 **Tauri v2, React 19, TypeScript 与 Rust** 构建的跨平台 AI Agent 桌面应用。专为日常智能对话与高效的 Agent 自动化编程工作流而设计，支持多会话管理与自定义工具集成。

---

## ✨ 功能特性

### 🤖 智能双模式
* **双模式切换**：
  * **对话模式**：适用于日常聊天、灵感碰撞与 Prompt 辅助。
  * **编程模式 (Agent)**：具备自主编码能力的 Agent，可在指定工作区中自动执行复杂的编码和修改任务。
* **运行时动态干预**：编程模式下，允许在 Agent 运行期间随时发送指令，实时干预和调整任务方向。
* **工作区规则加载**：自动扫描目标目录中的规则文件（如 `.gxagent.md`、`AGENTS.md` 或 `CLAUDE.md`），动态适配系统提示词。
* **Git 自动检查点**：在执行任何文件修改或命令行写入前，自动保存 Git 临时检查点，确保代码安全无损。

### 💬 丝滑交互与界面
* **卓越的渲染能力**：完整支持 GitHub GFM 渲染，集成代码语法高亮、数学公式 (KaTeX) 及 Mermaid 动态图表。
* **上下文截断线**：允许在会话指定位置插入截断线，忽略上方历史消息，大幅节省 Token 消耗。
* **极速响应流**：流畅的实时流式输出，带打字光标动画，保障对话体验。
* **精致 UI 体验**：左右双面板支持拖拽调整并持久化布局、智能滚动（手滚暂停/底滚跟随）、深浅色主题切换以及全键盘快捷键支持。

### ⚙️ 强劲功能与安全
* **多模型与供应商支持**：原生预设 DeepSeek、OpenAI、Gemini、Ollama，并支持任何 OpenAI 兼容的 API。
* **API 配置管理**：支持保存和一键切换多组 API Profile（包含接口地址、密钥、系统词、默认模型及参数等）。
* **快速模型选择**：在聊天输入框内即可快速切换当前会话所用的 LLM 模型。
* **本地数据加密**：敏感的 API 密钥与配置在写入磁盘前采用 AES-256-GCM 硬件级算法加密，保障凭据安全。
* **MCP 工具箱**：完整支持 Model Context Protocol (MCP) 服务器管理，轻松为 Agent 接入外部扩展工具。

---

## 🎹 键盘快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + N` | 新建会话 |
| `Ctrl + Shift + N` | 快速切换对话/编程模式 |
| `Ctrl + ,` | 打开设置面板 |
| `Enter` | 发送消息 |
| `Shift + Enter` | 输入框换行 |
| `Esc` | 关闭弹窗和活动面板 |

---

## 🛠️ 技术栈

| 层次 | 核心技术 |
| :--- | :--- |
| **前端 / Frontend** | React 19, TypeScript, Vite |
| **桌面壳 / Desktop** | Tauri v2 (Rust, Tokio) |
| **Markdown 渲染** | react-markdown, remark-gfm, remark-math, rehype-katex |
| **可视化与图标** | Mermaid, react-syntax-highlighter, Lucide Icons |
| **通信层** | Reqwest (Rust), Tauri IPC |
| **数据安全** | AES-256-GCM |

---

## 📂 项目结构

```
gxAgent/
├── src/                          # 前端代码 React + TypeScript
│   ├── App.tsx                   # 界面主布局与视图状态控制
│   ├── App.css                   # 全局样式与主题设计系统
│   ├── types.ts                  # 全局共享 TypeScript 类型定义
│   ├── rolePresets.ts            # 内置与自定义角色预设提示词
│   └── main.tsx                  # 前端入口文件
├── src-tauri/                    # 后端代码 Rust + Tauri Shell
│   ├── src/
│   │   ├── lib.rs                # 应用初始化与 Tauri 命令行句柄
│   │   ├── agent.rs              # LLM 客户端与流式 Agent 调度中心
│   │   ├── config.rs             # 应用 Profile 与配置文件管理器
│   │   ├── crypto.rs             # 基于 AES-GCM 的配置加密模块
│   │   ├── tools.rs              # Agent 核心工具集（文件读写、指令执行等）
│   │   ├── policy.rs             # 指令执行安全审批策略引擎
│   │   └── mcp.rs                # MCP 客户端协调器
│   ├── Cargo.toml                # Rust 依赖包管理
│   └── tauri.conf.json           # Tauri 打包与能力权限配置
└── package.json                  # 前端依赖包管理
```

---

## 🚀 快速开始

### 环境要求

运行本项目前，请确保您的系统中已安装以下环境：
* [Node.js](https://nodejs.org/) (v18 或更高版本)
* [Rust 与 Cargo](https://www.rust-lang.org/tools/install) (Stable 版本)
* 平台相关的 Tauri 依赖环境（参见 [Tauri 配置指南](https://v2.tauri.app/start/prerequisites/)）

### 安装与开发运行

1. 克隆本仓库并进入项目根目录。
2. 安装前端依赖：
   ```bash
   npm install
   ```
3. 启动开发服务器和 Tauri 壳：
   ```bash
   npm run tauri dev
   ```

### 生产构建

编译并生成高度优化的独立可执行安装包：
```bash
npm run tauri build
```

构建生成的产物将保存在以下目录：
* **独立可执行程序**：`src-tauri/target/release/gxAgent.exe`
* **MSI 安装包**：`src-tauri/target/release/bundle/msi/...`
* **NSIS 安装包**：`src-tauri/target/release/bundle/nsis/...`

---

## 🔒 配置文件与安全

应用的所有配置、API Profile 以及会话历史记录都安全地存储在系统默认的 App Data 目录中：
* **Windows**: `%APPDATA%\gxAgent\config.json`
* **macOS**: `~/Library/Application Support/gxAgent/config.json`
* **Linux**: `~/.config/gxAgent/config.json`

> [!WARNING]
> 本地 API 密钥在存入磁盘前均会通过与硬件关联的 AES-256-GCM 密钥进行高强度加密。如果您的配置文件中包含敏感 API 凭证，请勿向外部公开或共享此 `config.json` 文件。

---

## 📄 许可证

私有项目，保留所有权利。
