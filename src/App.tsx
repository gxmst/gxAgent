import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import * as Diff from "diff";
import mermaid from "mermaid";
import {
  Send,
  Settings,
  Settings2,
  Terminal as TerminalIcon,
  MessageSquare,
  FileText,
  FolderOpen,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Globe,
  Save,
  ImageIcon,
  Pin,
  ShieldAlert,
  RefreshCw,
  Sun,
  Moon,
  PanelRightOpen,
  PanelRightClose,
  Copy,
  Pencil,
  RotateCcw,
  X,
  Eye,
  Monitor,
  Smartphone,
  Download,
  Upload,
  Trash,
  Search,
  Zap,
  Sparkles,
  Server,
  PlusCircle,
  Timer,
  Type,
  Check,
} from "lucide-react";
import "./App.css";
import CaturtleLogo from "./assets/logo.png";
import { ROLE_PRESETS, ROLE_CATEGORIES, RolePreset } from "./rolePresets";

// ==========================================
// i18n
// ==========================================

const i18n: Record<string, Record<string, string>> = {
  zh: {
    "app.name": "gxAgent",
    "session.new": "新对话",
    "settings.title": "设置",
    "settings.save": "保存设置",
    "settings.close": "关闭",
    "settings.theme": "主题",
    "settings.theme.light": "浅色",
    "settings.theme.dark": "深色",
    "settings.language": "语言",
    "settings.provider": "API 提供商",
    "settings.baseUrl": "API 地址",
    "settings.apiKey": "API 密钥",
    "settings.model": "模型",
    "settings.systemPrompt": "系统提示词",
    "settings.approvalPolicy": "审批策略",
    "settings.approval.standard": "标准 — 确认写入和命令",
    "settings.approval.strict": "严格 — 除读取外均需确认",
    "settings.approval.relaxed": "宽松 — 仅确认未信任的写入",
    "settings.workDir": "默认工作目录",
    "settings.tools": "启用工具",
    "welcome.title": "有什么可以帮你的？",
    "welcome.desc": "执行命令、读写文件、运行 Python、搜索网页。",
    "input.placeholder": "让 Agent 构建、搜索或执行...",
    "approval.title": "需要工具审批",
    "approval.approve": "批准",
    "approval.reject": "拒绝",
    "reasoning.label": "思考过程",
    "preview": "预览",
    "preview.empty": "写入 HTML 文件后自动预览",
    "profile.title": "API 配置项",
    "profile.empty": "暂无配置项，保存当前配置以新建",
    "profile.newName": "新配置项名称",
    "profile.save": "保存",
    "profile.activate": "启用",
    "profile.active": "使用中",
    "profile.clearActive": "取消使用配置项",
    "profile.saved": "配置项已保存",
    "profile.activated": "已切换到: ",
    "compact.start": "正在压缩对话历史...",
    "compact.done": "对话历史已压缩",
    "compact.failed": "压缩失败: ",
    "compact.tooShort": "对话太短，无需压缩",
    "search.toggle": "联网搜索",
    "search.provider": "搜索引擎",
    "search.provider.ddg": "DuckDuckGo (免费免Key)",
    "search.provider.tavily": "Tavily (专业搜索)",
    "search.provider.searxng": "SearXNG (免费免Key)",
    "search.apiKey": "API Key",
    "search.apiKeyPlaceholder": "输入 Tavily API Key",
    "code.copy": "复制代码",
    "code.save": "保存为文件",
    "code.copied": "已复制",
    "code.saved": "已保存",
    "attach.drop": "拖放文件到此处",
    "attach.image": "图片",
    "attach.file": "文件",
    "attach.remove": "移除附件",
    "window.pin": "置顶窗口",
    "window.unpin": "取消置顶",
    "tools.active": "已启用工具",
    "terminal": "终端",
    "files": "文件",
    "files.workspace": "工作区",
    "files.refresh": "刷新",
    "files.modified": "已修改",
    "files.diff": "查看差异",
    "files.current": "查看当前",
    "status.parsing": "解析中",
    "status.running": "运行中",
    "status.done": "完成",
    "status.blocked": "已阻止",
    "status.awaiting": "等待审批",
    "action.arguments": "参数",
    "action.output": "输出",
    "thinking": "思考中...",
    "log.init": "gxAgent v1.0 已初始化。",
    "log.backend": "本地 Rust 后端就绪。",
    "log.complete": "Agent 循环完成。",
    "log.configSaved": "配置已保存。",
    "log.configFailed": "保存配置失败：",
    "log.needApiKey": "请先在设置中配置 API Key。",
    "log.modelsFetched": "从 {url} 获取了 {count} 个模型",
    "log.modelsFailed": "获取模型列表失败：",
    "usage.tokens": "Token",
    "usage.prompt": "输入",
    "usage.completion": "输出",
    "usage.total": "累计",
    "usage.ttft": "首字延迟",
    "usage.responseTime": "响应时间",
    "usage.loops": "轮次",
    "session.name": "名称",
    "session.systemPrompt": "系统提示（角色设定）",
    "session.model": "模型",
    "session.contextLimit": "上下文消息数量上限",
    "session.temperature": "温度",
    "session.topP": "Top P",
    "session.maxTokens": "最大输出Token数",
    "session.streaming": "流式输出",
    "session.thinkingLevel": "思考级别",
    "session.thinkingLow": "低",
    "session.thinkingMedium": "中",
    "session.thinkingHigh": "高",
    "session.background": "背景设置",
    "session.backgroundImage": "背景图片",
    "session.reset": "重置",
    "session.settings": "会话设置",
    "msg.edit": "修改",
    "msg.copy": "复制",
    "msg.delete": "删除",
    "msg.retry": "重试",
    "role.title": "角色预设",
    "context.isolate": "插入上下文截断线",
    "export.title": "导出会话",
    "input.steering": "智能体执行中，输入可随时干预方向...",
    "msg.copied": "已复制",
    "approval.approveAndTrust": "批准并信任",
    "approval.trustHint": "将此命令加入白名单，以后自动批准",
    "whitelist.title": "白名单管理",
    "whitelist.empty": "暂无白名单规则",
    "whitelist.toolName": "工具名",
    "whitelist.pattern": "匹配模式",
    "whitelist.remove": "移除",
    "whitelist.default": "默认",
    "whitelist.custom": "自定义",
    "mcp.title": "MCP 插件服务器",
    "mcp.empty": "暂无 MCP 服务器配置",
    "mcp.addServer": "添加服务器",
    "mcp.serverName": "服务器名称",
    "mcp.command": "启动命令",
    "mcp.args": "参数（逗号分隔）",
    "mcp.envVars": "环境变量 (KEY=VALUE，每行一个)",
    "mcp.remove": "移除",
    "mcp.fetchModels": "获取 Ollama 模型",
    "settings.fontSize": "字体大小",
    "settings.commandTimeout": "命令超时 (秒)",
    "settings.previewSandbox": "预览沙箱",
    "settings.sandbox.on": "沙箱已开启",
    "settings.sandbox.off": "沙箱已关闭",
    "settings.sandbox.onDesc": "预览在沙箱中运行，限制访问本地资源（推荐）",
    "settings.sandbox.offDesc": "预览直接在系统中运行，可访问本地资源",
    "settings.exportConfig": "导出配置",
    "settings.importConfig": "导入配置",
    "settings.clearSessions": "清除所有会话",
    "settings.clearSessionsConfirm": "确定要清除所有会话吗？此操作不可撤销。",
    "settings.cleared": "所有会话已清除",
    "settings.exported": "配置已导出",
    "settings.imported": "配置已导入",
    "settings.importFailed": "导入配置失败：",
    "spotlight.hint": "Ctrl+Shift+G 快速唤起",
    "context.delete": "删除会话",
    "context.export": "导出会话",
    "context.editPreset": "编辑角色预设",
    "context.clearPreset": "清除角色预设",
    "role.custom": "自定义预设",
    "role.customName": "预设名称",
    "role.customEmoji": "图标 (Emoji)",
    "role.customPrompt": "系统提示词",
    "role.customTemp": "温度",
    "role.customSave": "保存",
    "role.customDelete": "删除",
    "role.activePreset": "当前角色",
    "mode.chat": "对话模式",
    "mode.code": "编程模式",
    "context.import": "导入会话",
    "context.rename": "重命名",
    "context.moveUp": "上移",
    "context.moveDown": "下移",
    "shortcuts.title": "快捷键",
    "shortcuts.ctrlN": "Ctrl+N 新建会话",
    "shortcuts.ctrlComma": "Ctrl+, 设置",
    "shortcuts.ctrlShiftN": "Ctrl+Shift+N 切换模式",
    "shortcuts.escape": "Esc 关闭弹窗",
    "shortcuts.shiftEnter": "Shift+Enter 换行",
  },
  en: {
    "app.name": "gxAgent",
    "session.new": "New Conversation",
    "settings.title": "Settings",
    "settings.save": "Save Settings",
    "settings.close": "Close",
    "settings.theme": "Theme",
    "settings.theme.light": "Light",
    "settings.theme.dark": "Dark",
    "settings.language": "Language",
    "settings.provider": "Provider Preset",
    "settings.baseUrl": "API Base URL",
    "settings.apiKey": "API Key",
    "settings.model": "Model",
    "settings.systemPrompt": "System Prompt",
    "settings.approvalPolicy": "Approval Policy",
    "settings.approval.standard": "Standard — confirm writes & commands",
    "settings.approval.strict": "Strict — confirm everything except reads",
    "settings.approval.relaxed": "Relaxed — confirm only untrusted writes",
    "settings.workDir": "Default Work Directory",
    "settings.tools": "Enabled Tools",
    "welcome.title": "How can I help you?",
    "welcome.desc": "Execute commands, read/write files, run Python, or search the web.",
    "input.placeholder": "Ask Agent to build, search, or execute...",
    "approval.title": "Tool Approval Required",
    "approval.approve": "Approve",
    "approval.reject": "Reject",
    "reasoning.label": "Thinking Process",
    "preview": "Preview",
    "preview.empty": "Auto-preview when HTML is written",
    "profile.title": "API Profiles",
    "profile.empty": "No profiles yet. Save current config to create one.",
    "profile.newName": "New profile name",
    "profile.save": "Save",
    "profile.activate": "Activate",
    "profile.active": "Active",
    "profile.clearActive": "Deactivate profile",
    "profile.saved": "Profile saved",
    "profile.activated": "Switched to: ",
    "compact.start": "Compressing conversation history...",
    "compact.done": "History compressed",
    "compact.failed": "Compression failed: ",
    "compact.tooShort": "Conversation too short to compress",
    "search.toggle": "Web Search",
    "search.provider": "Search Engine",
    "search.provider.ddg": "DuckDuckGo (Free, No Key)",
    "search.provider.tavily": "Tavily (Professional)",
    "search.provider.searxng": "SearXNG (Free, No Key)",
    "search.apiKey": "API Key",
    "search.apiKeyPlaceholder": "Enter Tavily API Key",
    "code.copy": "Copy Code",
    "code.save": "Save to File",
    "code.copied": "Copied",
    "code.saved": "Saved",
    "attach.drop": "Drop files here",
    "attach.image": "Image",
    "attach.file": "File",
    "attach.remove": "Remove attachment",
    "window.pin": "Pin Window",
    "window.unpin": "Unpin Window",
    "tools.active": "Active Tools",
    "terminal": "Terminal",
    "files": "Files",
    "files.workspace": "Workspace",
    "files.refresh": "Refresh",
    "files.modified": "Modified",
    "files.diff": "View Diff",
    "files.current": "View Current",
    "status.parsing": "parsing",
    "status.running": "running",
    "status.done": "done",
    "status.blocked": "blocked",
    "status.awaiting": "awaiting approval",
    "action.arguments": "Arguments",
    "action.output": "Output",
    "thinking": "Thinking...",
    "log.init": "gxAgent v1.0 initialized.",
    "log.backend": "Local Rust backend ready.",
    "log.complete": "Agent loop complete.",
    "log.configSaved": "Configuration saved.",
    "log.configFailed": "Failed to save config: ",
    "log.needApiKey": "Please configure your API Key in settings first.",
    "log.modelsFetched": "Fetched {count} models from {url}",
    "log.modelsFailed": "Failed to fetch models: ",
    "usage.tokens": "Tokens",
    "usage.prompt": "Input",
    "usage.completion": "Output",
    "usage.total": "Total",
    "usage.ttft": "TTFT",
    "usage.responseTime": "Response",
    "usage.loops": "Loops",
    "session.name": "Name",
    "session.systemPrompt": "System Prompt (Role)",
    "session.model": "Model",
    "session.contextLimit": "Context Message Limit",
    "session.temperature": "Temperature",
    "session.topP": "Top P",
    "session.maxTokens": "Max Output Tokens",
    "session.streaming": "Streaming",
    "session.thinkingLevel": "Thinking Level",
    "session.thinkingLow": "Low",
    "session.thinkingMedium": "Medium",
    "session.thinkingHigh": "High",
    "session.background": "Background",
    "session.backgroundImage": "Background Image",
    "session.reset": "Reset",
    "session.settings": "Session Settings",
    "msg.edit": "Edit",
    "msg.copy": "Copy",
    "msg.delete": "Delete",
    "msg.retry": "Retry",
    "role.title": "Role Presets",
    "context.isolate": "Insert Context Divider",
    "export.title": "Export Session",
    "input.steering": "Agent running, type to steer...",
    "msg.copied": "Copied",
    "approval.approveAndTrust": "Approve & Trust",
    "approval.trustHint": "Add this command to whitelist for auto-approval",
    "whitelist.title": "Whitelist Management",
    "whitelist.empty": "No whitelist rules yet",
    "whitelist.toolName": "Tool Name",
    "whitelist.pattern": "Pattern",
    "whitelist.remove": "Remove",
    "whitelist.default": "Default",
    "whitelist.custom": "Custom",
    "mcp.title": "MCP Plugin Servers",
    "mcp.empty": "No MCP server configured",
    "mcp.addServer": "Add Server",
    "mcp.serverName": "Server Name",
    "mcp.command": "Start Command",
    "mcp.args": "Arguments (comma-separated)",
    "mcp.envVars": "Environment Variables (KEY=VALUE per line)",
    "mcp.remove": "Remove",
    "mcp.fetchModels": "Fetch Ollama Models",
    "settings.fontSize": "Font Size",
    "settings.commandTimeout": "Command Timeout (seconds)",
    "settings.previewSandbox": "Preview Sandbox",
    "settings.sandbox.on": "Sandbox On",
    "settings.sandbox.off": "Sandbox Off",
    "settings.sandbox.onDesc": "Preview runs in sandbox, restricted from local resources (Recommended)",
    "settings.sandbox.offDesc": "Preview runs directly on system, can access local resources",
    "settings.exportConfig": "Export Config",
    "settings.importConfig": "Import Config",
    "settings.clearSessions": "Clear All Sessions",
    "settings.clearSessionsConfirm": "Are you sure you want to clear all sessions? This cannot be undone.",
    "settings.cleared": "All sessions cleared",
    "settings.exported": "Config exported",
    "settings.imported": "Config imported",
    "settings.importFailed": "Failed to import config: ",
    "spotlight.hint": "Ctrl+Shift+G to quick launch",
    "context.delete": "Delete Session",
    "context.export": "Export Session",
    "context.editPreset": "Edit Role Preset",
    "context.clearPreset": "Clear Role Preset",
    "role.custom": "Custom Presets",
    "role.customName": "Preset Name",
    "role.customEmoji": "Icon (Emoji)",
    "role.customPrompt": "System Prompt",
    "role.customTemp": "Temperature",
    "role.customSave": "Save",
    "role.customDelete": "Delete",
    "role.activePreset": "Active Role",
    "mode.chat": "Chat Mode",
    "mode.code": "Code Mode",
    "context.import": "Import Session",
    "context.rename": "Rename",
    "context.moveUp": "Move Up",
    "context.moveDown": "Move Down",
    "shortcuts.title": "Shortcuts",
    "shortcuts.ctrlN": "Ctrl+N New Session",
    "shortcuts.ctrlComma": "Ctrl+, Settings",
    "shortcuts.ctrlShiftN": "Ctrl+Shift+N Toggle Mode",
    "shortcuts.escape": "Esc Close Dialog",
    "shortcuts.shiftEnter": "Shift+Enter Newline",
  },
};

