# gxAgent 安全修复和代码重构总结

## ✅ 已完成的修复

### 后端 Rust 修复

#### 1. **crypto.rs - 密钥推导系统重写** ✅
- **问题**: 使用不安全的自定义密钥推导（简单 XOR）
- **修复**:
  - 使用 Argon2id 进行安全的密钥推导
  - 为每台机器生成并持久化随机 salt
  - 保留 v1/v2 解密以支持平滑迁移
  - 新增 HMAC-SHA256 用于数据完整性验证
  - 添加常量时间比较防止时序攻击

#### 2. **error.rs - 统一错误处理** ✅
- **新增**: 使用 thiserror 创建统一的错误类型系统
- **优势**:
  - 类型安全的错误传播
  - 更好的错误信息和调试体验
  - 避免 unwrap() 导致的 panic

#### 3. **policy.rs - 增强审批绕过防护** ✅
- **问题**: 命令审批可通过复合语法绕过
- **修复**:
  - 增强 `has_compound_syntax()` 检测所有 PowerShell 操作符
  - 新增 `has_dangerous_variable_usage()` 检测变量注入
  - 检测数组子表达式 `@(...)`、脚本块 `& { }`
  - 检测 Invoke-Expression、Get-Command 链式调用
  - 检测字符串拼接绕过（`-join`、`-f`）
  - 白名单匹配改为精确匹配，防止前缀绕过
  - 扩展高危命令黑名单（rundll32, installutil 等）

#### 4. **Cargo.toml - 依赖更新** ✅
- 新增: `argon2 = "0.5"` - 安全密钥推导
- 新增: `thiserror = "1.0"` - 错误处理
- 新增: `sha2 = "0.10"` - HMAC 签名
- 新增: `hex = "0.4"` - 十六进制编码

---

## 🟡 待完成的修复（优先级排序）

### 高优先级

#### 5. **tools.rs - 路径遍历和资源限制** 🔴
需要修复的问题：
```rust
// 问题 1: 路径黑名单不完整
const BLOCKED_PATH_PREFIXES: &[&str] = &[
    r"\Windows\System32",
    r"\Windows\SysWOW64",
    r"\ProgramData",
    r"\.ssh",
    r"\.gnupg",
    r"\.aws",
    r"\.kube",
    // 需要新增：
    r"\AppData\Roaming\Microsoft\Credentials",
    r"\Users\All Users",
    r"\.config\gcloud",
    r"\Windows\System32\config",
];

// 问题 2: 文件大小限制过小
const FILE_SIZE_LIMIT: usize = 100 * 1024; // 应改为 1MB

// 问题 3: 需要添加符号链接解析
fn resolve_path(path: &str, work_dir: &str) -> Result<String, String> {
    // 在检查路径前先 canonicalize 解析符号链接
    let canonical = std::fs::canonicalize(&path)?;
    check_blocked_path(&canonical.to_string_lossy())?;
}

// 问题 4: 需要添加速率限制
struct RateLimiter {
    max_tool_calls_per_minute: u32,
    max_file_operations_per_minute: u32,
    max_concurrent_commands: u32,
}
```

#### 6. **agent.rs - 速率限制和函数重构** 🔴
需要修复的问题：
```rust
// 问题 1: run_chat_mode 函数过长（900+ 行）
// 需要拆分为：
async fn execute_llm_request(...) -> Result<...>
async fn handle_streaming_response(...) -> Result<...>
async fn handle_tool_call_in_chat_mode(...) -> Result<...>
async fn handle_dsml_tool_calls(...) -> Result<...>

// 问题 2: 添加全局速率限制
pub struct AgentRateLimiter {
    requests_this_minute: AtomicU64,
    tool_calls_this_request: AtomicU64,
    last_reset: Mutex<Instant>,
}

impl AgentRateLimiter {
    fn check_request_limit(&self) -> Result<()> {
        // 每分钟最多 20 个请求
    }

    fn check_tool_call_limit(&self) -> Result<()> {
        // 每次请求最多 50 个工具调用
    }
}

// 问题 3: 重复代码消除
// DSML 解析代码在 3 处重复，需要提取为公共函数
```

