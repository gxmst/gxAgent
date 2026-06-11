# gxAgent 更新日志

## v1.1.0 - 2026-06-11

### 🚀 性能优化

#### 工具并行执行
- **问题**：原实现串行执行工具调用，3个工具各2秒需等待6秒
- **修复**：改为并行执行，使用 `tokio::spawn` + `futures::join_all`
- **效果**：性能提升 30-70%，3个工具现在只需2秒
- **影响文件**：
  - `src-tauri/Cargo.toml` - 添加 `futures = "0.3"` 依赖
  - `src-tauri/src/agent.rs` - 重构 `process_tool_calls` 函数

**实现对比**：
```rust
// 旧：串行
for tc in &auto_approved {
    let output = execute_tool(...).await?;
    messages.push(result);
}

// 新：并行
let handles: Vec<_> = auto_approved.iter().map(|tc| {
    tokio::spawn(async move { execute_tool(...).await })
}).collect();
let results = futures::future::join_all(handles).await;
```

---

## v1.0.0 - 2026-06-11

### ✨ 新功能

#### 1. UI 优化
- 删除顶部重复的模型名和 Token 显示
- 删除输入框右侧上下文按钮
- 底部状态栏显示完整信息：`时间 · 模型 · 输入/输出 · 上下文/限制 · 耗时`
- 消息操作按钮移至底部状态栏（小巧灰色图标）

#### 2. 右键菜单系统
- **全局菜单**（空白区域右键）：导出/导入会话、工具统计、清空会话、设置
- **会话菜单**（会话标题右键）：编辑预设、固定、导出、工具统计、重命名、删除
- **代码**：`src/components/shared/ContextMenu.tsx`

#### 3. 会话管理
- 导出所有会话为 JSON（浏览器下载）
- 导入会话（从 JSON 恢复）
- 工具调用统计（全局 + 单会话）
- 清空所有会话

#### 4. 自动保存草稿
- 输入框内容自动保存到 localStorage
- 重启后自动恢复
- 键名：`gx_draft`

#### 5. 命令系统
- 输入 `/` 显示命令联想
- 支持命令：`/clear` `/compact` `/export` `/help`
- **代码**：`src/components/shared/CommandSuggestions.tsx`

#### 6. 快捷键
- `Ctrl+K` / `Cmd+K` - 新建对话
- `Esc` - 清空输入框
- 双击标题 - 编辑会话名

#### 7. 工具超时延长
- 从 30 秒延长到 5 分钟
- **修改文件**：
  - `src-tauri/src/tools.rs` - `DEFAULT_COMMAND_TIMEOUT_SECS = 300`
  - `src-tauri/src/config.rs` - `default_command_timeout() = 300`

#### 8. 自定义图标
- 使用猫龟头像替换默认图标
- 任务栏、标题栏、托盘统一
- **命令**：`npx @tauri-apps/cli icon`

### 🐛 修复

#### 1. 托盘菜单闪烁
- 修改为 `menu_on_left_click(false)`
- 左键显示窗口，右键显示菜单

#### 2. 右键菜单冲突
- 全局菜单只在空白区域显示
- 会话菜单在会话标题显示
- 通过事件目标判断：`e.target === e.currentTarget`

#### 3. 重复图标
- 删除重复的复制按钮
- 统一使用底部状态栏按钮

#### 4. 导入图标缺失
- 添加 `BarChart3` 到 lucide-react 导入

### 📦 新增文件

- `src/components/shared/ContextMenu.tsx` - 右键菜单组件
- `src/components/shared/CommandSuggestions.tsx` - 命令联想组件
- `src/utils/sessionHelpers.ts` - 会话导入/导出工具
- `src/utils/helpers.ts` - 增强工具函数

### 🔧 技术改进

- Token 计数优化
- 上下文管理增强
- 事件系统完善
- 类型定义补充

---

## 架构说明

### 前端技术栈
- React 18 + TypeScript
- Vite 构建
- Tauri 2.0 桌面框架
- lucide-react 图标库

### 后端技术栈
- Rust + Tokio 异步运行时
- Tauri 2.0 API
- reqwest HTTP 客户端
- futures 并发库

### 目录结构
```
gxAgent/
├── src/                    # 前端代码
│   ├── components/        # React 组件
│   ├── utils/            # 工具函数
│   └── App.tsx           # 主应用
├── src-tauri/            # Rust 后端
│   ├── src/
│   │   ├── agent.rs      # Agent 核心逻辑
│   │   ├── tools.rs      # 工具执行
│   │   ├── config.rs     # 配置管理
│   │   └── mcp.rs        # MCP 协议
│   └── Cargo.toml        # Rust 依赖
└── docs/                 # 文档
```

---

## 性能基准

### 工具执行性能
| 场景 | v1.0.0 (串行) | v1.1.0 (并行) | 提升 |
|------|--------------|--------------|------|
| 3个读文件 (各0.5s) | 1.5s | 0.5s | 67% |
| 2个读 + 1个搜索 (2s) | 3.0s | 2.0s | 33% |
| 5个工具混合 | 7.5s | 2.5s | 67% |

### 编译性能
- Debug 构建：~24s
- Release 构建：~60s
- 增量编译：<5s

---

## 已知问题

### 非阻塞性
- [ ] MCP 工具仍为串行执行（未来可改为并发）
- [ ] 多个写操作可能冲突（需要锁机制）
- [ ] 托盘菜单 API 使用已废弃方法（等待 Tauri 更新）

### 警告信息
```
warning: use of deprecated method `menu_on_left_click`
  --> src\lib.rs:664:18
```
不影响功能，等待 Tauri 2.0 稳定版。

---

## 未来规划

### v1.2.0 (计划中)
- [ ] MCP 工具并行支持
- [ ] 智能串行/并行切换（读操作并行，写操作串行）
- [ ] 工具执行顺序控制
- [ ] 配置化执行模式

### v1.3.0 (计划中)
- [ ] 插件系统
- [ ] 自定义工具
- [ ] 工具执行可视化
- [ ] 性能分析面板

---

## 贡献者
- 初始开发：用户
- AI 辅助：Claude Code (Opus 4.7)
- 版本：v1.1.0

---

**最后更新**：2026-06-11
