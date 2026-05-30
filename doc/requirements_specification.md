# gxAgent 产品需求说明书 (PRD)

---

## 1. 项目概述

**gxAgent** 是一款本地优先的通用 AI Agent 桌面应用。它将大语言模型的对话能力与本地工具执行能力结合，让用户通过自然语言即可完成文件操作、命令执行、代码运行、信息检索等实际任务。

**设计灵感来源**：
- **OpenAI Codex Playground** — 左聊天、右工作区的双栏分屏交互范式
- **Claude Code** — Agent 自主调用本地工具、多轮执行直到任务完成的自主性
- **gxShell**（自有项目）— AI 对话 + 工具确认 + 多 Provider 兼容的成熟实践

**技术选型**：Tauri v2 + Rust + React，追求轻量、原生性能与低资源占用。

---

## 2. 核心定位

gxAgent 是一个**通用 AI 助手**，核心价值在于：

1. **对话即执行** — 用户用自然语言描述需求，Agent 自主规划、调用工具、逐步完成，无需手动操作
2. **聊天与工具调用兼顾** — 既能像 ChatGPT 一样自由对话，也能像 Claude Code 一样自主执行本地任务
3. **安全可控** — 工具执行有分级授权机制，用户始终掌握最终决定权
4. **界面前卫** — 参照 Codex Playground 的双栏布局，暗色主题，科技感强

---

## 3. 功能需求

### 3.1 LLM 接入与模型管理

#### 3.1.1 多 Provider 支持

支持三种接入方式，覆盖主流使用场景：

| Provider | 端点格式 | 认证方式 | 适用场景 |
|----------|---------|---------|---------|
| OpenAI Compatible | `{base_url}/chat/completions` | Bearer Token | DeepSeek、OpenAI、各种代理 |
| Ollama | `{base_url}/api/chat` | 无需 Key | 本地离线模型 |
| Custom | 用户自定义 | 用户自定义 | 特殊兼容需求 |

> **参考**：gxShell 的 `ai.Manager` 已实现 OpenAI SSE 和 Ollama 流式两种解析，且支持 `ListModels` 自动拉取模型列表。

#### 3.1.2 配置项

- **必填**：Provider 类型、Base URL、Model Name
- **条件必填**：API Key（Ollama 模式下可选）
- **可选**：
  - Temperature（0.0 - 2.0，默认 0.7）
  - Max Tokens（默认跟随模型限制）
  - System Prompt（自定义 Agent 人设与行为指令）
  - 流式输出开关（默认开启）

#### 3.1.3 模型列表自动发现

- OpenAI Compatible：调用 `{base_url}/models` 拉取可用模型列表
- Ollama：调用 `{base_url}/api/tags` 拉取本地模型列表
- 用户可从下拉列表选择，也可手动输入模型名

#### 3.1.4 配置预设

提供常见服务的快捷预设，一键填充配置：

| 预设名 | Base URL | 默认模型 |
|--------|----------|---------|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Ollama Local | `http://localhost:11434` | （自动发现） |

用户可自定义添加预设。

---

### 3.2 对话系统

#### 3.2.1 会话管理

- **多会话**：支持创建、切换、删除、重命名会话
- **会话持久化**：会话历史自动保存，重启应用后恢复
- **会话标题**：根据用户首条消息自动生成，可手动修改
- **会话容量限制**：单会话消息内容超过阈值时自动截断存储（保留结构，截断超长内容）

#### 3.2.2 消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| 用户消息 | user | 用户输入的文本 |
| AI 回复 | assistant | AI 的文本回复（支持 Markdown） |
| AI 推理 | assistant | AI 的思维链/推理内容（如 DeepSeek-R1 的 reasoning_content），折叠展示 |
| 工具调用 | assistant | AI 请求执行的工具调用，渲染为状态卡片 |
| 工具结果 | tool | 工具执行后的输出，附属于对应的工具调用卡片 |

#### 3.2.3 流式输出

