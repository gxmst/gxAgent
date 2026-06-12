# gxAgent Studio

[English](./README.md)

gxAgent Studio 是一个基于 Tauri v2、React 19、TypeScript 和 Rust 构建的跨平台桌面 AI Agent。它把日常对话、Agent 编程工作流、本地工具、联网搜索、多会话管理和 MCP 扩展能力放在同一个本地优先的应用里。

## 功能特性

### Agent 工作流

- 对话模式：适合日常聊天、头脑风暴、写作和 Prompt 辅助。
- 编程模式：面向工作区任务，支持文件读写、命令执行、Python 执行、网页搜索和 MCP 工具。
- 运行时干预：Agent 执行过程中可以继续发送高优先级指令来调整方向。
- 工作区规则自动加载：支持 `.gxagent.md`、`AGENTS.md`、`CLAUDE.md` 等规则文件。
- Git 自动检查点：在写文件或执行可能修改内容的命令前，为 Git 工作区创建临时检查点。

### 模型与供应商

- 内置 DeepSeek、OpenAI、Anthropic Claude、Google Gemini、Ollama 和 OpenAI 兼容接口预设。
- 请求格式与供应商预设解耦：可以独立选择 OpenAI、Anthropic、Gemini 或 Ollama 协议。
- 流式输出、工具调用和工具结果在内部统一成一致格式，便于跨供应商使用。
- API Profile 支持保存供应商、Base URL、模型、API Key 和请求格式，方便一键切换。
- 设置面板支持获取模型列表，输入栏支持快速切换当前会话模型。

### 安全与费用保护

- API Key 使用 AES-256-GCM 加密落盘，v3 密钥由本机信息和 Argon2 派生。
- 旧版 `enc:v1` / `enc:v2` 密钥在成功解密后会自动迁移并重存为 v3。
- 导入配置时，如果密钥无法在当前设备解密，会清空该密钥并提示用户重新输入。
- MCP 环境变量会拦截常见注入钩子，包括 `NODE_OPTIONS`、`PYTHONPATH`、`PYTHONHOME`、`RUBYOPT`、`PERL5OPT`、`BASH_ENV`、`ENV` 和 `GIT_CONFIG_*`。
- `PATH` 和 proxy 环境变量不会一刀切禁用，避免破坏企业代理和本地 MCP 运行环境。
- Agent 资源预算可配置：
  - `max_agent_loops` 默认 `10`，硬上限 `20`。
  - `max_tool_calls_per_request` 默认 `30`，硬上限 `100`。
- 普通工具失败、搜索失败和预算触顶会作为观察结果返回给模型，由模型决定恢复、总结或请求用户继续。
- 用户取消、审批拒绝、安全策略阻断和 API 协议错误仍会作为明确停止条件处理。

### 界面体验

- 支持 GitHub Flavored Markdown、语法高亮、KaTeX 数学公式和 Mermaid 图表。
- 支持流式输出；模型提供推理内容时会单独展示。
- 支持上下文截断线和历史压缩，降低上下文占用。
- 内置浅色、深色、柚木书房、炭火终端、午夜葡萄、暮光琥珀六套主题。
- 支持可拖拽布局、智能滚动、会话搜索、角色预设和快捷键。
- 密钥输入框默认隐藏，并提供显隐切换按钮。

## 快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + N` | 新建会话 |
| `Ctrl + Shift + N` | 切换对话 / 编程模式 |
| `Ctrl + ,` | 打开设置 |
| `Enter` | 发送消息 |
| `Shift + Enter` | 输入换行 |
| `Esc` | 关闭弹窗和当前面板 |

## 技术栈

| 层级 | 技术 |
| :--- | :--- |
| 前端 | React 19、TypeScript、Vite |
| 桌面壳 | Tauri v2、Rust、Tokio |
| LLM 通信 | Reqwest、OpenAI / Anthropic / Gemini / Ollama 请求适配层 |
| 渲染 | react-markdown、remark-gfm、remark-math、rehype-katex、Mermaid |
| 安全 | AES-256-GCM、Argon2、审批策略、MCP 环境变量校验 |

## 项目结构

```text
gxAgent/
|-- src/                         # 前端 React + TypeScript
|   |-- App.tsx                  # 主界面和视图状态
|   |-- App.css                  # 全局样式与主题变量
|   |-- types.ts                 # 共享类型定义
|   |-- rolePresets.ts           # 内置角色预设
|   `-- main.tsx                 # 前端入口
|-- src-tauri/                   # Rust 后端与 Tauri 壳
|   |-- src/
|   |   |-- lib.rs               # Tauri 命令与应用启动
|   |   |-- agent.rs             # Agent 循环、工具和流式调度
|   |   |-- provider.rs          # 请求格式适配层
|   |   |-- config.rs            # 配置和默认值
|   |   |-- crypto.rs            # API Key 加密与迁移
|   |   |-- tools.rs             # 内置工具实现
|   |   |-- policy.rs            # 审批与命令策略
|   |   `-- mcp.rs               # MCP 服务管理
|   |-- Cargo.toml
|   `-- tauri.conf.json
|-- package.json
`-- README.md
```

## 快速开始

### 环境要求

- Node.js 18 或更高版本
- Rust 和 Cargo stable
- 参考 [Tauri 环境准备文档](https://v2.tauri.app/start/prerequisites/) 安装平台相关依赖

### 开发运行

```bash
npm install
npm run tauri dev
```

### 验证

```bash
npm run build
cd src-tauri
cargo check
cargo test
```

### 生产构建

```bash
npm run tauri build
```

构建产物会生成在 `src-tauri/target/release/` 和 `src-tauri/target/release/bundle/` 下。

## 配置与安全

配置和 API Profile 存储在系统标准应用配置目录：

- Windows：`%APPDATA%\gxAgent\config.json`
- macOS：`~/Library/Application Support/gxAgent/config.json`
- Linux：`~/.config/gxAgent/config.json`

API Key 会在写入磁盘前加密。即使如此，如果 `config.json` 中包含有效凭据，也不要把它公开或分享给其他人。

## 许可证

私有项目，保留所有权利。
