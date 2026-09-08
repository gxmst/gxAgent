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

## 工作台与编码引擎

统一侧栏按项目组织任务，并同时保留独立聊天。顶部 Chat / Work 切换当前会话的模式，草稿和文件视图分别保存在各自任务中。右侧工作区按需打开，包含改动、文件、运行、上下文和预览；Git 仓库还可按本轮检查点审查和恢复改动。

在**设置 > 连接与模型**选择默认编码引擎，Work 会话也可以通过回复选项或会话设置单独选择。Chat 继续使用 gxAgent 的模型供应商配置。

- **gxAgent**：保留原有多供应商模型、本地工具、工具开关、信任规则、资源预算和手动历史压缩。
- **Codex**：通过官方 [app-server 协议](https://developers.openai.com/codex/app-server)启动本机安装的 Codex CLI。先安装并登录 CLI，再点击“检查 Codex 连接”。检查只读取登录状态和模型目录，不启动模型任务。Windows 支持发现标准 npm 安装，自定义路径需指向原生可执行文件。

Codex 接入支持线程续接、文本与图片输入、推理内容、工具活动、命令和文件审批、提问、运行中补充要求及停止。编辑、重试或隔离历史后，会携带可见上下文新建线程；选中 HTML 或 SVG 文件可打开预览。规划模式始终使用只读沙箱，普通工作使用工作区写权限和按需审批，严格策略对应 Codex 的 untrusted。显式启用“信任所有操作”后，Codex 会获得完整访问权限并关闭操作审批。

Codex 使用自己的登录、工具、上下文管理与 CLI 配置，并读取项目规则。gxAgent 的供应商采样参数、原生工具开关（联网搜索除外）、信任规则和循环/工具预算不约束 Codex；应用中配置的 MCP 服务会作为 Codex 配置覆盖项传入。当前手动 `/compact` 仅适用于 gxAgent 引擎，尚未支持的 Codex 服务端交互会明确报错。本接入不包含 Codex 桌面产品的全部功能。

## 保存恢复与学习工具

| 功能 | 入口与行为 |
| :--- | :--- |
| 保存与恢复 | 流式输出期间每 5 秒尝试保存；设置 > 数据管理支持手动快照、恢复副本和损坏会话修复。异常退出的运行标记为中断，工具不会自动重放。 |
| MCP 调试 | 设置 > 工具与 MCP 可读取工具列表和 JSON Schema、提交 JSON 参数，并查看完整结果、错误与耗时。支持本地 stdio 服务。 |
| 上下文检查 | 回答下方“查看上下文”或右侧上下文页查看消息、工具定义、启用技能和检索片段，可导出 JSON。Codex 引擎显示应用交给 CLI 的输入。 |
| Skill 管理 | 设置 > 技能扫描 `SKILL.md`，支持全局与项目目录、显式启用、MCP 依赖检查和参考文件查看；会话设置可覆盖全局选择。 |
| 本地知识库 | 设置 > 知识库导入文档、调整分块和 Top K、调试检索、维护固定问题和评测记录；启用后回答附带可展开的出处。 |

知识库基于 SQLite FTS5 / BM25，支持中文二元切词。索引和检索在本地完成，命中片段会随回答请求发送给所选模型。目前未接入向量 Embedding、重排或 OCR；评测衡量检索命中率与排序，不等同于回答质量评测。PDF 需要 PATH 中的 `pdftotext`，Office 文本提取目前仅支持 Windows。

使用步骤、Skill 示例、数据位置和恢复边界见[学习与调试指南](docs/learning-lab.zh-CN.md)。

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
| 知识库与技能 | SQLite FTS5 / BM25、YAML Skill 元数据、JSON Schema 校验 |
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

- Node.js 22.12 或更高版本
- Rust 和 Cargo stable
- 参考 [Tauri 环境准备文档](https://v2.tauri.app/start/prerequisites/) 安装平台相关依赖

### 开发运行

```bash
npm install
npm run tauri dev
```

### 验证

```bash
npm test
npm run test:ui
npm run build
cd src-tauri
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
```

浏览器测试使用隔离的 Tauri 模拟环境，不执行真实模型任务；每次启动独立的 Vite 测试服务，默认端口 `1421`，可用 `PLAYWRIGHT_PORT` 修改。Windows 默认使用 Edge，可用 `PLAYWRIGHT_CHANNEL` 选择其他已安装的浏览器。Rust 测试覆盖真实 stdio MCP 子进程、本地 SQLite 检索与评测、临时目录中的快照恢复。截图为 `.shots/workbench/` 下的临时检查结果。`npm run build` 生成的是 `dist/` 前端资源，不是桌面可执行文件。

### 生产构建

```bash
npm run tauri build
```

Cargo 默认在 `src-tauri/target/release/` 和 `src-tauri/target/release/bundle/` 生成程序和安装包；配置 `CARGO_TARGET_DIR` 后根目录随之改变。共享 Cargo target 始终属于可丢弃的构建缓存，普通开发构建不会创建持久交付归档。

Windows 下，`npm run build:desktop` 完整构建程序与 MSI/NSIS 安装包，并报告实际输出位置。`npm run build:archive` 还会将最终程序、安装包与完整第三方许可复制到 `../_build_artifacts/<project>/<timestamp>-<commit>[-dirty]/`，验证 SHA-256 并生成构建清单。可用 `GXAGENT_ARTIFACTS_DIR` 覆盖归档根目录；`LATEST.txt` 只保存相对归档目录名。归档不包含编译缓存或用户数据。程序需要 WebView2，数据保存在正常 Windows 用户目录，不属于便携数据包。本地未签名构建不等于公开发行版。

## 配置与安全

配置和 API Profile 存储在系统标准应用配置目录：

- Windows：`%APPDATA%\gxAgent\config.json`
- macOS：`~/Library/Application Support/gxAgent/config.json`
- Linux：`~/.config/gxAgent/config.json`

API Key 会在写入磁盘前加密。即使如此，如果 `config.json` 中包含有效凭据，也不要把它公开或分享给其他人。

## 许可证

私有项目，保留所有权利。