- AI 回复以 SSE 流式逐字渲染，打字机效果
- 工具调用的参数也以流式增量方式展示（参考 Codex 的 `agent-tool-drafting` 事件）
- 推理内容（reasoning_content）独立流式渲染，折叠展示

#### 3.2.4 上下文管理

- **Token 计数**：实时跟踪当前会话的 prompt tokens 和 completion tokens
- **上下文裁剪**：当历史消息接近模型 context window 上限时，自动对较早消息进行摘要或截断
- **Token 用量统计**：累计展示总用量，支持重置

> **参考**：Codex 的 `compact` 模块实现了完整的上下文压缩策略；gxShell 的 `TokenUsage` 结构跟踪了累计用量。

---

### 3.3 工具系统

#### 3.3.1 内置工具定义

Agent 具备以下内置工具，通过 OpenAI Function Calling 协议声明和调用：

**1. `execute_command` — 命令执行器**

```json
{
  "name": "execute_command",
  "description": "Execute a shell command on the local machine and return stdout/stderr. Use this to run scripts, install packages, manage files, or diagnose system issues.",
  "parameters": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "The shell command to execute" }
    },
    "required": ["command"]
  }
}
```

- 在 Windows 上通过 `powershell -NoProfile -Command` 执行
- 返回 stdout + stderr 合并输出
- 设置执行超时（默认 30 秒），超时则终止进程

**2. `read_file` — 文件读取**

```json
{
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
```

- 支持绝对路径和相对路径（相对于当前工作目录）
- 大文件自动截断（超过 100KB 只返回前 100KB + 截断提示）

**3. `write_file` — 文件写入**

```json
{
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
```

- 自动创建父目录
- 写入前需经过安全审查（见 3.4）

**4. `list_dir` — 目录浏览**

```json
{
  "name": "list_dir",
  "description": "List files and subdirectories in a local directory. Returns names with type indicators (file/dir).",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Directory path to list. Defaults to current working directory." }
    }
  }
}
```

**5. `run_python` — Python 代码执行**

```json
{
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
```

- 代码写入系统临时目录的 `.py` 文件后执行
- 执行完毕后清理临时文件
- 设置执行超时（默认 30 秒）

**6. `web_search` — 网页搜索**

```json
{
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
```

- 通过 DuckDuckGo HTML 接口爬取，无需 API Key
- 返回最多 5 条结果（标题 + 链接 + 摘要）
- 网络异常时返回友好错误提示

#### 3.3.2 工具启用控制

- 用户可在设置中独立启用/禁用每个工具
- 禁用的工具不会发送给 LLM（不出现在 `tools` 参数中）
- 默认启用：`execute_command`、`read_file`、`write_file`、`list_dir`
- 默认禁用：`run_python`、`web_search`

#### 3.3.3 Agent 循环

Agent 采用多轮工具调用循环，直到任务完成：

```
用户输入 → LLM 推理 → [返回文本回复] → 结束
                   → [请求工具调用] → 安全审查 → 执行工具 → 结果回传 LLM → 继续推理
```

- 最大循环次数：15 轮（防止无限循环）
- 每轮工具调用的结果都追加到消息历史中，供 LLM 下一轮推理使用
- LLM 返回纯文本回复（无工具调用）时，循环结束

> **参考**：Codex 的 `CodexThread` 实现了完整的 Agent 循环；gxShell 的 `AiContinueChat` 实现了工具执行后自动继续对话。

---

### 3.4 安全与权限系统

#### 3.4.1 分级授权策略

参考 Codex 的 `AskForApproval` 枚举和 gxShell 的工具确认实践，设计三级授权：

| 级别 | 行为 | 适用工具 |
|------|------|---------|
| **自动通过** | 无需用户确认，静默执行 | `read_file`、`list_dir`、`web_search` |
| **需确认** | 前端展示工具调用详情，用户点击"执行"后才运行 | `write_file`、`execute_command`、`run_python` |
| **直接拒绝** | 不进入确认流程，直接拒绝并告知 Agent | 高危命令（见 3.4.2） |