function t(key: string, lang: string, vars?: Record<string, string>): string {
  let text = (i18n[lang] || i18n["en"])[key] || (i18n["en"][key]) || key;
  if (vars) {
    Object.entries(vars).forEach(([k, v]) => {
      text = text.replace(`{${k}}`, v);
    });
  }
  return text;
}

// ==========================================
// Types
// ==========================================

import {
  AppConfig,
  TrustedPattern,
  ProviderPreset,
  ModelInfo,
  ToolAction,
  ChatSession,
  SessionConfig,
  UsageStats,
  PendingApproval,
  SearchStatus
} from "./types";

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  mode: "chat",
  systemPrompt: "",
  model: "",
  contextLimit: 50,
  temperature: 0.7,
  topP: 1.0,
  maxTokens: null,
  streaming: true,
  thinkingLevel: "medium",
  backgroundImage: "",
  activeRolePresetId: null,
};

const DEFAULT_CONFIG: AppConfig = {
  provider: "openai",
  base_url: "https://api.deepseek.com/v1",
  api_key: "",
  model: "deepseek-chat",
  temperature: 0.7,
  top_p: 1.0,
  max_tokens: null,
  system_prompt:
    "You are a helpful AI assistant with access to local tools running on Windows. Help the user accomplish tasks by using the available tools when needed. Be concise and direct.\n\nIMPORTANT: The shell is Windows PowerShell. Do NOT use Unix/bash syntax (no ||, no &&, no /dev/null, no cat/grep/ls). Use PowerShell equivalents: use ; to chain commands, use Select-String instead of grep, use Get-ChildItem instead of ls, use Get-Content instead of cat. Redirect errors with 2>$null. Always use PowerShell-compatible commands.",
  streaming: true,
  context_limit: 50,
  tools_enabled: [
    "execute_command",
    "read_file",
    "write_file",
    "list_dir",
    "run_python",
    "web_search",
  ],
  approval_policy: "standard",
  trusted_patterns: [],
  default_work_dir: "",
  persist_trust: false,
  theme: "light",
  language: "zh",
  profiles: {},
  active_profile: null,
  mcp_servers: {},
  search_provider: "duckduckgo",
  search_api_key: "",
  font_size: 14,
  command_timeout: 30,
  preview_sandbox: true,
};

const TOOL_NAMES: { key: string; label: string }[] = [
  { key: "execute_command", label: "Shell" },
  { key: "read_file", label: "Read" },
  { key: "write_file", label: "Write" },
  { key: "list_dir", label: "List Dir" },
  { key: "run_python", label: "Python" },
  { key: "web_search", label: "Search" },
];

function DiffView({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const changes = Diff.diffLines(oldContent, newContent);
  return (
    <div className="diff-view">
      {changes.map((part, i) => {
        const cls = part.added ? "diff-add" : part.removed ? "diff-remove" : "diff-unchanged";
        return (
          <pre key={i} className={`diff-line ${cls}`}>
            <span className="diff-prefix">{part.added ? "+" : part.removed ? "-" : " "}</span>
            {part.value}
          </pre>
        );
      })}
    </div>
  );
}

let mermaidIdCounter = 0;

function CustomPresetForm({ lang, onSave, t, editingPreset }: { lang: string; onSave: (preset: RolePreset) => void; t: (key: string, lang: string) => string; editingPreset?: RolePreset | null }) {
  const [emoji, setEmoji] = useState(editingPreset?.emoji || "🤖");
  const [name, setName] = useState(editingPreset?.name || "");
  const [prompt, setPrompt] = useState(editingPreset?.prompt || "");
  const [temp, setTemp] = useState(editingPreset?.temperature ?? 0.5);

  useEffect(() => {
    if (editingPreset) {
      setEmoji(editingPreset.emoji || "🤖");
      setName(editingPreset.name || "");
      setPrompt(editingPreset.prompt || "");
      setTemp(editingPreset.temperature ?? 0.5);
    }
  }, [editingPreset]);

  return (
    <div className="role-preset-form-inner">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          className="role-preset-form-input"
          placeholder={t("role.customEmoji", lang)}
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          style={{ width: 40, textAlign: "center" }}
        />
        <input
          className="role-preset-form-input"
          placeholder={t("role.customName", lang)}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1 }}
        />
      </div>
      <textarea
        className="role-preset-form-textarea"
        placeholder={t("role.customPrompt", lang)}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: "0.7rem", opacity: 0.7 }}>{t("role.customTemp", lang)}: {temp}</span>
        <input type="range" min={0} max={2} step={0.1} value={temp} onChange={(e) => setTemp(parseFloat(e.target.value))} style={{ flex: 1 }} />
      </div>
      <button
        className="btn btn-primary"
        style={{ fontSize: "0.72rem", padding: "4px 12px", width: "100%" }}
        disabled={!name.trim() || !prompt.trim()}
        onClick={() => {
          onSave({
            id: editingPreset?.id || `custom-${Date.now()}`,
            emoji: emoji || "🤖",
            name: name.trim(),
            nameZh: name.trim(),
            description: "",
            descriptionZh: "",
            prompt: prompt.trim(),
            temperature: temp,
            category: "Custom",
          });
        }}
      >
        {t("role.customSave", lang)}
      </button>
    </div>
  );
}

function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]*/gi, "")
    .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, "")
    .replace(/xlink:href\s*=\s*["']javascript:[^"']*["']/gi, "");
}

function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    const id = `mermaid-${++mermaidIdCounter}`;
    mermaid.render(id, chart).then((result) => {
      setSvg(sanitizeSvg(result.svg));
    }).catch((err) => {
      setSvg(`<pre style="color:var(--error);font-size:0.75rem">Mermaid error: ${err.message || err}</pre>`);
    });
  }, [chart]);

  if (svg) {
    return <div className="mermaid-container" dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  return <div ref={ref} className="mermaid-container" />;
}