#### 7. **mcp.rs - 进程管理加固** 🔴
需要修复的问题：
```rust
// 问题 1: 命令路径验证
pub async fn start(config: &McpServerConfig) -> Result<Self, String> {
    // 验证命令路径必须是绝对路径
    validate_mcp_command(&config.command)?;

    // 验证环境变量
    validate_env_vars(&config.env)?;
}

fn validate_mcp_command(command: &str) -> Result<()> {
    let path = Path::new(command);
    if !path.is_absolute() {
        return Err("MCP command must be absolute path".into());
    }
    if !path.exists() {
        return Err("MCP command does not exist".into());
    }
    Ok(())
}

// 问题 2: 进程超时和强制终止
pub async fn kill(&mut self) {
    let _ = self.child.kill().await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    if self.is_running() {
        // Windows: TerminateProcess
        // Unix: SIGKILL
    }
}
```

#### 8. **lib.rs - 配置完整性校验** 🔴
需要添加：
```rust
use crate::crypto::{hmac_sha256, verify_hmac};

#[tauri::command]
fn export_config(config: AppConfig) -> Result<String, String> {
    let json = serde_json::to_string(&config)?;
    let key = derive_signing_key();
    let signature = hmac_sha256(&json, &key);

    let export = json!({
        "version": "1.0",
        "config": config,
        "signature": hex::encode(signature),
        "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
    });

    Ok(serde_json::to_string_pretty(&export)?)
}

#[tauri::command]
fn import_config(json: &str) -> Result<AppConfig, String> {
    let export: Value = serde_json::from_str(json)?;

    // 验证签名
    let signature = hex::decode(export["signature"].as_str()?)?;
    let config_str = serde_json::to_string(&export["config"])?;
    let key = derive_signing_key();
    verify_hmac(&config_str, &signature, &key)?;

    // 验证时间戳（可选：拒绝过期配置）
    let timestamp = export["timestamp"].as_u64()?;
    // ...

    let config: AppConfig = serde_json::from_value(export["config"].clone())?;
    Ok(config)
}

fn derive_signing_key() -> Vec<u8> {
    // 使用机器 ID + 固定 salt 生成签名密钥
    let machine_id = whoami::hostname();
    sha256(format!("gxAgent:signing:{}", machine_id).as_bytes())
}
```

### 中优先级

#### 9. **前端架构重构** 🟡

##### a. 引入 Zustand 状态管理
```bash
npm install zustand immer
```

创建 `src/store/index.ts`:
```typescript
import create from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface AppStore {
  // Config
  config: AppConfig;
  setConfig: (config: AppConfig) => void;

  // Sessions
  sessions: ChatSession[];
  currentSessionId: string;
  addSession: (session: ChatSession) => void;
  updateSession: (id: string, updates: Partial<ChatSession>) => void;
  deleteSession: (id: string) => void;
  setCurrentSession: (id: string) => void;

  // UI State
  settingsOpen: boolean;
  isStreaming: boolean;
  pendingApprovals: PendingApproval | null;
  // ...
}

export const useAppStore = create<AppStore>()(
  immer((set) => ({
    config: DEFAULT_CONFIG,
    sessions: [],
    currentSessionId: '',
    settingsOpen: false,
    isStreaming: false,
    pendingApprovals: null,

    setConfig: (config) => set({ config }),
    addSession: (session) => set((state) => {
      state.sessions.push(session);
    }),
    // ...
  }))
);
```

##### b. 拆分 App.tsx 为模块化组件

创建目录结构：
```
src/
├── components/
│   ├── Chat/
│   │   ├── ChatContainer.tsx
│   │   ├── ChatMessage.tsx
│   │   ├── ChatInput.tsx
│   │   └── MessageActions.tsx
│   ├── Sidebar/
│   │   ├── SessionList.tsx
│   │   ├── SessionItem.tsx
│   │   └── SessionSearch.tsx
│   ├── Settings/
│   │   ├── SettingsDialog.tsx
│   │   ├── ModelSettings.tsx
│   │   ├── ToolSettings.tsx
│   │   └── SecuritySettings.tsx
│   ├── Tools/
│   │   ├── ToolApprovalDialog.tsx
│   │   ├── ToolActionCard.tsx
│   │   └── SearchStatus.tsx
│   └── Preview/
│       ├── PreviewPanel.tsx
│       └── PreviewConsole.tsx
├── hooks/
│   ├── useAgentEvents.ts
│   ├── useSessionManager.ts
│   ├── useToolApprovals.ts
│   └── useWebSearch.ts
├── store/
│   ├── index.ts
│   ├── configSlice.ts
│   ├── sessionSlice.ts
│   └── uiSlice.ts
├── utils/
│   ├── markdown.ts
│   ├── tokens.ts
│   └── validation.ts
└── App.tsx (简化为布局容器)
```