#### 3.4.2 高危命令黑名单

以下命令模式直接拦截，不进入确认流程：

**PowerShell 高危模式**：
- `Format-Volume`、`Remove-Partition` — 磁盘格式化
- `del C:\Windows`、`Remove-Item C:\Windows` — 系统目录删除
- `del C:\Program Files`、`Remove-Item "C:\Program Files"` — 程序目录删除
- `net user * /delete` — 批量删除用户
- `Set-ExecutionPolicy Unrestricted` — 降低安全策略
- 任何包含 `| Invoke-Expression` 或 `| iex` 的远程下载执行链

**通用高危模式**：
- `rm -rf /`、`rm -rf C:\` — 递归删除根目录
- `curl ... | sh`、`wget ... | bash` — 远程脚本直接执行
- 包含已知恶意域名或 IP 的网络请求

#### 3.4.3 信任记忆机制

用户确认执行过的工具调用，系统记录其"签名"（工具名 + 参数模式），后续相同模式的调用可自动通过：

- **命令模式信任**：用户确认过 `npm install`，后续 `npm install xxx` 自动通过
- **路径模式信任**：用户确认过写入 `./src/` 目录，后续写入同目录自动通过
- **信任管理**：设置面板中可查看和清除已信任的模式
- **信任范围**：默认会话级有效（重启应用后清除）；用户可在设置中开启"持久化信任"，跨会话保留

> **参考**：Codex 的 `PermissionProfile` 和 `exec_policy` 实现了基于规则的持久化授权；你的需求是简化版——类似"已确认过的同类操作不再提醒"。

#### 3.4.4 确认交互流程

```
Agent 请求工具调用
  → 后端判断安全级别
    → 自动通过：直接执行，结果广播给前端
    → 需确认：将工具调用详情广播给前端
      → 前端渲染确认卡片（展示工具名、参数摘要）
        → 用户点击"执行"：前端通知后端执行
        → 用户点击"拒绝"：前端通知后端跳过，Agent 收到"用户拒绝"提示
    → 直接拒绝：后端直接返回拒绝信息给 Agent