function McpAddForm({ setConfig, addLog, lang, t }: {
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  addLog: (text: string, type: "info" | "success" | "error" | "cmd") => void;
  lang: string;
  t: (key: string, lang: string, vars?: Record<string, string>) => string;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");

  const handleAdd = async () => {
    if (!name.trim() || !command.trim()) return;
    const env: Record<string, string> = {};
    if (envText.trim()) {
      for (const line of envText.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
        }
      }
    }
    try {
      const updated = await invoke<AppConfig>("save_mcp_server", {
        name: name.trim(),
        command: command.trim(),
        args: args.trim() ? args.split(",").map(a => a.trim()) : [],
        env,
      });
      setConfig(updated);
      setName("");
      setCommand("");
      setArgs("");
      setEnvText("");
      addLog(`MCP server "${name}" added`, "success");
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  return (
    <div className="mcp-add-form">
      <input
        type="text"
        className="input-text mcp-input"
        placeholder={t("mcp.serverName", lang)}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="text"
        className="input-text mcp-input"
        placeholder={t("mcp.command", lang)}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
      />
      <input
        type="text"
        className="input-text mcp-input"
        placeholder={t("mcp.args", lang)}
        value={args}
        onChange={(e) => setArgs(e.target.value)}
      />
      <textarea
        className="input-text mcp-textarea"
        placeholder={t("mcp.envVars", lang)}
        value={envText}
        onChange={(e) => setEnvText(e.target.value)}
        rows={2}
      />
      <button
        className="btn btn-secondary"
        style={{ fontSize: "0.72rem", width: "100%" }}
        onClick={handleAdd}
        disabled={!name.trim() || !command.trim()}
      >
        <PlusCircle size={12} /> {t("mcp.addServer", lang)}
      </button>
    </div>
  );
}

function App() {
  // ==========================================
  // Config & State
  // ==========================================

  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [prompt, setPrompt] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"appearance" | "api" | "behavior" | "advanced">("appearance");
  const [activeTab, setActiveTab] = useState<"terminal" | "files" | "preview">("terminal");
  const [previewSrc, setPreviewSrc] = useState<string>("");
  const [webSearchEnabled, setWebSearchEnabled] = useState<boolean>(false);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [newProfileName, setNewProfileName] = useState("");
  const [modifiedFiles, setModifiedFiles] = useState<Record<string, { old: string; new: string }>>({});
  const [diffView, setDiffView] = useState(false);
  const [attachments, setAttachments] = useState<{ name: string; type: "image" | "text"; data: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [rolePresetsOpen, setRolePresetsOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [customPresets, setCustomPresets] = useState<RolePreset[]>(() => {
    try {
      const saved = localStorage.getItem("gx_custom_presets");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch { /* ignore */ }
    return [];
  });
  const [customPresetForm, setCustomPresetForm] = useState(false);
  const [editingCustomPreset, setEditingCustomPreset] = useState<RolePreset | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [fileList, setFileList] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [terminalLogs, setTerminalLogs] = useState<
    { text: string; type: "info" | "success" | "error" | "cmd" }[]
  >([]);
  const [previewConsoleLogs, setPreviewConsoleLogs] = useState<
    { text: string; type: "log" | "error" | "warn" | "info" }[]
  >([]);

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      const saved = localStorage.getItem("gx_sessions");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch { /* ignore corrupt data */ }
    return [{ id: "default", title: "", messages: [], sessionConfig: { ...DEFAULT_SESSION_CONFIG } }];
  });
  const [currentSessionId, setCurrentSessionId] = useState(
    () => localStorage.getItem("gx_current_session") || "default"
  );
  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [sidebarNav, setSidebarNav] = useState<"chat" | "code">("chat");
  const [editingMessageIdx, setEditingMessageIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  // Resize state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { const v = localStorage.getItem("gx_sidebar_width"); return v ? parseInt(v) : 220; } catch { return 220; }
  });
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    try { const v = localStorage.getItem("gx_right_panel_width"); return v ? parseInt(v) : 360; } catch { return 360; }
  });
  const [draggingSidebar, setDraggingSidebar] = useState(false);
  const [draggingRight, setDraggingRight] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const isAtBottomRef = useRef(true);
  const currentSessionIdRef = useRef(currentSessionId);

  // Keep the ref in sync with the reactive state
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const currentSession = sessions.find((s) => s.id === currentSessionId) || sessions[0];
  const currentMode = currentSession.sessionConfig.mode || "chat";
  const lang = config.language || "zh";

  useEffect(() => {
    setRightPanelOpen(currentMode === "code");
  }, [currentSessionId]);

  // ==========================================
  // Theme
  // ==========================================

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        setSidebarNav(prev => prev === "chat" ? "code" : "chat");
        return;
      }
      if (ctrl && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        createNewSession();
      }
      if (ctrl && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(prev => !prev);
      }
      if (e.key === "Escape") {
        if (contextMenu) { setContextMenu(null); return; }
        if (rolePresetsOpen) { setRolePresetsOpen(false); setCustomPresetForm(false); setEditingCustomPreset(null); return; }
        if (modelPickerOpen) { setModelPickerOpen(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (sessionSettingsOpen) { setSessionSettingsOpen(false); return; }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu, rolePresetsOpen, modelPickerOpen, settingsOpen, sessionSettingsOpen]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", config.theme || "light");
  }, [config.theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--dynamic-font-size", `${config.font_size || 14}px`);
  }, [config.font_size]);

  useEffect(() => {
    const handleIframeMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "iframe-console-log") {
        const { logType, text } = event.data;
        setPreviewConsoleLogs(prev => {
          const next = [...prev, { text, type: logType }];
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      }
    };
    window.addEventListener("message", handleIframeMessage);
    return () => window.removeEventListener("message", handleIframeMessage);
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("config-import-rekey", (event) => {
      addLog(event.payload, "error");
      setSettingsOpen(true);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const toggleTheme = () => {
    setConfig((prev) => ({
      ...prev,
      theme: prev.theme === "dark" ? "light" : "dark",
    }));
  };

  // ==========================================
  // Init logs with language
  // ==========================================

  useEffect(() => {
    setTerminalLogs([
      { text: t("log.init", lang), type: "info" },
      { text: t("log.backend", lang), type: "info" },
    ]);
  }, []);

  // ==========================================
  // Resize handlers
  // ==========================================

  const handleSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingSidebar(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(160, Math.min(400, startWidth + delta));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      setDraggingSidebar(false);
      try { localStorage.setItem("gx_sidebar_width", String(startWidth)); } catch { /* ignore */ }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  const handleRightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingRight(true);
    const startX = e.clientX;
    const startWidth = rightPanelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const newWidth = Math.max(200, Math.min(600, startWidth + delta));
      setRightPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      setDraggingRight(false);
      try { localStorage.setItem("gx_right_panel_width", String(startWidth)); } catch { /* ignore */ }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [rightPanelWidth]);

  // ==========================================
  // Init: Load config & presets
  // ==========================================

  useEffect(() => {
    (async () => {
      try {
        const [loadedConfig, loadedPresets] = await Promise.all([
          invoke<AppConfig>("load_config"),
          invoke<ProviderPreset[]>("get_provider_presets"),
        ]);
        setConfig(loadedConfig);
        setPresets(loadedPresets);
      } catch (e) {
        console.error("Failed to load config:", e);
        try {
          const loadedPresets = await invoke<ProviderPreset[]>("get_provider_presets");
          setPresets(loadedPresets);
        } catch { /* ignore */ }
      }
    })();
  }, []);

  useEffect(() => {
    try {
      const data = JSON.stringify(sessions);
      if (data.length > 4 * 1024 * 1024) {
        const trimmed = sessions.map((s: ChatSession) => ({
          ...s,
          messages: s.messages.slice(-20),
        }));
        localStorage.setItem("gx_sessions", JSON.stringify(trimmed));
      } else {
        localStorage.setItem("gx_sessions", data);
      }
    } catch {
      try { localStorage.removeItem("gx_sessions"); } catch { /* quota exceeded, nothing to do */ }
    }
  }, [sessions]);

  useEffect(() => {
    try {
      localStorage.setItem("gx_current_session", currentSessionId);
    } catch { /* ignore */ }
  }, [currentSessionId]);

  useEffect(() => {
    try {
      localStorage.setItem("gx_custom_presets", JSON.stringify(customPresets));
    } catch { /* ignore */ }
  }, [customPresets]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(sessionSearch), 200);
    return () => clearTimeout(timer);
  }, [sessionSearch]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  const ALL_PRESETS = [...ROLE_PRESETS, ...customPresets];

  useEffect(() => {
    if (isAtBottomRef.current && chatContainerRef.current) {
      const el = chatContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [currentSession.messages, isStreaming]);

  useEffect(() => {
    refreshFileList();
  }, [config.default_work_dir]);

  // ==========================================
  // Helpers
  // ==========================================

  const MAX_LOG_LINES = 500;
  const addLog = (text: string, type: "info" | "success" | "error" | "cmd" = "info") => {
    setTerminalLogs((prev) => {
      const next = [...prev, { text, type }];
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    });
  };

  const refreshFileList = async () => {
    try {
      const result = await invoke<string>("list_directory", {
        path: config.default_work_dir || ".",
      });
      setFileList(result.split("\n").filter(Boolean));
    } catch (e) {
      addLog(`Failed to list directory: ${e}`, "error");
    }
  };

  const fetchModelList = async () => {
    if (!config.base_url) return;
    setModelsLoading(true);
    try {
      const list = await invoke<ModelInfo[]>("fetch_models", {
        baseUrl: config.base_url,
        apiKey: config.api_key,
      });
      setModels(list);
      addLog(t("log.modelsFetched", lang, { count: String(list.length), url: config.base_url }), "success");
    } catch (e) {
      addLog(t("log.modelsFailed", lang) + e, "error");
    } finally {
      setModelsLoading(false);
    }
  };

  const applyPreset = (preset: ProviderPreset) => {
    setConfig((prev) => ({
      ...prev,
      provider: preset.provider,
      base_url: preset.base_url,
      model: preset.default_model || prev.model,
      api_key: preset.needs_api_key ? prev.api_key : "",
    }));
    setModels([]);
  };

  const handleSaveProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    try {
      const updated = await invoke<AppConfig>("save_profile", {
        profile: { name, base_url: config.base_url, api_key: config.api_key, default_model: config.model },
      });
      setConfig(updated);
      cacheModelDisplayName(config.model, name);
      setNewProfileName("");
      addLog(t("profile.saved", lang), "success");
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const getModelDisplayName = (modelId: string) => {
    if (config.active_profile) {
      const profile = config.profiles[config.active_profile];
      if (profile && profile.default_model === modelId) return profile.name;
    }
    const profile = Object.values(config.profiles).find(p => p.default_model === modelId);
    if (profile) return profile.name;
    const cached = localStorage.getItem("gx_model_display_names");
    if (cached) {
      try {
        const map: Record<string, string> = JSON.parse(cached);
        if (map[modelId]) return map[modelId];
      } catch { /* ignore */ }
    }
    return modelId;
  };

  const cacheModelDisplayName = (modelId: string, displayName: string) => {
    try {
      const cached = localStorage.getItem("gx_model_display_names");
      const map: Record<string, string> = cached ? JSON.parse(cached) : {};
      map[modelId] = displayName;
      localStorage.setItem("gx_model_display_names", JSON.stringify(map));
    } catch { /* ignore */ }
  };

  const handleActivateProfile = async (name: string) => {
    try {
      const updated = await invoke<AppConfig>("set_active_profile", { name });
      setConfig(updated);
      const profile = updated.profiles[name];
      if (profile) cacheModelDisplayName(profile.default_model, profile.name);
      addLog(t("profile.activated", lang) + name, "success");
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const handleDeleteProfile = async (name: string) => {
    try {
      const updated = await invoke<AppConfig>("delete_profile", { name });
      setConfig(updated);
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const handleClearActiveProfile = async () => {
    try {
      const updated = await invoke<AppConfig>("clear_active_profile");
      setConfig(updated);
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const handleCompact = async () => {
    const messages = currentSession.messages;
    if (messages.length < 3) {
      addLog(t("compact.tooShort", lang), "info");
      return;
    }
    setIsStreaming(true);
    addLog(t("compact.start", lang), "info");
    try {
      const result = await invoke<string>("compact_history", {
        config,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      // Replace session history with compressed summary
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== currentSessionId) return s;
          return {
            ...s,
            messages: [
              { role: "assistant" as const, content: result, actions: [] },
            ],
          };
        })
      );
      addLog(t("compact.done", lang), "success");
    } catch (e) {
      addLog(t("compact.failed", lang) + String(e), "error");
    } finally {
      setIsStreaming(false);
    }
  };

  const saveConfig = async () => {
    try {
      await invoke("save_config", { config });
      addLog(t("log.configSaved", lang), "success");
    } catch (e) {
      addLog(t("log.configFailed", lang) + e, "error");
    }
  };

  const handleFileClick = async (name: string) => {
    if (name.endsWith("/")) return;
    const path = config.default_work_dir
      ? `${config.default_work_dir}\\${name}`
      : name;
    try {
      const content = await invoke<string>("read_file_content", { path });
      setSelectedFile(name);
      setFileContent(content);
    } catch (e) {
      addLog(`Failed to read file: ${e}`, "error");
    }
  };

  // ==========================================
  // Tauri Event Listeners — registered once on mount, use ref for current session
  // ==========================================

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    async function setup() {
      unlisteners.push(
        await listen<string>("agent-stream-chunk", (event) => {
          let payload = event.payload;
          if (payload.includes("DSML")) {
            payload = payload.replace(/<[｜|][｜|][^>]*>/g, "");
            payload = payload.replace(/<\/[｜|][｜|][^>]*>/g, "");
            if (!payload.trim()) return;
          }
          const filteredPayload = payload;
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== currentSessionIdRef.current) return s;
              const messages = [...s.messages];
              if (
                messages.length === 0 ||
                messages[messages.length - 1].role !== "assistant"
              ) {
                messages.push({
                  role: "assistant",
                  content: filteredPayload,
                  actions: [],
                  variants: [filteredPayload],
                  currentVariantIndex: 0,
                  timestamp: Date.now(),
                });
              } else {
                const last = { ...messages[messages.length - 1] };
                last.content += filteredPayload;
                if (last.variants) {
                  last.variants[last.currentVariantIndex || 0] = last.content;
                } else {
                  last.variants = [last.content];
                  last.currentVariantIndex = 0;
                }
                messages[messages.length - 1] = last;
              }
              return { ...s, messages };
            })
          );
        })
      );

      unlisteners.push(
        await listen<SearchStatus>("agent-search-status", (event) => {
          const status = event.payload;
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== currentSessionIdRef.current) return s;
              const messages = [...s.messages];
              if (messages.length === 0) return s;
              const last = { ...messages[messages.length - 1] };
              if (last.role !== "assistant") return s;
              const existing = last.searchStatus || [];
              if (status.type === "searching") {
                last.searchStatus = [...existing, status];
              } else if (status.type === "results" || status.type === "error") {
                const lastSearchIdx = [...existing].reverse().findIndex((s) => s.type === "searching" && s.query === status.query);
                if (lastSearchIdx !== -1) {
                  const realIdx = existing.length - 1 - lastSearchIdx;
                  const updated = [...existing];
                  updated[realIdx] = { ...updated[realIdx], ...status };
                  last.searchStatus = updated;
                } else {
                  last.searchStatus = [...existing, status];
                }
              }
              messages[messages.length - 1] = last;
              return { ...s, messages };
            })
          );
        })
      );

      unlisteners.push(
        await listen<string>("agent-reasoning-chunk", (event) => {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== currentSessionIdRef.current) return s;
              const messages = [...s.messages];
              if (
                messages.length === 0 ||
                messages[messages.length - 1].role !== "assistant"
              ) {
                messages.push({
                  role: "assistant",
                  content: "",
                  actions: [],
                  reasoningContent: event.payload,
                  timestamp: Date.now(),
                });
              } else {
                const last = { ...messages[messages.length - 1] };
                last.reasoningContent = (last.reasoningContent || "") + event.payload;
                messages[messages.length - 1] = last;
              }
              return { ...s, messages };
            })
          );
        })
      );

      unlisteners.push(
        await listen<{ index: number; id: string; name: string; arguments: string }>(
          "agent-tool-drafting",
          (event) => {
            const { index, id: toolId, name, arguments: args } = event.payload;
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== currentSessionIdRef.current) return s;
                const messages = [...s.messages];
                if (messages.length === 0) return s;
                const last = { ...messages[messages.length - 1] };
                if (last.role !== "assistant") return s;
                const actions = last.actions ? [...last.actions] : [];
                if (index >= actions.length || !actions[index]) {
                  actions[index] = {
                    id: toolId || `tc-${index}-${Date.now()}`,
                    name,
                    arguments: args,
                    status: "drafting",
                  };
                } else {
                  actions[index] = { ...actions[index], arguments: args };
                  if (toolId && actions[index].id.startsWith("tc-")) {
                    actions[index].id = toolId;
                  }
                }
                last.actions = actions;
                messages[messages.length - 1] = last;
                return { ...s, messages };
              })
            );
          }
        )
      );

      unlisteners.push(
        await listen<{ id: string; name: string; arguments: string }>(
          "agent-tool-executing",
          (event) => {
            const { id, name, arguments: args } = event.payload;
            addLog(`[Exec] ${name}: ${args.substring(0, 200)}`, "cmd");
            // Pre-read old file content for diff before write_file executes
            if (name === "write_file") {
              try {
                const parsed = JSON.parse(args);
                const filePath = parsed.path || "";
                if (filePath) {
                  invoke<string>("read_file_content", { path: filePath }).then((oldContent) => {
                    setModifiedFiles((prev) => ({
                      ...prev,
                      [filePath]: { old: oldContent, new: parsed.content || "" },
                    }));
                  }).catch(() => {
                    // File doesn't exist yet — mark as new
                    setModifiedFiles((prev) => ({
                      ...prev,
                      [filePath]: { old: "", new: parsed.content || "" },
                    }));
                  });
                }
              } catch {}
            }
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== currentSessionIdRef.current) return s;
                const messages = [...s.messages];
                if (messages.length === 0) return s;
                const last = { ...messages[messages.length - 1] };
                if (last.role !== "assistant" || !last.actions) return s;
                last.actions = last.actions.map((a) =>
                  a.id === id ? { ...a, status: "executing" as const } : a
                );
                messages[messages.length - 1] = last;
                return { ...s, messages };
              })
            );
          }
        )
      );

      unlisteners.push(
        await listen<{ id: string; name: string; output: string }>(
          "agent-tool-output",
          (event) => {
            const { id, name, output } = event.payload;
            addLog(
              `[Done] ${name}: ${output.substring(0, 200)}${output.length > 200 ? "..." : ""}`,
              "success"
            );
            if (name === "write_file") {
              refreshFileList();
              // Auto-preview HTML files — get path from action arguments, not output
              setSessions((prev) => {
                const session = prev.find((s) => s.id === currentSessionIdRef.current);
                if (!session) return prev;
                const lastMsg = session.messages[session.messages.length - 1];
                const action = lastMsg?.actions?.find((a) => a.id === id);
                if (action) {
                  try {
                    const args = JSON.parse(action.arguments);
                    const filePath = args.path || "";
                    if (/\.(html?|svg)$/i.test(filePath)) {
                      invoke<string>("read_file_content", { path: filePath }).then((content) => {
                        setPreviewSrc(content);
                        setActiveTab("preview");
                      }).catch(() => {});
                    }
                  } catch {}
                }
                return prev;
              });
            }
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== currentSessionIdRef.current) return s;
                const messages = [...s.messages];
                if (messages.length === 0) return s;
                const last = { ...messages[messages.length - 1] };
                if (last.role !== "assistant" || !last.actions) return s;
                last.actions = last.actions.map((a) =>
                  a.id === id ? { ...a, status: "done" as const, output } : a
                );
                messages[messages.length - 1] = last;
                return { ...s, messages };
              })
            );
          }
        )
      );

      unlisteners.push(
        await listen<{ id: string; name: string; reason: string }>(
          "agent-tool-blocked",
          (event) => {
            const { id, name, reason } = event.payload;
            addLog(`[Blocked] ${name}: ${reason}`, "error");
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== currentSessionIdRef.current) return s;
                const messages = [...s.messages];
                if (messages.length === 0) return s;
                const last = { ...messages[messages.length - 1] };
                if (last.role !== "assistant" || !last.actions) return s;
                last.actions = last.actions.map((a) =>
                  a.id === id ? { ...a, status: "blocked" as const, output: reason } : a
                );
                messages[messages.length - 1] = last;
                return { ...s, messages };
              })
            );
          }
        )
      );

      unlisteners.push(
        await listen<PendingApproval>("agent-tool-approval-request", (event) => {
          setPendingApprovals(event.payload);
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== currentSessionIdRef.current) return s;
              const messages = [...s.messages];
              if (messages.length === 0) return s;
              const last = { ...messages[messages.length - 1] };
              if (last.role !== "assistant" || !last.actions) return s;
              const pendingIds = event.payload.tool_calls.map((tc) => tc.id);
              last.actions = last.actions.map((a) =>
                pendingIds.includes(a.id)
                  ? { ...a, status: "pending_approval" as const }
                  : a
              );
              messages[messages.length - 1] = last;
              return { ...s, messages };
            })
          );
        })
      );

      unlisteners.push(
        await listen<string>("agent-complete", () => {
          setIsStreaming(false);
          addLog(t("log.complete", lang), "info");
          setTimeout(() => chatTextareaRef.current?.focus(), 100);
        })
      );

      unlisteners.push(
        await listen<{
          prompt_tokens: number;
          completion_tokens: number;
          total_prompt_tokens: number;
          total_completion_tokens: number;
          ttft_ms: number;
          response_time_ms: number;
          loop_count: number;
        }>("agent-usage", (event) => {
          setUsageStats({
            promptTokens: event.payload.prompt_tokens,
            completionTokens: event.payload.completion_tokens,
            totalPromptTokens: event.payload.total_prompt_tokens,
            totalCompletionTokens: event.payload.total_completion_tokens,
            ttftMs: event.payload.ttft_ms,
            responseTimeMs: event.payload.response_time_ms,
            loopCount: event.payload.loop_count,
          });
        })
      );
    }

    setup();

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ==========================================
  // Actions
  // ==========================================

  const handleSendMessage = async () => {
    if (!prompt.trim() || isStreaming) return;

    // Slash command: /compact — compress conversation history
    if (prompt.trim().toLowerCase() === "/compact") {
      setPrompt("");
      await handleCompact();
      return;
    }

    // Slash command: /clear — insert context divider
    if (prompt.trim().toLowerCase() === "/clear") {
      setPrompt("");
      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
        ...s,
        messages: [...s.messages, { role: "context_divider" as const, content: "" }]
      } : s));
      return;
    }

    if (!config.api_key.trim() && config.provider !== "ollama" && (config.base_url.includes("deepseek") || config.base_url.includes("openai.com"))) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error");
      return;
    }

    const userMessage = prompt.trim();
    setPrompt("");
    setIsStreaming(true);

    let finalMessage = userMessage;
    if (attachments.length > 0) {
      const parts: string[] = [];
      for (const att of attachments) {
        if (att.type === "image") {
          parts.push(`[Attached Image: ${att.name}]`);
        } else {
          parts.push(`[Attached File: ${att.name}]\n\`\`\`\n${att.data}\n\`\`\``);
        }
      }
      finalMessage = parts.join("\n\n") + "\n\n" + userMessage;
    }
    setAttachments([]);

    const sessionMessages = (() => {
      const msgs = currentSession.messages;
      let lastDividerIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "context_divider") {
          lastDividerIdx = i;
          break;
        }
      }
      const activeMsgs = lastDividerIdx >= 0 ? msgs.slice(lastDividerIdx + 1) : msgs;
      return activeMsgs
        .filter((m) => m.role !== "context_divider")
        .map((m) => ({
          role: m.role,
          content: m.variants ? (m.variants[m.currentVariantIndex || 0] || m.content) : m.content,
        }));
    })();

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== currentSessionId) return s;
        let title = s.title;
        if (s.messages.length === 0) {
          title = userMessage.length > 25 ? userMessage.substring(0, 25) + "..." : userMessage;
        }
        return {
          ...s,
          title,
          messages: [...s.messages, { role: "user" as const, content: userMessage, timestamp: Date.now() }],
        };
      })
    );

    try {
      const sc = currentSession.sessionConfig;
      const mergedConfig: AppConfig = {
        ...config,
        system_prompt: sc.systemPrompt || config.system_prompt,
        model: sc.model || config.model,
        temperature: sc.temperature,
        top_p: sc.topP,
        max_tokens: sc.maxTokens,
        streaming: sc.streaming,
        context_limit: sc.contextLimit,
        tools_enabled: webSearchEnabled
          ? [...config.tools_enabled.filter(t => t !== "web_search"), "web_search"]
          : config.tools_enabled.filter(t => t !== "web_search"),
      };
      await invoke("start_agent_session", {
        prompt: finalMessage,
        config: mergedConfig,
        sessionMessages,
        sessionMode: currentMode,
      });
    } catch (e) {
      setIsStreaming(false);
      addLog(`Agent error: ${e}`, "error");
      setPrompt(userMessage);
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== currentSessionId) return s;
          return {
            ...s,
            messages: [
              ...s.messages,
              { role: "assistant" as const, content: `Error: ${e}`, actions: [], timestamp: Date.now() },
            ],
          };
        })
      );
    }
  };

  const handleRetry = useCallback(async (msgIdx: number) => {
    if (isStreaming) return;
    const msgs = currentSession.messages;
    let userMsg = "";
    for (let i = msgIdx; i >= 0; i--) {
      if (msgs[i].role === "user") {
        userMsg = msgs[i].content;
        break;
      }
    }
    if (!userMsg) return;

    const existingMsg = msgs[msgIdx];
    const existingVariants = existingMsg.variants || [existingMsg.content];
    const newVariantIndex = existingVariants.length;

    setSessions(prev => prev.map(s => s.id === currentSessionId ? {
      ...s,
      messages: s.messages.map((m, i) => i === msgIdx ? {
        ...m,
        content: "",
        variants: existingVariants,
        currentVariantIndex: newVariantIndex,
        actions: undefined,
        reasoningContent: undefined,
      } : m)
    } : s));

    setIsStreaming(true);
    const sessionMessages = (() => {
      const slicedMsgs = msgs.slice(0, msgIdx);
      let lastDividerIdx = -1;
      for (let i = slicedMsgs.length - 1; i >= 0; i--) {
        if (slicedMsgs[i].role === "context_divider") {
          lastDividerIdx = i;
          break;
        }
      }
      const activeMsgs = lastDividerIdx >= 0 ? slicedMsgs.slice(lastDividerIdx + 1) : slicedMsgs;
      return activeMsgs
        .filter((m) => m.role !== "context_divider")
        .map((m) => ({
          role: m.role,
          content: m.variants ? (m.variants[m.currentVariantIndex || 0] || m.content) : m.content,
        }));
    })();
    try {
      const sc = currentSession.sessionConfig;
      const mergedConfig: AppConfig = {
        ...config,
        system_prompt: sc.systemPrompt || config.system_prompt,
        model: sc.model || config.model,
        temperature: sc.temperature,
        top_p: sc.topP,
        max_tokens: sc.maxTokens,
        streaming: sc.streaming,
        context_limit: sc.contextLimit,
        tools_enabled: webSearchEnabled
          ? [...config.tools_enabled.filter(t => t !== "web_search"), "web_search"]
          : config.tools_enabled.filter(t => t !== "web_search"),
      };
      await invoke("start_agent_session", {
        prompt: userMsg,
        config: mergedConfig,
        sessionMessages,
        sessionMode: currentMode,
      });
    } catch (e) {
      setIsStreaming(false);
      addLog(`Agent error: ${e}`, "error");
    }
  }, [isStreaming, currentSession, currentSessionId, config]);

  const handleApproval = async (approved: boolean, trustPattern: boolean = false) => {
    if (!pendingApprovals) return;
    const approvedIds = approved
      ? pendingApprovals.tool_calls.map((tc) => tc.id)
      : [];
    const rejectedIds = approved
      ? []
      : pendingApprovals.tool_calls.map((tc) => tc.id);

    try {
      await invoke("resolve_tool_approval", {
        requestId: pendingApprovals.request_id,
        approvedIds,
        rejectedIds,
      });

      // If approved with trust, add each tool call to the whitelist
      if (approved && trustPattern) {
        const now = Math.floor(Date.now() / 1000);
        const newPatterns: TrustedPattern[] = pendingApprovals.tool_calls.map((tc) => {
          let pattern = tc.name; // default: trust the whole tool
          if (tc.name === "execute_command") {
            // Extract the command prefix for more specific matching
            try {
              const args = JSON.parse(tc.arguments);
              const cmd = (args.command || "").trim();
              // Take the first token as the pattern
              const firstToken = cmd.split(/\s+/)[0] || cmd;
              pattern = firstToken;
            } catch {
              pattern = tc.name;
            }
          } else if (tc.name === "write_file") {
            try {
              const args = JSON.parse(tc.arguments);
              const path = (args.path || "").trim();
              // Trust the directory prefix
              const dir = path.replace(/[^/\\]+$/, "");
              pattern = dir || path;
            } catch {
              pattern = tc.name;
            }
          }
          return {
            tool_name: tc.name,
            pattern,
            created_at: now,
          };
        });

        try {
          const updatedConfig = await invoke<AppConfig>("add_trusted_patterns", {
            config,
            patterns: newPatterns,
          });
          setConfig(updatedConfig);
          addLog(`Added ${newPatterns.length} pattern(s) to whitelist`, "success");
        } catch (e) {
          addLog(`Failed to add whitelist patterns: ${e}`, "error");
        }
      }
    } catch (e) {
      addLog(`Approval error: ${e}`, "error");
    }
    setPendingApprovals(null);
  };

  const createNewSession = () => {
    const newId = `session-${Date.now()}`;
    setSessions((prev) => [
      ...prev,
      { id: newId, title: "", messages: [], sessionConfig: { ...DEFAULT_SESSION_CONFIG, mode: sidebarNav } },
    ]);
    setCurrentSessionId(newId);
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sessions.length <= 1) return;
    const target = sessions.find(s => s.id === id);
    if (!window.confirm(lang === "zh" ? `确定删除会话"${target?.title || "未命名"}"吗？` : `Delete session "${target?.title || "Untitled"}"?`)) return;
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    if (currentSessionId === id) {
      setCurrentSessionId(remaining[0].id);
    }
  };

  const toggleActionExpanded = (id: string) => {
    setExpandedActions((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleTool = (tool: string) => {
    setConfig((prev) => ({
      ...prev,
      tools_enabled: prev.tools_enabled.includes(tool)
        ? prev.tools_enabled.filter((t) => t !== tool)
        : [...prev.tools_enabled, tool],
    }));
  };

  const removeTrustedPattern = async (toolName: string, pattern: string) => {
    try {
      const updatedConfig = await invoke<AppConfig>("remove_trusted_pattern", {
        config,
        toolName,
        pattern,
      });
      setConfig(updatedConfig);
    } catch (e) {
      addLog(`Failed to remove whitelist pattern: ${e}`, "error");
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const statusIcon = (status: ToolAction["status"]) => {
    switch (status) {
      case "drafting":
      case "executing":
        return <Loader2 size={13} className="animate-spin" style={{ color: "var(--accent)" }} />;
      case "done":
        return <CheckCircle2 size={13} style={{ color: "var(--success)" }} />;
      case "blocked":
        return <XCircle size={13} style={{ color: "var(--error)" }} />;
      case "pending_approval":
        return <ShieldAlert size={13} style={{ color: "var(--warning)" }} />;
      default:
        return null;
    }
  };

  const statusLabel = (status: ToolAction["status"]) => {
    switch (status) {
      case "drafting": return t("status.parsing", lang);
      case "executing": return t("status.running", lang);
      case "done": return t("status.done", lang);
      case "blocked": return t("status.blocked", lang);
      case "pending_approval": return t("status.awaiting", lang);
      default: return status;
    }
  };

  // ==========================================
  // Render
  // ==========================================

  return (
    <div className="app-container">
      {/* ====== Sidebar ====== */}
      <aside className="sidebar" style={{ width: sidebarWidth }}>
        {/* Pill Navigation */}
        <div className="sidebar-nav-pills">
          <button
            className={`sidebar-pill ${sidebarNav === "chat" ? "active" : ""}`}
            onClick={() => setSidebarNav("chat")}
          >
            <MessageSquare size={12} /> Chat
          </button>
          <button
            className={`sidebar-pill ${sidebarNav === "code" ? "active" : ""}`}
            onClick={() => setSidebarNav("code")}
          >
            <TerminalIcon size={12} /> Code
          </button>
        </div>

        {/* New Session Button */}
        <div style={{ padding: "4px 10px" }}>
          <button className="btn sidebar-new-btn" onClick={createNewSession}>
            <Plus size={13} /> {t("session.new", lang)}
          </button>
        </div>

        {/* Session Search */}
        <div style={{ padding: "2px 10px 4px" }}>
          <div className="session-search-box">
            <Search size={12} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
            <input
              type="text"
              className="session-search-input"
              placeholder={lang === "zh" ? "搜索会话..." : "Search sessions..."}
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
            />
            {sessionSearch && (
              <button className="session-search-clear" onClick={() => setSessionSearch("")}>
                <X size={10} />
              </button>
            )}
          </div>
        </div>

        {/* Session List */}
        <div className="history-list">
          {sessions
            .filter((s) => (s.sessionConfig.mode || "chat") === sidebarNav)
            .filter((s) => {
              if (!debouncedSearch.trim()) return true;
              const q = debouncedSearch.toLowerCase();
              if ((s.title || "").toLowerCase().includes(q)) return true;
              const recentMsgs = s.messages.slice(-10);
              return recentMsgs.some(m => m.content.toLowerCase().includes(q));
            })
            .map((s) => {
              const activePreset = ALL_PRESETS.find(p => p.id === s.sessionConfig.activeRolePresetId);
              return (
            <div
              key={s.id}
              className={`history-item ${s.id === currentSessionId ? "active" : ""}`}
              onClick={() => setCurrentSessionId(s.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ sessionId: s.id, x: e.clientX, y: e.clientY });
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                {activePreset && (
                  <span className="history-preset-icon" title={`${t("role.activePreset", lang)}: ${lang === "zh" ? activePreset.nameZh : activePreset.name}`}>
                    {activePreset.emoji}
                  </span>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className="truncate" style={{ fontSize: "0.8rem", display: "block" }}>
                    {s.title || t("session.new", lang)}
                  </span>
                  <span className="history-meta">
                    {s.messages.filter(m => m.role !== "context_divider").length}{lang === "zh" ? "条" : " msgs"}
                    {s.messages.length > 0 && s.messages[s.messages.length - 1].timestamp && (
                      <> · {new Date(s.messages[s.messages.length - 1].timestamp!).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}</>
                    )}
                  </span>
                </div>
              </div>
              <span className="history-mode-tag" title={s.sessionConfig.mode === "code" ? t("mode.code", lang) : t("mode.chat", lang)}>
                {s.sessionConfig.mode === "code" ? <TerminalIcon size={10} /> : <MessageSquare size={10} />}
              </span>
            </div>
            );
          })}
          {sessions
            .filter((s) => (s.sessionConfig.mode || "chat") === sidebarNav)
            .filter((s) => {
              if (!debouncedSearch.trim()) return true;
              const q = debouncedSearch.toLowerCase();
              if ((s.title || "").toLowerCase().includes(q)) return true;
              const recentMsgs = s.messages.slice(-10);
              return recentMsgs.some(m => m.content.toLowerCase().includes(q));
            }).length === 0 && debouncedSearch.trim() && (
            <div className="search-empty-hint">
              {lang === "zh" ? "没有匹配的会话" : "No matching sessions"}
            </div>
          )}
        </div>

        {/* Context Menu */}
        {contextMenu && (
          <div
            className="context-menu"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 180),
              top: Math.min(contextMenu.y, window.innerHeight - 200),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const targetSession = sessions.find(s => s.id === contextMenu.sessionId);
              const hasPreset = targetSession?.sessionConfig.activeRolePresetId;
              return (
                <>
                  <button className="context-menu-item" onClick={() => {
                    setSessionSettingsOpen(true);
                    setCurrentSessionId(contextMenu.sessionId);
                    setContextMenu(null);
                  }}>
                    <Pencil size={12} /> {t("context.editPreset", lang)}
                  </button>
                  {hasPreset && (
                    <button className="context-menu-item" onClick={() => {
                      setSessions(prev => prev.map(s => s.id === contextMenu.sessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, activeRolePresetId: null, systemPrompt: "", temperature: 0.7 }
                      } : s));
                      setContextMenu(null);
                    }}>
                      <X size={12} /> {t("context.clearPreset", lang)}
                    </button>
                  )}
                  <button className="context-menu-item" onClick={() => {
                    const s = sessions.find(s => s.id === contextMenu.sessionId);
                    if (!s) return;
                    const md = s.messages
                      .filter((m) => m.role !== "context_divider")
                      .map((m) => {
                        const content = m.variants ? (m.variants[m.currentVariantIndex || 0] || m.content) : m.content;
                        if (m.role === "user") return `## User\n\n${content}`;
                        if (m.role === "assistant") return `## Assistant\n\n${content}`;
                        return content;
                      })
                      .join("\n\n---\n\n");
                    const blob = new Blob([`# ${s.title}\n\n${md}`], { type: "text/markdown" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${s.title || "chat"}.md`;
                    a.click();
                    URL.revokeObjectURL(url);
                    setContextMenu(null);
                  }}>
                    <Download size={12} /> {t("context.export", lang)}
                  </button>
                  <button className="context-menu-item" onClick={() => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = ".json,.md";
                    input.onchange = async () => {
                      if (!input.files?.[0]) return;
                      try {
                        const text = await input.files[0].text();
                        if (input.files[0].name.endsWith(".json")) {
                          const imported = JSON.parse(text);
                          if (imported.messages && Array.isArray(imported.messages)) {
                            const newId = `session-${Date.now()}`;
                            setSessions(prev => [...prev, {
                              id: newId,
                              title: imported.title || input.files![0].name,
                              messages: imported.messages,
                              sessionConfig: imported.sessionConfig || { ...DEFAULT_SESSION_CONFIG },
                            }]);
                            setCurrentSessionId(newId);
                          }
                        } else {
                          const sections = text.split(/\n\n---\n\n/);
                          const msgs: { role: "user" | "assistant"; content: string; timestamp?: number }[] = [];
                          for (const section of sections) {
                            const lines = section.trim();
                            if (lines.startsWith("## User")) {
                              msgs.push({ role: "user", content: lines.replace(/^## User\n\n/, ""), timestamp: Date.now() });
                            } else if (lines.startsWith("## Assistant")) {
                              msgs.push({ role: "assistant", content: lines.replace(/^## Assistant\n\n/, ""), timestamp: Date.now() });
                            }
                          }
                          if (msgs.length > 0) {
                            const newId = `session-${Date.now()}`;
                            const titleMatch = text.match(/^# (.+)/m);
                            setSessions(prev => [...prev, {
                              id: newId,
                              title: titleMatch ? titleMatch[1] : input.files![0].name,
                              messages: msgs,
                              sessionConfig: { ...DEFAULT_SESSION_CONFIG },
                            }]);
                            setCurrentSessionId(newId);
                          }
                        }
                      } catch (e) {
                        addLog(`${lang === "zh" ? "导入失败" : "Import failed"}: ${e}`, "error");
                      }
                    };
                    input.click();
                    setContextMenu(null);
                  }}>
                    <Upload size={12} /> {t("context.import", lang)}
                  </button>
                  <button className="context-menu-item" onClick={() => {
                    const s = sessions.find(s => s.id === contextMenu.sessionId);
                    if (!s) return;
                    const newTitle = window.prompt(lang === "zh" ? "重命名会话:" : "Rename session:", s.title);
                    if (newTitle !== null && newTitle.trim()) {
                      setSessions(prev => prev.map(sess => sess.id === contextMenu.sessionId ? { ...sess, title: newTitle.trim() } : sess));
                    }
                    setContextMenu(null);
                  }}>
                    <Pencil size={12} /> {t("context.rename", lang)}
                  </button>
                  <button className="context-menu-item" onClick={() => {
                    const idx = sessions.findIndex(s => s.id === contextMenu.sessionId);
                    if (idx > 0) {
                      setSessions(prev => {
                        const arr = [...prev];
                        [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
                        return arr;
                      });
                    }
                    setContextMenu(null);
                  }}>
                    <ChevronLeft size={12} style={{ transform: "rotate(90deg)" }} /> {t("context.moveUp", lang)}
                  </button>
                  <button className="context-menu-item" onClick={() => {
                    const idx = sessions.findIndex(s => s.id === contextMenu.sessionId);
                    if (idx < sessions.length - 1) {
                      setSessions(prev => {
                        const arr = [...prev];
                        [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
                        return arr;
                      });
                    }
                    setContextMenu(null);
                  }}>
                    <ChevronRight size={12} style={{ transform: "rotate(90deg)" }} /> {t("context.moveDown", lang)}
                  </button>
                  {sessions.length > 1 && (
                    <button className="context-menu-item context-menu-item-danger" onClick={() => {
                      deleteSession(contextMenu.sessionId, { stopPropagation: () => {} } as React.MouseEvent);
                      setContextMenu(null);
                    }}>
                      <Trash2 size={12} /> {t("context.delete", lang)}
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Sidebar Footer */}
        <div className="sidebar-footer">
          <div className="sidebar-tools-label">{t("tools.active", lang)}</div>
          <div className="sidebar-tools-grid">
            {TOOL_NAMES.map((t) => (
              <button
                key={t.key}
                onClick={() => toggleTool(t.key)}
                className={`tool-toggle ${config.tools_enabled.includes(t.key) ? "active" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* Profile Card */}
          <div className="sidebar-profile-card">
            <div className="sidebar-profile-avatar">
              {config.model ? getModelDisplayName(config.model).charAt(0).toUpperCase() : "G"}
            </div>
            <div className="sidebar-profile-info">
              <span className="sidebar-profile-name">{getModelDisplayName(config.model) || "gxAgent"}</span>
              <span className="sidebar-profile-meta">
                {config.base_url.replace(/^https?:\/\//, "").split("/")[0]}
              </span>
            </div>
            <button className="panel-toggle-btn" onClick={() => setSettingsOpen(true)} title={t("settings.title", lang)}>
              <Settings size={13} />
            </button>
          </div>
        </div>
      </aside>

      {/* Sidebar resize handle */}
      <div
        className={`resize-divider ${draggingSidebar ? "dragging" : ""}`}
        onMouseDown={handleSidebarDrag}
      />

      {/* ====== Main Workspace ====== */}
      <div className="workspace-container">
        {/* LEFT: Chat */}
        <section className="chat-panel">
          <header className="panel-header">
            <div>
              <span className="panel-title" style={{ fontSize: "0.82rem" }}>
                {currentSession.title || t("session.new", lang)}
              </span>
              {config.default_work_dir && (
                <div className="panel-subtitle">{config.default_work_dir}</div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={`mode-indicator ${currentMode}`}>
                {currentMode === "chat" ? <MessageSquare size={11} /> : <TerminalIcon size={11} />}
                {currentMode === "chat" ? t("mode.chat", lang) : t("mode.code", lang)}
              </span>
              <div className="model-indicator">
                <span className="model-dot" />
                {getModelDisplayName(currentSession.sessionConfig.model || config.model)}
              </div>
              {usageStats && (
                <div className="usage-badge">
                  <span className="usage-item" title={`${t("usage.prompt", lang)}: ${usageStats.promptTokens}`}>
                    {t("usage.prompt", lang)} {usageStats.promptTokens}
                  </span>
                  <span className="usage-sep">/</span>
                  <span className="usage-item" title={`${t("usage.completion", lang)}: ${usageStats.completionTokens}`}>
                    {usageStats.completionTokens}
                  </span>
                  <span className="usage-sep">|</span>
                  <span className="usage-item" title={t("usage.ttft", lang)}>
                    {usageStats.ttftMs}ms
                  </span>
                  <span className="usage-sep">|</span>
                  <span className="usage-item" title={t("usage.responseTime", lang)}>
                    {usageStats.responseTimeMs >= 1000 ? `${(usageStats.responseTimeMs / 1000).toFixed(1)}s` : `${usageStats.responseTimeMs}ms`}
                  </span>
                </div>
              )}
              <button
                className="panel-toggle-btn"
                onClick={toggleTheme}
                title="Toggle theme"
              >
                {config.theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
              </button>
              <button
                className="panel-toggle-btn"
                onClick={() => setSessionSettingsOpen(!sessionSettingsOpen)}
                title={t("session.settings", lang)}
              >
                <Settings2 size={14} />
              </button>
              <button
                className="panel-toggle-btn"
                onClick={() => setRightPanelOpen(!rightPanelOpen)}
                title={rightPanelOpen ? "Close panel" : "Open panel"}
              >
                {rightPanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
              </button>
              <button
                className={`panel-toggle-btn ${alwaysOnTop ? "active" : ""}`}
                onClick={async () => {
                  const result = await invoke<boolean>("toggle_always_on_top");
                  setAlwaysOnTop(result);
                }}
                title={alwaysOnTop ? t("window.unpin", lang) : t("window.pin", lang)}
              >
                <Pin size={14} />
              </button>
            </div>
          </header>

          {/* Session Settings Panel */}
          {sessionSettingsOpen && (
            <div className="session-settings-panel">
              <div className="session-settings-header">
                <span style={{ fontWeight: 600, fontSize: "0.82rem" }}>{t("session.settings", lang)}</span>
                <button className="panel-toggle-btn" onClick={() => setSessionSettingsOpen(false)}>
                  <X size={14} />
                </button>
              </div>
              <div className="session-settings-body">
                {/* Name */}
                <label className="session-field">
                  <span className="session-label">{t("session.name", lang)}</span>
                  <input
                    className="session-input"
                    value={currentSession.title}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, title: e.target.value } : s));
                    }}
                  />
                </label>
                {/* System Prompt */}
                <label className="session-field">
                  <span className="session-label">{t("session.systemPrompt", lang)}</span>
                  <textarea
                    className="session-textarea"
                    rows={3}
                    value={currentSession.sessionConfig.systemPrompt}
                    placeholder={config.system_prompt}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, systemPrompt: e.target.value }
                      } : s));
                    }}
                  />
                </label>
                {/* Model */}
                <label className="session-field">
                  <span className="session-label">{t("session.model", lang)}</span>
                  <select
                    className="session-select"
                    value={currentSession.sessionConfig.model || config.model}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, model: e.target.value }
                      } : s));
                    }}
                  >
                    {Object.values(config.profiles).map((p) => (
                      <option key={p.name} value={p.default_model}>{p.name} ({p.default_model})</option>
                    ))}
                    {models.length > 0 && (
                      <optgroup label={lang === "zh" ? "模型" : "Available Models"}>
                        {models.filter(m => !Object.values(config.profiles).some(p => p.default_model === m.id)).map((m) => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </optgroup>
                    )}
                    {!Object.values(config.profiles).some(p => p.default_model === config.model) && models.length === 0 && (
                      <option value={config.model}>{config.model}</option>
                    )}
                  </select>
                </label>
                {/* Context Limit */}
                <label className="session-field">
                  <span className="session-label">{t("session.contextLimit", lang)}</span>
                  <input
                    type="number"
                    className="session-input session-input-sm"
                    min={1}
                    max={200}
                    value={currentSession.sessionConfig.contextLimit}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, contextLimit: parseInt(e.target.value) || 50 }
                      } : s));
                    }}
                  />
                </label>
                {/* Temperature */}
                <label className="session-field">
                  <span className="session-label">{t("session.temperature", lang)}: {currentSession.sessionConfig.temperature}</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={currentSession.sessionConfig.temperature}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, temperature: parseFloat(e.target.value) }
                      } : s));
                    }}
                  />
                </label>
                {/* Top P */}
                <label className="session-field">
                  <span className="session-label">{t("session.topP", lang)}: {currentSession.sessionConfig.topP}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={currentSession.sessionConfig.topP}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, topP: parseFloat(e.target.value) }
                      } : s));
                    }}
                  />
                </label>
                {/* Max Tokens */}
                <label className="session-field">
                  <span className="session-label">{t("session.maxTokens", lang)}</span>
                  <input
                    type="number"
                    className="session-input session-input-sm"
                    min={1}
                    placeholder="∞"
                    value={currentSession.sessionConfig.maxTokens ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, maxTokens: v ? parseInt(v) : null }
                      } : s));
                    }}
                  />
                </label>
                {/* Streaming */}
                <label className="session-field session-field-row">
                  <span className="session-label">{t("session.streaming", lang)}</span>
                  <input
                    type="checkbox"
                    checked={currentSession.sessionConfig.streaming}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, streaming: e.target.checked }
                      } : s));
                    }}
                  />
                </label>
                {/* Thinking Level */}
                <label className="session-field">
                  <span className="session-label">{t("session.thinkingLevel", lang)}</span>
                  <div className="session-btn-group">
                    {(["low", "medium", "high"] as const).map(level => (
                      <button
                        key={level}
                        className={`session-btn ${currentSession.sessionConfig.thinkingLevel === level ? "active" : ""}`}
                        onClick={() => {
                          setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                            ...s,
                            sessionConfig: { ...s.sessionConfig, thinkingLevel: level }
                          } : s));
                        }}
                      >
                        {t(`session.thinking${level.charAt(0).toUpperCase() + level.slice(1)}`, lang)}
                      </button>
                    ))}
                  </div>
                </label>
                {/* Background Image */}
                <label className="session-field">
                  <span className="session-label">{t("session.backgroundImage", lang)}</span>
                  <input
                    className="session-input"
                    placeholder="URL or path"
                    value={currentSession.sessionConfig.backgroundImage}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, backgroundImage: e.target.value }
                      } : s));
                    }}
                  />
                </label>
                {/* Reset */}
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: 8, width: "100%" }}
                  onClick={() => {
                    setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                      ...s,
                      sessionConfig: { ...DEFAULT_SESSION_CONFIG }
                    } : s));
                  }}
                >
                  {t("session.reset", lang)}
                </button>
              </div>
            </div>
          )}

          <div className="chat-messages" ref={chatContainerRef} onScroll={() => {
            const el = chatContainerRef.current;
            if (!el) return;
            isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }} style={currentSession.sessionConfig.backgroundImage ? { backgroundImage: `url(${currentSession.sessionConfig.backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
            {currentSession.messages.length === 0 ? (
              <div className="preview-placeholder">
                <div className="welcome-icon" style={{ display: "flex", justifyContent: "center" }}>
                  <img src={CaturtleLogo} alt="Agent Logo" width="80" height="80" style={{ marginBottom: "16px", opacity: 0.95 }} />
                </div>
                <h2 className="welcome-title">{t("welcome.title", lang)}</h2>
                <p className="welcome-desc">{t("welcome.desc", lang)}</p>
                <div className="shortcuts-hint">
                  <span className="shortcut-tag"><kbd>Ctrl+N</kbd> {lang === "zh" ? "新建" : "New"}</span>
                  <span className="shortcut-tag"><kbd>Ctrl+,</kbd> {lang === "zh" ? "设置" : "Settings"}</span>
                  <span className="shortcut-tag"><kbd>Ctrl+Shift+N</kbd> {lang === "zh" ? "切换模式" : "Mode"}</span>
                  <span className="shortcut-tag"><kbd>Esc</kbd> {lang === "zh" ? "关闭" : "Close"}</span>
                </div>
              </div>
            ) : (
              currentSession.messages.map((msg, mIdx) => (
                msg.role === "context_divider" ? (
                  <div key={mIdx} className="context-divider">
                    <div className="context-divider-line" />
                    <span className="context-divider-label">{lang === "zh" ? "上方上下文已忽略" : "Context Ignored Above"}</span>
                    <div className="context-divider-line" />
                    <button
                      className="context-divider-remove"
                      onClick={() => {
                        setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                          ...s,
                          messages: s.messages.filter((_, i) => i !== mIdx)
                        } : s));
                      }}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ) : (
                <div key={mIdx} className={`chat-bubble-container ${msg.role}`}>
                  {editingMessageIdx === mIdx ? (
                    <div className="edit-message-container">
                      <textarea
                        className="edit-message-textarea"
                        value={editText}
                        onChange={(e) => {
                          setEditText(e.target.value);
                          e.target.style.height = "auto";
                          e.target.style.height = Math.max(e.target.scrollHeight, 80) + "px";
                        }}
                        ref={(el) => {
                          if (el) {
                            el.style.height = "auto";
                            el.style.height = Math.max(el.scrollHeight, 80) + "px";
                          }
                        }}
                        autoFocus
                      />
                      <div className="edit-message-actions">
                        <button className="btn btn-primary btn-sm" onClick={() => {
                          setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                            ...s,
                            messages: s.messages.map((m, i) => i === mIdx ? { ...m, content: editText } : m)
                          } : s));
                          setEditingMessageIdx(null);
                        }}>{t("msg.edit", lang)}</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingMessageIdx(null)}>{lang === "zh" ? "取消" : "Cancel"}</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="chat-bubble">
                        {msg.role === "assistant" ? (
                          <>
                            {/* Tool actions — rendered BEFORE content, in order */}
                            {msg.actions?.map((act, aIdx) => (
                              <div key={aIdx} className={`agent-action-card ${act.status}`}>
                                <div
                                  className="agent-action-header"
                                  onClick={() => toggleActionExpanded(act.id)}
                                >
                                  <div className="agent-action-title">
                                    {statusIcon(act.status)}
                                    <span>{act.name}</span>
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                    <span className={`agent-action-badge ${act.status}`}>
                                      {statusLabel(act.status)}
                                    </span>
                                    {expandedActions[act.id] ? (
                                      <ChevronDown size={12} style={{ color: "var(--text-tertiary)" }} />
                                    ) : (
                                      <ChevronRight size={12} style={{ color: "var(--text-tertiary)" }} />
                                    )}
                                  </div>
                                </div>

                                {expandedActions[act.id] && (
                                  <div className="agent-action-body">
                                    <div style={{ fontSize: "0.65rem", color: "var(--accent)", fontWeight: 700, marginBottom: 3 }}>
                                      {t("action.arguments", lang)}:
                                    </div>
                                    <pre className="tool-arguments">
                                      <code>{act.arguments}</code>
                                    </pre>
                                    {act.output && (
                                      <>
                                        <div style={{ fontSize: "0.65rem", color: "var(--success)", fontWeight: 700, marginTop: 6, marginBottom: 3 }}>
                                          {t("action.output", lang)}:
                                        </div>
                                        <pre className="tool-output">
                                          <code>{act.output}</code>
                                        </pre>
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}

                            {/* Search status indicators */}
                            {msg.searchStatus && msg.searchStatus.length > 0 && (
                              <div className="search-status-list">
                                {msg.searchStatus.map((ss, ssIdx) => {
                                  if (ss.type === "searching") {
                                    return (
                                      <div key={ssIdx} className="search-status searching">
                                        🔍 Searching: {ss.query}...
                                      </div>
                                    );
                                  }
                                  if (ss.type === "error") {
                                    return (
                                      <div key={ssIdx} className="search-status search-error">
                                        ⚠️ {ss.message} (took {ss.duration?.toFixed(1)}s)
                                      </div>
                                    );
                                  }
                                  if (ss.type === "results") {
                                    return (
                                      <details key={ssIdx} className="search-results">
                                        <summary>📋 Search results (took {ss.duration?.toFixed(1)}s)</summary>
                                        <div className="search-results-content">{ss.results}</div>
                                      </details>
                                    );
                                  }
                                  return null;
                                })}
                              </div>
                            )}

                            {/* Reasoning chain (DeepSeek-R1, etc.) */}
                            {msg.reasoningContent && (
                              <details className="reasoning-chain" open={!msg.content}>
                                <summary className="reasoning-chain-summary">
                                  <span className="reasoning-chain-icon">&#128161;</span>
                                  {t("reasoning.label", lang)}
                                  {msg.reasoningContent && !msg.content && (
                                    <span className="reasoning-chain-typing"> ...</span>
                                  )}
                                </summary>
                                <div className="reasoning-chain-content">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {msg.reasoningContent}
                                  </ReactMarkdown>
                                </div>
                              </details>
                            )}

                            {/* Markdown content — rendered AFTER tool actions */}
                            <div className="md-content">
                              <ReactMarkdown
                                remarkPlugins={[remarkGfm, remarkMath]}
                                rehypePlugins={[rehypeKatex]}
                                components={{
                                  code({ className, children, ...props }) {
                                    const match = /language-(\w+)/.exec(className || "");
                                    const isBlock = (className || "").includes("language-");
                                    const codeStr = String(children).replace(/\n$/, "");
                                    if (isBlock) {
                                      const codeLang = match ? match[1] : "text";
                                      if (codeLang === "mermaid") {
                                        return <MermaidDiagram chart={codeStr} />;
                                      }
                                      return (
                                        <div className="code-block">
                                          <div className="code-block-header">
                                            <span className="code-lang-label" onClick={() => { navigator.clipboard.writeText(codeStr); setCopiedCodeId(`${mIdx}-${codeLang}`); setTimeout(() => setCopiedCodeId(null), 1500); }} title={t("code.copy", lang)}>{copiedCodeId === `${mIdx}-${codeLang}` ? (lang === "zh" ? "已复制!" : "Copied!") : codeLang}</span>
                                            <div className="code-block-actions">
                                              <button
                                                className="code-action-btn"
                                                title={t("code.copy", lang)}
                                                onClick={() => {
                                                  navigator.clipboard.writeText(codeStr);
                                                  setCopiedCodeId(`${mIdx}-${codeLang}`);
                                                  setTimeout(() => setCopiedCodeId(null), 1500);
                                                }}
                                              >
                                                {copiedCodeId === `${mIdx}-${codeLang}` ? <Check size={12} /> : <Copy size={12} />}
                                              </button>
                                              <button
                                                className="code-action-btn"
                                                title={t("code.save", lang)}
                                                onClick={() => {
                                                  invoke("save_code_file", { content: codeStr, language: codeLang });
                                                }}
                                              >
                                                <Save size={12} />
                                              </button>
                                            </div>
                                          </div>
                                          <SyntaxHighlighter
                                            language={codeLang}
                                            style={oneDark}
                                            customStyle={{
                                              margin: 0,
                                              borderRadius: "0 0 6px 6px",
                                              fontSize: "0.78rem",
                                              padding: "10px 12px",
                                            }}
                                          >
                                            {codeStr}
                                          </SyntaxHighlighter>
                                        </div>
                                      );
                                    }
                                    return <code className={className} {...props}>{children}</code>;
                                  },
                                }}
                              >
                                {msg.content}
                              </ReactMarkdown>
                              {isStreaming && mIdx === currentSession.messages.length - 1 && msg.role === "assistant" && (
                                <span className="typing-cursor" />
                              )}
                            </div>

                            {/* Inline approval card */}
                            {pendingApprovals &&
                              msg.actions?.some((a) =>
                                pendingApprovals.tool_calls.some((tc) => tc.id === a.id)
                              ) && (
                                <div className="approval-card">
                                  <div className="approval-card-header">
                                    <ShieldAlert size={14} />
                                    <span>{t("approval.title", lang)}</span>
                                  </div>
                                  {pendingApprovals.tool_calls.map((tc) => (
                                    <div key={tc.id} className="approval-item">
                                      <span style={{ fontWeight: 600, color: "var(--accent)", fontSize: "0.8rem" }}>{tc.name}</span>
                                      <pre style={{ fontSize: "0.72rem", color: "var(--text-secondary)", marginTop: 3, whiteSpace: "pre-wrap" }}>
                                        {tc.arguments}
                                      </pre>
                                    </div>
                                  ))}
                                  <div className="approval-actions">
                                    <button className="btn btn-approve" onClick={() => handleApproval(true)}>
                                      <CheckCircle2 size={13} /> {t("approval.approve", lang)}
                                    </button>
                                    <button className="btn btn-approve-trust" onClick={() => handleApproval(true, true)} title={t("approval.trustHint", lang)}>
                                      <ShieldAlert size={13} /> {t("approval.approveAndTrust", lang)}
                                    </button>
                                    <button className="btn btn-reject" onClick={() => handleApproval(false)}>
                                      <XCircle size={13} /> {t("approval.reject", lang)}
                                    </button>
                                  </div>
                                </div>
                              )}
                          </>
                        ) : (
                          msg.content
                        )}
                        {/* Hover action buttons */}
                        <div className="bubble-actions">
                          {msg.role === "assistant" && (
                            <button
                              className="bubble-action-btn"
                              title={t("msg.retry", lang)}
                              onClick={() => handleRetry(mIdx)}
                            >
                              <RotateCcw size={12} />
                            </button>
                          )}
                          <button
                            className="bubble-action-btn"
                            title={t("msg.edit", lang)}
                            onClick={() => {
                              setEditingMessageIdx(mIdx);
                              setEditText(msg.content);
                            }}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            className="bubble-action-btn"
                            title={t("msg.copy", lang)}
                            onClick={() => {
                              navigator.clipboard.writeText(msg.content);
                            }}
                          >
                            <Copy size={12} />
                          </button>
                          <button
                            className="bubble-action-btn"
                            title={t("msg.delete", lang)}
                            onClick={() => {
                              setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                                ...s,
                                messages: s.messages.filter((_, i) => i !== mIdx)
                              } : s));
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                      {msg.role === "assistant" && msg.variants && msg.variants.length > 1 && (
                        <div className="variant-nav">
                          <button
                            className="variant-nav-btn"
                            disabled={(msg.currentVariantIndex || 0) === 0}
                            onClick={() => {
                              const newIdx = Math.max(0, (msg.currentVariantIndex || 0) - 1);
                              setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                                ...s,
                                messages: s.messages.map((m, i) => i === mIdx ? {
                                  ...m,
                                  currentVariantIndex: newIdx,
                                  content: m.variants![newIdx],
                                } : m)
                              } : s));
                            }}
                          >
                            <ChevronLeft size={10} />
                          </button>
                          <span className="variant-nav-label">
                            {(msg.currentVariantIndex || 0) + 1} / {msg.variants.length}
                          </span>
                          <button
                            className="variant-nav-btn"
                            disabled={(msg.currentVariantIndex || 0) >= msg.variants.length - 1}
                            onClick={() => {
                              const newIdx = Math.min(msg.variants!.length - 1, (msg.currentVariantIndex || 0) + 1);
                              setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                                ...s,
                                messages: s.messages.map((m, i) => i === mIdx ? {
                                  ...m,
                                  currentVariantIndex: newIdx,
                                  content: m.variants![newIdx],
                                } : m)
                              } : s));
                            }}
                          >
                            <ChevronRight size={10} />
                          </button>
                        </div>
                      )}
                      {msg.timestamp && (
                        <div className="bubble-timestamp">
                          {new Date(msg.timestamp).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      )}
                    </>
                  )}
                </div>
                )
              ))
            )}

            {isStreaming &&
              currentSession.messages[currentSession.messages.length - 1]?.role !== "assistant" && (
                <div className="chat-bubble-container assistant">
                  <div className="chat-bubble" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div className="loading-indicator">
                      <span className="loading-dot" />
                      <span className="loading-dot" />
                      <span className="loading-dot" />
                    </div>
                    <span style={{ fontSize: "0.8rem", color: "var(--accent)" }}>{t("thinking", lang)}</span>
                  </div>
                </div>
              )}

            <div ref={chatEndRef} />
          </div>

          <div
            className={`chat-input-wrapper ${dragOver ? "drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragOver(false);
              const files = Array.from(e.dataTransfer.files);
              for (const file of files) {
                if (file.type.startsWith("image/")) {
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const base64 = ev.target?.result as string;
                    setAttachments((prev) => [...prev, { name: file.name, type: "image", data: base64 }]);
                  };
                  reader.readAsDataURL(file);
                } else {
                  const text = await file.text();
                  setAttachments((prev) => [...prev, { name: file.name, type: "text", data: text.substring(0, 50000) }]);
                }
              }
            }}
          >
            {dragOver && (
              <div className="drag-overlay">{t("attach.drop", lang)}</div>
            )}
            {attachments.length > 0 && (
              <div className="attachments-bar">
                {attachments.map((att, i) => (
                  <div key={i} className="attachment-chip">
                    {att.type === "image" ? <ImageIcon size={11} /> : <FileText size={11} />}
                    <span className="attachment-name">{att.name}</span>
                    <button className="attachment-remove" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}>
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={`chat-input-container${isStreaming && currentMode === "code" ? " steering-active" : ""}`}>
              <textarea
                ref={chatTextareaRef}
                className="chat-textarea"
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 240) + "px";
                }}
                onKeyDown={handleKeyPress}
                placeholder={isStreaming && currentMode === "code" ? t("input.steering", lang) : `${t("input.placeholder", lang)} (Shift+Enter ${lang === "zh" ? "换行" : "newline"})`}
                disabled={isStreaming && currentMode === "chat"}
                rows={1}
              />
              <div className="chat-input-toolbar">
                <div className="chat-input-toolbar-left">
                  <button
                    className="btn btn-icon input-attach-btn"
                    title={t("role.title", lang)}
                    onClick={() => setRolePresetsOpen(!rolePresetsOpen)}
                  >
                    <Sparkles size={16} />
                  </button>
              {rolePresetsOpen && (
                <div className="role-presets-panel">
                  <div className="role-presets-header">
                    <span>{lang === "zh" ? "角色预设" : "Role Presets"}</span>
                    <button className="role-presets-close" onClick={() => { setRolePresetsOpen(false); setCustomPresetForm(false); setEditingCustomPreset(null); }}>
                      <X size={12} />
                    </button>
                  </div>
                  {currentSession.sessionConfig.activeRolePresetId && (() => {
                    const ap = ALL_PRESETS.find(p => p.id === currentSession.sessionConfig.activeRolePresetId);
                    return ap ? (
                      <div className="role-active-indicator">
                        <span>{ap.emoji}</span>
                        <span>{lang === "zh" ? ap.nameZh : ap.name}</span>
                        <button className="role-active-clear" onClick={() => {
                          setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                            ...s,
                            sessionConfig: { ...s.sessionConfig, activeRolePresetId: null, systemPrompt: "", temperature: 0.7 }
                          } : s));
                        }}>
                          <X size={10} />
                        </button>
                      </div>
                    ) : null;
                  })()}
                  {ROLE_CATEGORIES.map((cat) => (
                    <div key={cat}>
                      <div className="role-presets-category">{cat}</div>
                      <div className="role-presets-grid">
                        {ROLE_PRESETS.filter((r) => r.category === cat).map((role) => (
                          <button
                            key={role.id}
                            className={`role-preset-card ${currentSession.sessionConfig.activeRolePresetId === role.id ? "active" : ""}`}
                            onClick={() => {
                              setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                                ...s,
                                sessionConfig: {
                                  ...s.sessionConfig,
                                  systemPrompt: role.prompt,
                                  temperature: role.temperature,
                                  activeRolePresetId: role.id,
                                }
                              } : s));
                              setRolePresetsOpen(false);
                              addLog(lang === "zh" ? `已应用角色: ${role.nameZh}` : `Applied role: ${role.name}`, "info");
                            }}
                          >
                            <span className="role-preset-emoji">{role.emoji}</span>
                            <span className="role-preset-name">{lang === "zh" ? role.nameZh : role.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {customPresets.length > 0 && (
                    <div>
                      <div className="role-presets-category">{t("role.custom", lang)}</div>
                      <div className="role-presets-grid">
                        {customPresets.map((role) => (
                          <div key={role.id} className="role-preset-card-wrapper">
                            <button
                              className={`role-preset-card ${currentSession.sessionConfig.activeRolePresetId === role.id ? "active" : ""}`}
                              onClick={() => {
                                setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                                  ...s,
                                  sessionConfig: {
                                    ...s.sessionConfig,
                                    systemPrompt: role.prompt,
                                    temperature: role.temperature,
                                    activeRolePresetId: role.id,
                                  }
                                } : s));
                                setRolePresetsOpen(false);
                                addLog(lang === "zh" ? `已应用角色: ${role.nameZh}` : `Applied role: ${role.name}`, "info");
                              }}
                            >
                              <span className="role-preset-emoji">{role.emoji}</span>
                              <span className="role-preset-name">{lang === "zh" ? role.nameZh : role.name}</span>
                            </button>
                            <div className="role-preset-card-actions">
                              <button className="role-preset-action-btn" title={t("msg.edit", lang)} onClick={(e) => { e.stopPropagation(); setEditingCustomPreset(role); setCustomPresetForm(true); }}>
                                <Pencil size={10} />
                              </button>
                              <button className="role-preset-action-btn role-preset-action-btn-danger" title={t("msg.delete", lang)} onClick={(e) => { e.stopPropagation(); setCustomPresets(prev => prev.filter(p => p.id !== role.id)); }}>
                                <Trash2 size={10} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {!customPresetForm ? (
                    <button className="role-preset-add-btn" onClick={() => { setCustomPresetForm(true); setEditingCustomPreset(null); }}>
                      <PlusCircle size={14} /> {t("role.custom", lang)}
                    </button>
                  ) : (
                    <CustomPresetForm
                      lang={lang}
                      editingPreset={editingCustomPreset}
                      onSave={(preset) => {
                        setCustomPresets(prev => {
                          const exists = prev.find(p => p.id === preset.id);
                          if (exists) {
                            return prev.map(p => p.id === preset.id ? preset : p);
                          }
                          return [...prev, preset];
                        });
                        setCustomPresetForm(false);
                        setEditingCustomPreset(null);
                      }}
                      t={t}
                    />
                  )}
                </div>
              )}
              <button
                className="btn btn-icon input-attach-btn"
                title={t("attach.drop", lang)}
                onClick={() => {
                  // Trigger file input
                  const input = document.createElement("input");
                  input.type = "file";
                  input.multiple = true;
                  input.onchange = async () => {
                    if (!input.files) return;
                    for (const file of Array.from(input.files)) {
                      if (file.type.startsWith("image/")) {
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                          const base64 = ev.target?.result as string;
                          setAttachments((prev) => [...prev, { name: file.name, type: "image", data: base64 }]);
                        };
                        reader.readAsDataURL(file);
                      } else {
                        const text = await file.text();
                        setAttachments((prev) => [...prev, { name: file.name, type: "text", data: text.substring(0, 50000) }]);
                      }
                    }
                  };
                  input.click();
                }}
              >
                <Plus size={14} />
              </button>
                  <button
                    className="input-icon-btn"
                    title={t("context.isolate", lang)}
                    onClick={() => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        messages: [...s.messages, { role: "context_divider" as const, content: "" }]
                      } : s));
                    }}
                  >
                    <Type size={12} />
                  </button>
                  <button
                    className={`input-icon-btn ${webSearchEnabled ? "active" : ""}`}
                    title={t("search.toggle", lang)}
                    onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                  >
                    <Globe size={12} />
                    {webSearchEnabled && <span className="search-active-dot" />}
                  </button>
                </div>
                <div className="chat-input-toolbar-right">
                <div style={{ position: "relative" }}>
                  <button
                    className="input-model-btn"
                    onClick={() => setModelPickerOpen(!modelPickerOpen)}
                    title={t("session.model", lang)}
                  >
                    {getModelDisplayName(currentSession.sessionConfig.model || config.model)}
                    <ChevronDown size={9} />
                  </button>
                  {modelPickerOpen && (
                    <div className="model-picker-dropdown">
                      {Object.values(config.profiles).map((p) => (
                        <button
                          key={p.name}
                          className={`model-picker-item ${currentSession.sessionConfig.model === p.default_model ? "active" : ""}`}
                          onClick={() => {
                            cacheModelDisplayName(p.default_model, p.name);
                            setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                              ...s,
                              sessionConfig: { ...s.sessionConfig, model: p.default_model }
                            } : s));
                            setModelPickerOpen(false);
                          }}
                        >
                          {p.name}
                          <span className="model-picker-tag">{p.default_model}</span>
                        </button>
                      ))}
                      {models.filter(m => !Object.values(config.profiles).some(p => p.default_model === m.id)).length > 0 && (
                        <>
                          <div className="model-picker-divider">{lang === "zh" ? "其他模型" : "Other Models"}</div>
                          {models.filter(m => !Object.values(config.profiles).some(p => p.default_model === m.id)).map((m) => (
                            <button
                              key={m.id}
                              className={`model-picker-item ${currentSession.sessionConfig.model === m.id ? "active" : ""}`}
                              onClick={() => {
                                setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                                  ...s,
                                  sessionConfig: { ...s.sessionConfig, model: m.id }
                                } : s));
                                setModelPickerOpen(false);
                              }}
                            >
                              {m.id}
                            </button>
                          ))}
                        </>
                      )}
                      {!Object.values(config.profiles).some(p => p.default_model === config.model) && !models.some(m => m.id === config.model) && (
                        <button
                          className={`model-picker-item ${!currentSession.sessionConfig.model || currentSession.sessionConfig.model === config.model ? "active" : ""}`}
                          onClick={() => {
                            setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                              ...s,
                              sessionConfig: { ...s.sessionConfig, model: config.model }
                            } : s));
                            setModelPickerOpen(false);
                          }}
                        >
                          {getModelDisplayName(config.model)}
                          <span className="model-picker-tag">Default</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-primary btn-icon input-send-btn"
                  onClick={isStreaming && currentMode === "code" ? async () => {
                    if (!prompt.trim()) return;
                    try {
                      await invoke("push_steering_message", { message: prompt.trim() });
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        messages: [...s.messages, { role: "user" as const, content: `🔧 ${prompt.trim()}` }]
                      } : s));
                      setPrompt("");
                      addLog(lang === "zh" ? "干预指令已发送" : "Steering message sent", "info");
                    } catch (e) {
                      addLog(`Steering error: ${e}`, "error");
                    }
                  } : handleSendMessage}
                  disabled={isStreaming && currentMode === "chat"}
                >
                  {isStreaming && currentMode === "code" ? <Zap size={13} /> : <Send size={13} />}
                </button>
                </div>
              </div>
            </div>
            {usageStats && (
              <div className="usage-footer">
                <span>{t("usage.total", lang)}: {t("usage.prompt", lang)} {usageStats.totalPromptTokens} / {t("usage.completion", lang)} {usageStats.totalCompletionTokens}</span>
                <span className="usage-sep">·</span>
                <span>{t("usage.loops", lang)}: {usageStats.loopCount}</span>
              </div>
            )}
          </div>
        </section>

        {/* Right panel resize handle */}
        {rightPanelOpen && (
          <div
            className={`resize-divider ${draggingRight ? "dragging" : ""}`}
            onMouseDown={handleRightDrag}
          />
        )}

        {/* RIGHT: Workspace */}
        <section
          className={`canvas-panel ${rightPanelOpen ? "" : "collapsed"}`}
          style={{ width: rightPanelWidth }}
        >
          <div className="canvas-tab-bar">
            <button
              className={`canvas-tab ${activeTab === "terminal" ? "active" : ""}`}
              onClick={() => setActiveTab("terminal")}
            >
              <TerminalIcon size={12} /> {t("terminal", lang)}
            </button>
            <button
              className={`canvas-tab ${activeTab === "files" ? "active" : ""}`}
              onClick={() => setActiveTab("files")}
            >
              <FolderOpen size={12} /> {t("files", lang)}
            </button>
            <button
              className={`canvas-tab ${activeTab === "preview" ? "active" : ""}`}
              onClick={() => setActiveTab("preview")}
            >
              <Eye size={12} /> {t("preview", lang)}
            </button>
          </div>

          <div className="canvas-body">
            <div className={`canvas-content-pane ${activeTab === "terminal" ? "active" : ""}`}>
              <div className="console-container">
                {terminalLogs.map((log, idx) => (
                  <div key={idx} className={`console-line ${log.type}`}>
                    {log.type === "cmd" ? "> " : ""}
                    {log.text}
                  </div>
                ))}
              </div>
            </div>

            <div className={`canvas-content-pane ${activeTab === "files" ? "active" : ""}`}>
              <div className="files-panel">
                <div className="files-header">
                  <span style={{ fontSize: "0.65rem", color: "var(--accent)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {t("files.workspace", lang)}
                  </span>
                  <button className="btn" style={{ padding: "3px 8px", fontSize: "0.72rem" }} onClick={refreshFileList}>
                    <RefreshCw size={11} /> {t("files.refresh", lang)}
                  </button>
                </div>
                <div className="files-list">
                  {fileList.map((f, idx) => {
                    const fullPath = config.default_work_dir ? `${config.default_work_dir}\\${f}` : f;
                    const isModified = !!modifiedFiles[fullPath];
                    return (
                      <div
                        key={idx}
                        className={`file-item ${selectedFile === f ? "active" : ""} ${isModified ? "modified" : ""}`}
                        onClick={() => handleFileClick(f)}
                      >
                        {f.endsWith("/") ? (
                          <span style={{ color: "var(--accent)", fontWeight: 600 }}>{f}</span>
                        ) : (
                          <span>{f} {isModified && <span className="file-modified-badge">{t("files.modified", lang)}</span>}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {fileContent !== null && (
                  <div className="file-preview">
                    <div className="file-preview-header">
                      <FileText size={12} />
                      <span>{selectedFile}</span>
                      {selectedFile && modifiedFiles[config.default_work_dir ? `${config.default_work_dir}\\${selectedFile}` : selectedFile] && (
                        <button className="btn" style={{ padding: "2px 8px", fontSize: "0.68rem", marginLeft: "auto" }} onClick={() => setDiffView(!diffView)}>
                          {diffView ? t("files.current", lang) : t("files.diff", lang)}
                        </button>
                      )}
                    </div>
                    {diffView && selectedFile && modifiedFiles[config.default_work_dir ? `${config.default_work_dir}\\${selectedFile}` : selectedFile] ? (
                      <DiffView
                        oldContent={modifiedFiles[config.default_work_dir ? `${config.default_work_dir}\\${selectedFile}` : selectedFile].old}
                        newContent={modifiedFiles[config.default_work_dir ? `${config.default_work_dir}\\${selectedFile}` : selectedFile].new}
                      />
                    ) : (
                      <pre className="file-preview-body">
                        <code>{fileContent}</code>
                      </pre>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className={`canvas-content-pane ${activeTab === "preview" ? "active" : ""}`}>
              <div className="preview-panel">
                <div className="preview-toolbar">
                  <button
                    className={`preview-device-btn ${previewDevice === "desktop" ? "active" : ""}`}
                    onClick={() => setPreviewDevice("desktop")}
                    title="Desktop"
                  >
                    <Monitor size={14} />
                  </button>
                  <button
                    className={`preview-device-btn ${previewDevice === "mobile" ? "active" : ""}`}
                    onClick={() => setPreviewDevice("mobile")}
                    title="Mobile"
                  >
                    <Smartphone size={14} />
                  </button>
                  <button className="btn" style={{ padding: "3px 8px", fontSize: "0.72rem" }} onClick={() => setPreviewSrc(previewSrc + " ")} title={t("files.refresh", lang)}>
                    <RefreshCw size={11} />
                  </button>
                  <button className="btn" style={{ padding: "3px 8px", fontSize: "0.72rem", marginLeft: "auto" }} onClick={() => setPreviewConsoleLogs([])} title="Clear console">
                    <Trash2 size={11} />
                  </button>
                </div>
                <div className="preview-frame-wrapper">
                  {previewSrc ? (
                    <iframe
                      className={`preview-iframe ${previewDevice === "mobile" ? "mobile" : ""}`}
                      sandbox={config.preview_sandbox ? "allow-scripts" : undefined}
                      srcDoc={(() => {
                        const consoleHijack = `<script>(function(){var o={log:console.log,error:console.error,warn:console.warn,info:console.info};function c(t){return function(){var a=[].slice.call(arguments);o[t].apply(console,a);window.parent.postMessage({type:'iframe-console-log',logType:t,text:a.map(function(x){return typeof x==='object'?JSON.stringify(x):String(x)}).join(' ')},'*')}};console.log=c('log');console.error=c('error');console.warn=c('warn');console.info=c('info');window.addEventListener('error',function(e){window.parent.postMessage({type:'iframe-console-log',logType:'error',text:'Runtime Error: '+e.message+' at '+e.filename+':'+e.lineno},'*')})})()</script>`;
                        if (previewSrc.toLowerCase().includes("<head>")) {
                          return previewSrc.replace(/<head>/i, "<head>" + consoleHijack);
                        }
                        return consoleHijack + previewSrc;
                      })()}
                      title="Preview"
                    />
                  ) : (
                    <div className="preview-empty">
                      <Eye size={24} style={{ opacity: 0.3 }} />
                      <span>{t("preview.empty", lang)}</span>
                    </div>
                  )}
                </div>
                {previewConsoleLogs.length > 0 && (
                  <div className="preview-console">
                    {previewConsoleLogs.map((log, i) => (
                      <div key={i} className={`preview-console-line ${log.type}`}>
                        [{log.type}] {log.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ====== Settings Modal ====== */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal-content settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ fontWeight: 700, fontSize: "0.92rem" }}>{t("settings.title", lang)}</h3>
              <button className="btn" style={{ padding: "3px 8px", fontSize: "0.72rem" }} onClick={() => setSettingsOpen(false)}>
                {t("settings.close", lang)}
              </button>
            </div>

            <div className="settings-tabs">
              <button className={`settings-tab ${settingsTab === "appearance" ? "active" : ""}`} onClick={() => setSettingsTab("appearance")}>
                <Sun size={13} /> {lang === "zh" ? "外观" : "Appearance"}
              </button>
              <button className={`settings-tab ${settingsTab === "api" ? "active" : ""}`} onClick={() => setSettingsTab("api")}>
                <Zap size={13} /> API
              </button>
              <button className={`settings-tab ${settingsTab === "behavior" ? "active" : ""}`} onClick={() => setSettingsTab("behavior")}>
                <ShieldAlert size={13} /> {lang === "zh" ? "行为" : "Behavior"}
              </button>
              <button className={`settings-tab ${settingsTab === "advanced" ? "active" : ""}`} onClick={() => setSettingsTab("advanced")}>
                <Server size={13} /> {lang === "zh" ? "高级" : "Advanced"}
              </button>
            </div>

            <div className="modal-body">
              {settingsTab === "appearance" && (
              <>
              <div className="form-group">
                <label className="form-label">{t("settings.theme", lang)}</label>
                <div className="theme-toggle">
                  <Sun size={14} style={{ color: config.theme === "light" ? "var(--accent)" : "var(--text-tertiary)" }} />
                  <div
                    className={`theme-switch ${config.theme === "dark" ? "active" : ""}`}
                    onClick={toggleTheme}
                  >
                    <div className="theme-switch-knob" />
                  </div>
                  <Moon size={14} style={{ color: config.theme === "dark" ? "var(--accent)" : "var(--text-tertiary)" }} />
                  <span className="theme-toggle-label">
                    {config.theme === "dark" ? t("settings.theme.dark", lang) : t("settings.theme.light", lang)}
                  </span>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">{t("settings.language", lang)}</label>
                <div className="lang-toggle">
                  <button
                    className={`lang-btn ${lang === "zh" ? "active" : ""}`}
                    onClick={() => setConfig((prev) => ({ ...prev, language: "zh" }))}
                  >
                    中文
                  </button>
                  <button
                    className={`lang-btn ${lang === "en" ? "active" : ""}`}
                    onClick={() => setConfig((prev) => ({ ...prev, language: "en" }))}
                  >
                    English
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label"><Type size={12} /> {t("settings.fontSize", lang)}: {config.font_size}px</label>
                <input
                  type="range"
                  min={10}
                  max={24}
                  step={1}
                  value={config.font_size}
                  onChange={(e) => setConfig((prev) => ({ ...prev, font_size: parseInt(e.target.value) }))}
                  style={{ width: "100%" }}
                />
              </div>
              </>
              )}

              {settingsTab === "api" && (
              <>
              {/* API Profiles */}
              <div className="form-group">
                <label className="form-label">{t("profile.title", lang)}</label>
                <div className="profile-list">
                  {Object.values(config.profiles).map((p) => (
                    <div key={p.name} className={`profile-item ${config.active_profile === p.name ? "active" : ""}`}>
                      <div className="profile-info">
                        <span className="profile-name">{p.name}</span>
                        <span className="profile-meta">{p.default_model} · {p.base_url.replace(/^https?:\/\//, "").split("/")[0]}</span>
                      </div>
                      <div className="profile-actions">
                        {config.active_profile !== p.name ? (
                          <button className="btn" style={{ padding: "2px 8px", fontSize: "0.68rem" }} onClick={() => handleActivateProfile(p.name)}>
                            {t("profile.activate", lang)}
                          </button>
                        ) : (
                          <span className="profile-active-badge">{t("profile.active", lang)}</span>
                        )}
                        <button className="btn" style={{ padding: "2px 6px", fontSize: "0.68rem", color: "var(--error)" }} onClick={() => handleDeleteProfile(p.name)}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {Object.keys(config.profiles).length === 0 && (
                    <div className="profile-empty">{t("profile.empty", lang)}</div>
                  )}
                </div>
                {config.active_profile && (
                  <button className="btn" style={{ padding: "3px 8px", fontSize: "0.72rem", marginTop: 4 }} onClick={handleClearActiveProfile}>
                    {t("profile.clearActive", lang)}
                  </button>
                )}
                <div className="profile-add" style={{ marginTop: 6 }}>
                  <input
                    type="text"
                    className="input-text"
                    style={{ fontSize: "0.72rem" }}
                    placeholder={t("profile.newName", lang)}
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                  />
                  <button className="btn" style={{ padding: "3px 8px", fontSize: "0.72rem" }} onClick={handleSaveProfile} disabled={!newProfileName.trim()}>
                    <Plus size={11} /> {t("profile.save", lang)}
                  </button>
                </div>
              </div>

              {/* Provider Preset */}
              <div className="form-group">
                <label className="form-label">{t("settings.provider", lang)}</label>
                <div className="preset-buttons">
                  {presets.map((p) => (
                    <button
                      key={p.name}
                      className={`preset-btn ${config.base_url === p.base_url ? "active" : ""}`}
                      onClick={() => applyPreset(p)}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">{t("settings.baseUrl", lang)}</label>
                <input
                  type="text"
                  className="input-text"
                  value={config.base_url}
                  onChange={(e) => setConfig((prev) => ({ ...prev, base_url: e.target.value }))}
                  placeholder="https://api.deepseek.com/v1"
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t("settings.apiKey", lang)}</label>
                <input
                  type="password"
                  className="input-text"
                  value={config.api_key}
                  onChange={(e) => setConfig((prev) => ({ ...prev, api_key: e.target.value }))}
                  placeholder="sk-..."
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t("settings.model", lang)}</label>
                <div className="model-input-row">
                  <select
                    className="input-text"
                    value={config.model}
                    onChange={(e) => setConfig((prev) => ({ ...prev, model: e.target.value }))}
                  >
                    {Object.values(config.profiles).map((p) => (
                      <option key={p.name} value={p.default_model}>{p.name} ({p.default_model})</option>
                    ))}
                    {models.length > 0 && (
                      <optgroup label={lang === "zh" ? "可用模型" : "Available Models"}>
                        {models.filter(m => !Object.values(config.profiles).some(p => p.default_model === m.id)).map((m) => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </optgroup>
                    )}
                    {!Object.values(config.profiles).some(p => p.default_model === config.model) && models.length === 0 && (
                      <option value={config.model}>{config.model}</option>
                    )}
                  </select>
                  <button
                    className="btn btn-icon"
                    onClick={fetchModelList}
                    disabled={modelsLoading}
                    title={lang === "zh" ? "获取模型列表" : "Fetch model list"}
                  >
                    {modelsLoading ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">{t("settings.systemPrompt", lang)}</label>
                <textarea
                  className="input-text"
                  style={{ height: "64px", resize: "none", fontSize: "0.78rem" }}
                  value={config.system_prompt}
                  onChange={(e) => setConfig((prev) => ({ ...prev, system_prompt: e.target.value }))}
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t("session.temperature", lang)}: {config.temperature}</label>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={config.temperature}
                  onChange={(e) => setConfig((prev) => ({ ...prev, temperature: parseFloat(e.target.value) }))}
                  style={{ width: "100%" }}
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t("session.topP", lang)}: {config.top_p}</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={config.top_p}
                  onChange={(e) => setConfig((prev) => ({ ...prev, top_p: parseFloat(e.target.value) }))}
                  style={{ width: "100%" }}
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t("session.maxTokens", lang)}</label>
                <input
                  type="number"
                  className="input-text"
                  min={1}
                  placeholder="∞"
                  value={config.max_tokens ?? ""}
                  onChange={(e) => setConfig((prev) => ({ ...prev, max_tokens: e.target.value ? parseInt(e.target.value) : null }))}
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t("session.contextLimit", lang)}</label>
                <input
                  type="number"
                  className="input-text"
                  min={1}
                  max={200}
                  value={config.context_limit}
                  onChange={(e) => setConfig((prev) => ({ ...prev, context_limit: parseInt(e.target.value) || 50 }))}
                />
              </div>
              </>
              )}

              {settingsTab === "behavior" && (
              <>
              <div className="form-group">
                <label className="form-label">{t("settings.approvalPolicy", lang)}</label>
                <select
                  className="input-text"
                  value={config.approval_policy}
                  onChange={(e) => setConfig((prev) => ({ ...prev, approval_policy: e.target.value }))}
                >
                  <option value="standard">{t("settings.approval.standard", lang)}</option>
                  <option value="strict">{t("settings.approval.strict", lang)}</option>
                  <option value="relaxed">{t("settings.approval.relaxed", lang)}</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">{t("settings.workDir", lang)}</label>
                <input
                  type="text"
                  className="input-text"
                  value={config.default_work_dir}
                  onChange={(e) => setConfig((prev) => ({ ...prev, default_work_dir: e.target.value }))}
                  placeholder="C:\Users\..."
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t("settings.tools", lang)}</label>
                <div className="tools-grid">
                  {TOOL_NAMES.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => toggleTool(t.key)}
                      className={`tool-toggle ${config.tools_enabled.includes(t.key) ? "active" : ""}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Whitelist Management */}
              <div className="form-group">
                <label className="form-label">{t("whitelist.title", lang)}</label>
                <div className="whitelist-container">
                  {config.trusted_patterns.length === 0 ? (
                    <div className="whitelist-empty">{t("whitelist.empty", lang)}</div>
                  ) : (
                    <div className="whitelist-list">
                      {config.trusted_patterns.map((p, idx) => (
                        <div key={idx} className="whitelist-item">
                          <span className="whitelist-tool-name">{p.tool_name}</span>
                          <span className="whitelist-pattern">{p.pattern}</span>
                          <button
                            className="whitelist-remove-btn"
                            onClick={() => removeTrustedPattern(p.tool_name, p.pattern)}
                            title={t("whitelist.remove", lang)}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="form-group">
                <label className="form-label"><ShieldAlert size={12} /> {t("settings.previewSandbox", lang)}</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    className={`tool-toggle ${config.preview_sandbox ? "active" : ""}`}
                    onClick={() => setConfig((prev) => ({ ...prev, preview_sandbox: !prev.preview_sandbox }))}
                  >
                    {config.preview_sandbox ? t("settings.sandbox.on", lang) : t("settings.sandbox.off", lang)}
                  </button>
                  <span style={{ fontSize: "0.68rem", opacity: 0.6 }}>
                    {config.preview_sandbox ? t("settings.sandbox.onDesc", lang) : t("settings.sandbox.offDesc", lang)}
                  </span>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label"><Timer size={12} /> {t("settings.commandTimeout", lang)}</label>
                <input
                  type="number"
                  className="input-text"
                  min={5}
                  max={300}
                  value={config.command_timeout}
                  onChange={(e) => setConfig((prev) => ({ ...prev, command_timeout: parseInt(e.target.value) || 30 }))}
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t("search.provider", lang)}</label>
                <select
                  className="input-text"
                  value={config.search_provider}
                  onChange={(e) => setConfig((prev) => ({ ...prev, search_provider: e.target.value }))}
                >
                  <option value="duckduckgo">{t("search.provider.ddg", lang)}</option>
                  <option value="tavily">{t("search.provider.tavily", lang)}</option>
                  <option value="searxng">{t("search.provider.searxng", lang)}</option>
                </select>
                {config.search_provider === "tavily" && (
                  <span className="settings-recommend-tag">{lang === "zh" ? "推荐 · 官方合规路径" : "Recommended · Official API"}</span>
                )}
              </div>

              {config.search_provider === "tavily" && (
                <div className="form-group">
                  <label className="form-label">{t("search.apiKey", lang)}</label>
                  <input
                    type="password"
                    className="input-text"
                    value={config.search_api_key}
                    onChange={(e) => setConfig((prev) => ({ ...prev, search_api_key: e.target.value }))}
                    placeholder={t("search.apiKeyPlaceholder", lang)}
                  />
                </div>
              )}
              </>
              )}

              {settingsTab === "advanced" && (
              <>
              <div className="form-group">
                <label className="form-label"><Server size={12} /> {t("mcp.title", lang)}</label>
                <div className="mcp-server-list">
                  {Object.entries(config.mcp_servers).map(([name, server]) => (
                    <div key={name} className="mcp-server-item">
                      <div className="mcp-server-info">
                        <span className="mcp-server-name">{name}</span>
                        <span className="mcp-server-meta">{server.command} {(server.args || []).join(" ")}</span>
                      </div>
                      <button
                        className="btn"
                        style={{ padding: "2px 6px", fontSize: "0.68rem", color: "var(--error)" }}
                        onClick={async () => {
                          try {
                            const updated = await invoke<AppConfig>("delete_mcp_server", { name });
                            setConfig(updated);
                          } catch (e) {
                            addLog(String(e), "error");
                          }
                        }}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                  {Object.keys(config.mcp_servers).length === 0 && (
                    <div className="mcp-empty">{t("mcp.empty", lang)}</div>
                  )}
                </div>
                <McpAddForm setConfig={setConfig} addLog={addLog} lang={lang} t={t} />
              </div>

              {/* Ollama Model Fetch */}
              {config.provider === "ollama" && (
                <div className="form-group">
                  <label className="form-label"><Zap size={12} /> {t("mcp.fetchModels", lang)}</label>
                  <button
                    className="btn btn-secondary"
                    style={{ width: "100%", fontSize: "0.78rem" }}
                    onClick={async () => {
                      try {
                        const list = await invoke<ModelInfo[]>("fetch_ollama_models", { baseUrl: config.base_url });
                        setModels(list);
                        addLog(t("log.modelsFetched", lang, { count: String(list.length), url: config.base_url }), "success");
                      } catch (e) {
                        addLog(t("log.modelsFailed", lang) + String(e), "error");
                      }
                    }}
                  >
                    <Search size={12} /> {t("mcp.fetchModels", lang)}
                  </button>
                </div>
              )}

              {/* Export / Import / Clear */}
              <div className="form-group">
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: "0.78rem", flex: 1 }}
                    onClick={async () => {
                      try {
                        const json = await invoke<string>("export_config", { config });
                        const blob = new Blob([json], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "gxagent-config.json";
                        a.click();
                        URL.revokeObjectURL(url);
                        addLog(t("settings.exported", lang), "success");
                      } catch (e) {
                        addLog(String(e), "error");
                      }
                    }}
                  >
                    <Download size={12} /> {t("settings.exportConfig", lang)}
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: "0.78rem", flex: 1 }}
                    onClick={() => {
                      const input = document.createElement("input");
                      input.type = "file";
                      input.accept = ".json";
                      input.onchange = async () => {
                        if (!input.files?.[0]) return;
                        try {
                          const text = await input.files[0].text();
                          const updated = await invoke<AppConfig>("import_config", { json: text });
                          setConfig(updated);
                          addLog(t("settings.imported", lang), "success");
                        } catch (e) {
                          addLog(t("settings.importFailed", lang) + String(e), "error");
                        }
                      };
                      input.click();
                    }}
                  >
                    <Upload size={12} /> {t("settings.importConfig", lang)}
                  </button>
                </div>
                <button
                  className="btn btn-secondary"
                  style={{ fontSize: "0.78rem", width: "100%", marginTop: 6, color: "var(--error)" }}
                  onClick={async () => {
                    if (!window.confirm(t("settings.clearSessionsConfirm", lang))) return;
                    try {
                      await invoke("clear_all_sessions");
                      setSessions([{ id: "default", title: "", messages: [], sessionConfig: { ...DEFAULT_SESSION_CONFIG } }]);
                      setCurrentSessionId("default");
                      addLog(t("settings.cleared", lang), "success");
                    } catch (e) {
                      addLog(String(e), "error");
                    }
                  }}
                >
                  <Trash size={12} /> {t("settings.clearSessions", lang)}
                </button>
              </div>
              </>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-primary"
                onClick={async () => {
                  await saveConfig();
                  setSettingsOpen(false);
                }}
              >
                {t("settings.save", lang)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