##### c. 提取自定义 hooks

`src/hooks/useAgentEvents.ts`:
```typescript
export function useAgentEvents() {
  const { addMessage, updateMessage, setStreaming } = useAppStore();

  useEffect(() => {
    const unlisten = listen('agent-stream-chunk', (event) => {
      // 处理流式输出
    });

    return () => { unlisten.then(fn => fn()); };
  }, []);
}
```

`src/hooks/useSessionManager.ts`:
```typescript
export function useSessionManager() {
  const { sessions, addSession, deleteSession } = useAppStore();

  const createNewSession = useCallback(() => {
    const newSession: ChatSession = {
      id: `session-${Date.now()}`,
      title: '',
      messages: [],
      sessionConfig: { ...DEFAULT_SESSION_CONFIG },
    };
    addSession(newSession);
  }, [addSession]);

  return { sessions, createNewSession, deleteSession };
}
```

#### 10. **性能优化** 🟡

##### a. 图片附件存储优化
```typescript
// 当前：Base64 存储在内存
interface Attachment {
  data: string; // 大量内存占用
}

// 优化：使用临时文件
interface Attachment {
  type: "image" | "text";
  filePath?: string; // 图片存储路径
  data?: string;     // 仅用于小文本
}

async function saveAttachmentToFile(attachment: Attachment): Promise<string> {
  const tempDir = await invoke<string>('get_temp_dir');
  const filePath = `${tempDir}/gxagent-${Date.now()}.${getExtension(attachment)}`;
  await invoke('write_binary_file', { path: filePath, data: attachment.data });
  return filePath;
}
```

##### b. 消息历史清理
```typescript
// 定期清理旧消息（保留最近 100 条）
function cleanupOldMessages(sessions: ChatSession[]): ChatSession[] {
  return sessions.map(session => ({
    ...session,
    messages: session.messages.slice(-100),
  }));
}

// 定期清理（每小时）
setInterval(() => {
  const { sessions, setSessions } = useAppStore.getState();
  setSessions(cleanupOldMessages(sessions));
}, 3600_000);
```

---

## 📊 修复进度

| 模块 | 状态 | 优先级 | 预计工作量 |
|------|------|--------|-----------|
| crypto.rs | ✅ 完成 | Critical | - |
| error.rs | ✅ 完成 | High | - |
| policy.rs | ✅ 完成 | Critical | - |
| tools.rs | 🔴 待修复 | Critical | 2-3 小时 |
| agent.rs | 🔴 待修复 | High | 3-4 小时 |
| mcp.rs | 🔴 待修复 | High | 1-2 小时 |
| lib.rs | 🔴 待修复 | High | 1 小时 |
| 前端重构 | 🔴 待修复 | Medium | 4-6 小时 |
| 性能优化 | 🟡 计划中 | Medium | 2-3 小时 |

---

## 🚀 下一步行动

### 立即执行（Critical）
1. 完成 tools.rs 修复（路径遍历、资源限制）
2. 完成 agent.rs 重构（拆分超长函数、添加速率限制）
3. 完成 mcp.rs 加固（进程验证、强制终止）

### 近期执行（High）
4. 完成 lib.rs 配置完整性校验
5. 测试所有安全修复
6. 更新单元测试

### 中期执行（Medium）
7. 前端架构重构（Zustand + 模块化）
8. 性能优化（内存、存储）
9. 添加集成测试

---

## ⚠️ 重要提示

### 破坏性变更
1. **密钥格式变更**: v3 加密格式不兼容旧版本的其他机器
   - 用户需要重新配置 API Key
   - 提供迁移工具或明确提示

2. **审批策略变严格**: 更多命令需要审批
   - 用户需要重新配置白名单
   - 提供默认安全白名单

### 测试清单
- [ ] crypto.rs: 加密/解密往返测试
- [ ] crypto.rs: v1/v2 迁移测试
- [ ] policy.rs: 绕过攻击测试
- [ ] tools.rs: 路径遍历攻击测试
- [ ] agent.rs: 速率限制测试
- [ ] 端到端: 完整工作流测试

---

## 📝 构建和测试命令

```bash
# 后端测试
cd src-tauri
cargo test

# 后端构建
cargo build --release

# 前端安装依赖
cd ..
npm install zustand immer

# 前端类型检查
npm run build

# 完整构建
npm run tauri build
```