```

---

### 3.5 工作区与可视化

#### 3.5.1 双栏分屏布局

主界面采用左右双栏布局，可拖拽调整比例：

```
+------------------------------------------------------+
|  gxAgent   [会话列表] [设置] [工具开关]               |
+---------------------------+--------------------------+
|                           |                          |
|  左侧：对话面板            |  右侧：工作区面板         |
|                           |                          |
|  · AI 对话消息流           |  · 预览画布 (Preview)     |
|  · 工具调用状态卡片        |  · 文件变更视图           |
|  · 安全确认卡片            |  · 终端输出视图           |
|  · 推理内容（折叠）        |                          |
|                           |                          |
|  +---------------------+ |                          |
|  | 输入框               | |                          |
|  +---------------------+ |                          |
+---------------------------+--------------------------+
```

#### 3.5.2 左侧对话面板

**消息渲染**：
- 用户消息：右对齐，简洁气泡
- AI 回复：左对齐，Markdown 渲染（代码高亮、表格、列表）
- 推理内容：折叠展示，点击展开，使用次要色调区分

**工具调用卡片**：
- 折叠态：显示工具图标 + 工具名 + 参数摘要 + 状态指示（等待/执行中/完成/失败）
- 展开态：显示完整参数 + 执行输出
- 确认态：显示"执行"和"拒绝"按钮（仅需确认的工具）
- 状态指示：绿色 = 完成，红色 = 失败，黄色 = 执行中，灰色 = 等待确认

#### 3.5.3 右侧工作区面板

右侧面板通过 Tab 切换不同视图，默认展示预览画布：

**Tab 1 — 预览 (Preview)** ⭐ 默认 Tab
- 内嵌 Iframe 画布，当 Agent 生成 HTML/CSS/JS 代码时自动注入预览
- 支持实时刷新：Agent 修改文件后自动重新渲染
- 沙箱隔离（sandbox 属性限制脚本权限）
- 支持响应式预览：切换桌面/平板/手机视口宽度
- 当 Agent 写入 `.html` 文件时，自动检测并在预览中加载
- 无预览内容时展示空状态引导

**Tab 2 — 文件 (Files)**
- 展示当前工作目录的文件树
- 高亮标记 Agent 本次会话中创建/修改的文件
- 点击文件可在对话中查看内容

**Tab 3 — 终端 (Terminal)**
- 展示 `execute_command` 和 `run_python` 的实时输出
- 支持 ANSI 颜色渲染
- 命令和输出分区展示

#### 3.5.4 工作目录

- 启动时默认使用用户主目录
- 支持在设置中指定默认工作目录
- Agent 执行命令和文件操作时基于当前工作目录

---

### 3.6 设置系统

#### 3.6.1 设置面板

设置以侧边抽屉或模态框形式展示，包含以下分组：

**模型配置**：
- Provider 选择（OpenAI Compatible / Ollama / Custom）
- Base URL、API Key、Model Name
- 快捷预设按钮
- 模型列表刷新
- Temperature、Max Tokens
- System Prompt 编辑器（多行文本框）

**工具管理**：
- 各工具的启用/禁用开关
- 工具执行超时设置
- 高危命令黑名单查看

**权限管理**：
- 当前会话的信任模式列表
- 清除信任记录
- 授权策略选择（严格模式 / 标准模式 / 宽松模式）

| 策略 | 自动通过 | 需确认 | 说明 |
|------|---------|--------|------|
| 严格 | 仅 `read_file`、`list_dir` | 其他全部 | 首次使用推荐 |
| 标准 | `read_file`、`list_dir`、`web_search` | `write_file`、`execute_command`、`run_python` | 默认策略 |
| 宽松 | 全部已信任的操作 | 仅未信任的写操作 | 信任记忆生效后 |

**外观**：
- 主题（暗色/亮色，默认暗色）
- 字体大小
- 双栏比例

**数据**：
- 会话存储位置
- 清除所有会话
- 导出/导入配置

#### 3.6.2 配置持久化

- 用户配置（API Key 加密存储）、会话历史、信任记录持久化到本地
- 初期使用 localStorage + Tauri Store
- 后期可迁移至 SQLite

---

## 4. 视觉设计

### 4.1 设计原则

- **暗色为主**：深色背景降低视觉疲劳，契合开发者审美
- **信息密度适中**：不过度留白，也不过度堆砌
- **状态可感知**：工具调用的等待/执行/完成状态一目了然
- **参考 Codex Playground**：科技感暗色主题，简洁的卡片式布局

### 4.2 配色方案

| 用途 | 色值 | 说明 |
|------|------|------|
| 主背景 | `#0B0F19` | 深夜黑 |
| 卡片背景 | `rgba(15, 23, 42, 0.65)` | 半透明深蓝 |
| 边框 | `rgba(255, 255, 255, 0.08)` | 微光边框 |
| 主强调色 | `#00F5D4` | 极光绿，用于成功状态、执行按钮 |
| 警告色 | `#FF007F` | 荧光粉，用于安全确认、高危拦截 |
| 文字主色 | `#E2E8F0` | 浅灰白 |
| 文字次色 | `#94A3B8` | 中灰，用于次要信息 |
| 代码背景 | `rgba(0, 0, 0, 0.3)` | 深黑半透明 |

### 4.3 玻璃拟态

卡片和弹窗使用磨砂玻璃质感：

```css
background: rgba(15, 23, 42, 0.65);
backdrop-filter: blur(16px);
border: 1px solid rgba(255, 255, 255, 0.08);
border-radius: 12px;
```

### 4.4 动效

- **打字机效果**：AI 回复流式渲染，字符平滑出现
- **卡片展开/折叠**：高度过渡动画
- **按钮悬浮**：微发光 + 轻微缩放
- **状态切换**：颜色渐变过渡

---

## 5. 技术架构

### 5.1 整体架构

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (React)                    │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 对话面板  │  │ 工作区   │  │ 设置面板          │  │
│  │ ChatPanel│  │ Workspace│  │ SettingsPanel     │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       │              │                  │             │
│  ┌────┴──────────────┴──────────────────┴──────────┐  │
│  │              Tauri Bridge (IPC)                  │  │
│  └────────────────────┬────────────────────────────┘  │
└───────────────────────┼──────────────────────────────┘
                        │
┌───────────────────────┼──────────────────────────────┐
│                   Backend (Rust)                      │
│  ┌────────────────────┴────────────────────────────┐  │
│  │              Command Router (lib.rs)             │  │
│  └──┬──────────┬──────────┬──────────┬─────────────┘  │
│     │          │          │          │                  │
│  ┌──┴───┐  ┌──┴───┐  ┌──┴───┐  ┌──┴──────┐          │
│  │Agent │  │Tools │  │Config│  │Security │          │
│  │Engine│  │Exec  │  │Store │  │Policy   │          │
│  └──────┘  └──────┘  └──────┘  └─────────┘          │
└──────────────────────────────────────────────────────┘
```

### 5.2 模块职责

**Frontend（React + TypeScript）**：
- 对话面板：消息渲染、流式显示、工具卡片、确认交互
- 工作区面板：终端输出、文件树、网页预览
- 设置面板：模型配置、工具管理、权限管理
- 状态管理：会话列表、当前会话、流式状态

**Backend（Rust）**：
- **Command Router**（`lib.rs`）：接收前端 Tauri Command，分发到对应模块
- **Agent Engine**（`agent.rs`）：管理 LLM API 连接、SSE 流解析、Agent 循环
- **Tools Executor**（`tools.rs`）：各工具的具体执行逻辑
- **Config Store**（`config.rs`）：配置的读写与持久化
- **Security Policy**（`policy.rs`）：安全审查、高危检测、信任管理

### 5.3 通信协议

前后端通过 Tauri 的 Command + Event 双向通信：

**前端 → 后端（Tauri Command）**：
| Command | 说明 |
|---------|------|
| `start_session` | 启动新会话，发送用户消息 |
| `continue_session` | 工具执行后继续对话 |
| `approve_tool` | 用户确认执行工具 |
| `reject_tool` | 用户拒绝执行工具 |
| `get_config` | 获取当前配置 |
| `save_config` | 保存配置 |
| `list_models` | 拉取可用模型列表 |
| `list_sessions` | 获取会话列表 |
| `delete_session` | 删除会话 |

**后端 → 前端（Tauri Event）**：
| Event | 说明 |
|-------|------|
| `agent:stream-chunk` | AI 回复的文本片段 |
| `agent:reasoning-chunk` | AI 推理内容片段 |
| `agent:tool-drafting` | 工具调用参数的增量更新 |
| `agent:tool-confirm` | 需要用户确认的工具调用 |
| `agent:tool-executing` | 工具开始执行 |
| `agent:tool-output` | 工具执行结果 |
| `agent:complete` | Agent 循环结束 |
| `agent:error` | 发生错误 |

### 5.4 Agent 循环详细流程

```
1. 用户发送消息
2. 前端调用 start_session，传入消息和配置
3. 后端构建 messages 数组，发送到 LLM API（SSE 流式）
4. 解析 SSE 流：
   a. 文本片段 → emit agent:stream-chunk
   b. 推理片段 → emit agent:reasoning-chunk
   c. 工具调用片段 → 累积参数，emit agent:tool-drafting
5. 流结束后判断：
   a. 无工具调用 → emit agent:complete，结束
   b. 有工具调用 → 进入步骤 6
6. 对每个工具调用：
   a. 安全审查（高危检测）
      - 高危 → 直接拒绝，结果回传 LLM，跳到步骤 3
      - 需确认 → emit agent:tool-confirm，等待前端响应
      - 自动通过 → 直接执行
   b. 前端确认后（或自动通过）：
      - emit agent:tool-executing
      - 执行工具
      - emit agent:tool-output
   c. 前端拒绝：
      - 将"用户拒绝"作为工具结果回传 LLM
7. 将工具结果追加到 messages，跳到步骤 3（继续 Agent 循环）
8. 循环超过最大次数 → emit agent:error，终止
```

### 5.5 SSE 流解析

支持两种流式格式：

**OpenAI SSE 格式**：
```
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}
data: [DONE]
```

**Ollama JSON Lines 格式**：
```
{"message":{"content":"Hello"},"done":false}
{"message":{"content":" world"},"done":false}
{"done":true,"eval_count":42,"prompt_eval_count":128}
```

> **参考**：gxShell 的 `parseSSE` 和 `parseOllamaStream` 已完整实现两种格式的解析，包括工具调用的增量累积。

---

## 6. 数据模型

### 6.1 核心类型

```typescript
// 会话
interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

// 消息
interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoningContent?: string;      // 推理内容
  toolCalls?: ToolCall[];         // AI 请求的工具调用
  toolCallId?: string;            // 工具结果消息的关联 ID
}

// 工具调用
interface ToolCall {
  id: string;
  name: string;
  arguments: string;              // JSON 字符串
}

// 工具执行状态（前端展示用）
interface ToolAction {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  status: "pending" | "confirming" | "executing" | "done" | "error" | "rejected";
  output?: string;
  requiresApproval: boolean;
}

// 配置
interface AppConfig {
  provider: "openai" | "ollama" | "custom";
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  systemPrompt: string;
  streaming: boolean;
  toolsEnabled: string[];
  approvalPolicy: "strict" | "standard" | "relaxed";
  trustedPatterns: TrustedPattern[];
  defaultWorkDir: string;
}

// 信任模式
interface TrustedPattern {
  toolName: string;
  pattern: string;        // glob 或正则
  createdAt: number;
}
```

---

## 7. 非功能性需求

### 7.1 性能
- 冷启动时间 < 2 秒
- 流式输出首字延迟 < 500ms（取决于 API 响应）
- 内存占用 < 200MB（典型使用场景）
- 安装包体积 < 20MB

### 7.2 安全
- API Key 加密存储（使用系统密钥链或 AES 加密）
- 工具执行在独立子进程中运行，不影响主进程
- 高危命令强制拦截，不可绕过
- Iframe 预览使用 sandbox 属性隔离

### 7.3 兼容性
- Windows 10/11 为首要支持平台
- 后续考虑 macOS 支持
- WebView 依赖系统内置（Tauri v2 策略）

### 7.4 可靠性
- 工具执行超时自动终止，防止僵尸进程
- API 请求失败时展示友好错误信息，支持重试
- 会话数据自动保存，异常退出后可恢复

---

## 8. 路线图

### v1.0 — 核心可用
- OpenAI Compatible + Ollama 双 Provider 支持
- 6 个内置工具完整实现
- 分级授权 + 高危拦截 + 信任记忆（默认会话级，可选持久化）
- 双栏分屏 UI（对话 + 工作区）
- 右侧预览画布（Iframe 实时预览 HTML/CSS/JS）
- 会话持久化与多会话管理
- 流式输出 + 工具调用卡片 + 内嵌确认卡片

### v2.0 — 体验增强
- MCP（Model Context Protocol）工具扩展支持
- 上下文智能压缩（参考 Codex 的 compact 策略）
- 工具调用结果的可视化增强（图表渲染、diff 展示）
- 预览画布增强（多页面路由、控制台面板、网络请求监控）
- 多主题支持
- 快捷键体系

### v3.0 — 生态扩展
- 插件/技能系统（参考 Codex Skills）
- 自定义工具注册（用户定义的 Function Calling 工具）
- Docker 沙箱执行环境
- 多 Agent 协作
- 企业安全合规策略
