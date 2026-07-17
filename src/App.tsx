import { Fragment, useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, type ClipboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
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
  CircleStop,
  X,
  Eye,
  Monitor,
  Smartphone,
  Download,
  Upload,
  Trash,
  BarChart3,
  Search,
  Zap,
  Sparkles,
  Server,
  PlusCircle,
  Timer,
  Type,
  Brain,
} from "lucide-react";
import "./styles/modern.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/enhancements.css";
import "./App.css";
import CaturtleLogo from "./assets/logo.png";
import { ROLE_PRESETS, ROLE_CATEGORIES, RolePreset } from "./rolePresets";
import { countTokens, parseCommand, sessionToMarkdown } from "./utils/helpers";
import { CommandSuggestions, useGlobalHotkeys } from "./components/shared/CommandSuggestions";
import { exportAllSessions, importSessions, getToolStats } from "./utils/sessionHelpers";
import { ContextMenu, useContextMenu } from "./components/shared/ContextMenu";
import { SecretInput } from "./components/shared/SecretInput";
import { DiffView } from "./components/shared/DiffView";
import { PositionedContextMenu } from "./components/shared/PositionedContextMenu";
import { CustomPresetForm } from "./components/CustomPresetForm";
import { McpAddForm } from "./components/mcp/McpAddForm";
import { useSessionStorage } from "./hooks/useSessionStorage";
import { resolveRequestConfig } from "./utils/requestConfig";
import { compareSidebarSessions, moveSessionInSidebar } from "./utils/sessionOrder";
import { TaskProgress } from "./components/shared/TaskProgress";
import { ConnectionStatus } from "./components/shared/ConnectionStatus";
import { McpServerManager, type McpServerView } from "./components/mcp/McpServerManager";
import { WorkspaceTree, type DirectoryNode } from "./components/workspace/WorkspaceTree";
import { WorkspaceChanges, type GitStatusEntry } from "./components/workspace/WorkspaceChanges";
import { MarkdownContent } from "./components/markdown/MarkdownContent";
import {
  OnboardingWizard,
  type ConnectionCheck,
  type OnboardingValues,
} from "./components/onboarding/OnboardingWizard";

const SETTINGS_TAB_ORDER = ["model", "chat", "agent", "search", "data"] as const;
type SettingsTab = (typeof SETTINGS_TAB_ORDER)[number];

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
    "settings.tab.model": "模型与 API",
    "settings.tab.chat": "聊天体验",
    "settings.tab.agent": "Agent 与工具",
    "settings.tab.search": "搜索",
    "settings.tab.data": "数据与高级",
    "settings.theme": "主题",
    "settings.theme.light": "浅色",
    "settings.theme.dark": "深色",
    "settings.language": "语言",
    "settings.provider": "API 提供商",
    "settings.wireFormat": "请求格式",
    "settings.wire.openai": "OpenAI 兼容",
    "settings.wire.anthropic": "Claude (Anthropic)",
    "settings.wire.gemini": "Gemini (官方)",
    "settings.wire.ollama": "Ollama",
    "settings.wireFormat.hint": "实际使用的 API 协议格式，与供应商解耦。多数中转/第三方服务用 OpenAI 兼容；只有直连 Anthropic / Google 官方端点才选 Claude / Gemini。",
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
    "search.modeOff": "搜索: 关闭",
    "search.modeAuto": "搜索: 自动",
    "search.modeForce": "搜索: 强制",
    "search.provider": "搜索引擎",
    "search.provider.ddg": "DuckDuckGo (免费免Key)",
    "search.provider.tavily": "Tavily (专业搜索)",
    "search.provider.searxng": "SearXNG (免费免Key)",
    "search.apiKey": "API Key",
    "search.apiKeyPlaceholder": "输入 Tavily API Key",
    "secret.reveal": "显示",
    "secret.hide": "隐藏",
    "search.settings.desc": "配置搜索行为和搜索引擎。搜索模式可在输入框旁切换：关闭=不搜索，自动=模型判断，强制=每次必搜。",
    "search.settings.fallbackDesc": "使用 DuckDuckGo 时，搜索失败或超时会自动尝试 Tavily 备用路径（需配置 API Key）。SearXNG 无自动备用。",
    "search.settings.ollamaNote": "注意：Ollama 本地模型暂不支持工具调用，搜索功能对 Ollama 不生效。",
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
    "activity": "活动",
    "activity.empty": "暂无工具活动",
    "activity.searchSources": "搜索来源",
    "activity.toolCalls": "工具调用",
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
    "settings.maxAgentLoops": "最大 Agent 轮次",
    "settings.maxToolCalls": "单次最大工具调用",
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
    "settings.tab.model": "Model & API",
    "settings.tab.chat": "Chat Experience",
    "settings.tab.agent": "Agent & Tools",
    "settings.tab.search": "Search",
    "settings.tab.data": "Data & Advanced",
    "settings.theme": "Theme",
    "settings.theme.light": "Light",
    "settings.theme.dark": "Dark",
    "settings.language": "Language",
    "settings.provider": "Provider Preset",
    "settings.wireFormat": "Request Format",
    "settings.wire.openai": "OpenAI compatible",
    "settings.wire.anthropic": "Claude (Anthropic)",
    "settings.wire.gemini": "Gemini (Google)",
    "settings.wire.ollama": "Ollama",
    "settings.wireFormat.hint": "The on-the-wire protocol. Decoupled from the model brand: choose OpenAI compatible for most relays/proxies; pick Claude or Gemini only for their official native endpoints.",
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
    "search.modeOff": "Search: Off",
    "search.modeAuto": "Search: Auto",
    "search.modeForce": "Search: Force",
    "search.provider": "Search Engine",
    "search.provider.ddg": "DuckDuckGo (Free, No Key)",
    "search.provider.tavily": "Tavily (Professional)",
    "search.provider.searxng": "SearXNG (Free, No Key)",
    "search.apiKey": "API Key",
    "search.apiKeyPlaceholder": "Enter Tavily API Key",
    "secret.reveal": "Show",
    "secret.hide": "Hide",
    "search.settings.desc": "Configure search behavior and search engine. Toggle search mode next to the input: Off=No search, Auto=Model decides, Force=Always search.",
    "search.settings.fallbackDesc": "When using DuckDuckGo, failed or timed-out searches will automatically try Tavily as fallback (requires API Key). SearXNG has no automatic fallback.",
    "search.settings.ollamaNote": "Note: Ollama local models do not support tool calls, so search does not work with Ollama.",
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
    "activity": "Activity",
    "activity.empty": "No tool activity yet",
    "activity.searchSources": "Search Sources",
    "activity.toolCalls": "Tool Calls",
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
    "settings.maxAgentLoops": "Max Agent Loops",
    "settings.maxToolCalls": "Max Tool Calls per Request",
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

i18n.ja = {
  ...i18n.en,
  "session.new": "新しい会話",
  "settings.title": "設定",
  "settings.save": "設定を保存",
  "settings.close": "閉じる",
  "settings.language": "言語",
  "settings.fontSize": "フォントサイズ",
  "settings.fontFamily": "フォント",
  "settings.advancedReplyInfo": "AI応答の詳細情報",
  "settings.advancedReplyInfoDesc": "応答時にモデル、トークン、所要時間を表示します",
  "settings.on": "オン",
  "settings.off": "オフ",
  "input.placeholder": "Agent に依頼する...",
  "thinking": "考え中...",
  "usage.tokens": "トークン",
  "usage.prompt": "入力",
  "usage.completion": "出力",
  "usage.total": "合計",
  "usage.context": "コンテキスト",
  "usage.modelLimit": "モデル上限",
  "usage.compress": "コンテキストを圧縮",
  "context.pin": "会話を固定",
  "context.unpin": "固定を解除",
};

i18n.ko = {
  ...i18n.en,
  "session.new": "새 대화",
  "settings.title": "설정",
  "settings.save": "설정 저장",
  "settings.close": "닫기",
  "settings.language": "언어",
  "settings.fontSize": "글꼴 크기",
  "settings.fontFamily": "글꼴",
  "settings.advancedReplyInfo": "AI 응답 상세 정보",
  "settings.advancedReplyInfoDesc": "응답에 모델, 토큰, 소요 시간을 표시합니다",
  "settings.on": "켜기",
  "settings.off": "끄기",
  "input.placeholder": "Agent에게 요청...",
  "thinking": "생각 중...",
  "usage.tokens": "토큰",
  "usage.prompt": "입력",
  "usage.completion": "출력",
  "usage.total": "합계",
  "usage.context": "컨텍스트",
  "usage.modelLimit": "모델 한도",
  "usage.compress": "컨텍스트 압축",
  "context.pin": "대화 고정",
  "context.unpin": "고정 해제",
};

i18n.es = {
  ...i18n.en,
  "session.new": "Nueva conversación",
  "settings.title": "Configuración",
  "settings.save": "Guardar configuración",
  "settings.close": "Cerrar",
  "settings.language": "Idioma",
  "settings.fontSize": "Tamaño de fuente",
  "settings.fontFamily": "Fuente",
  "settings.advancedReplyInfo": "Información avanzada de respuestas",
  "settings.advancedReplyInfoDesc": "Muestra modelo, tokens y duración en las respuestas",
  "settings.on": "Activado",
  "settings.off": "Desactivado",
  "input.placeholder": "Pide algo al Agent...",
  "thinking": "Pensando...",
  "usage.tokens": "Tokens",
  "usage.prompt": "Entrada",
  "usage.completion": "Salida",
  "usage.total": "Total",
  "usage.context": "Contexto",
  "usage.modelLimit": "Límite del modelo",
  "usage.compress": "Comprimir contexto",
  "context.pin": "Fijar conversación",
  "context.unpin": "Desfijar conversación",
};

Object.assign(i18n.zh, {
  "settings.fontFamily": "字体",
  "settings.advancedReplyInfo": "AI 回复高级信息",
  "settings.advancedReplyInfoDesc": "在回复旁显示模型、上下文 token、输出 token 和耗时",
  "settings.on": "开启",
  "settings.off": "关闭",
  "usage.context": "上下文",
  "usage.modelLimit": "模型限制",
  "usage.compress": "压缩上下文",
  "context.pin": "置顶会话",
  "context.unpin": "取消置顶",
  "context.exportAll": "导出所有会话",
  "context.importSessions": "导入会话",
  "context.toolStats": "工具统计",
  "session.untitled": "未命名会话",
  "session.exportedAll": "会话已导出",
  "session.importedCount": "已导入 {count} 个会话",
  "session.importFailed": "导入失败",
  "stats.title": "工具调用统计",
  "stats.allSessions": "所有会话",
  "stats.total": "总计 {count} 次",
  "stats.empty": "暂无工具调用",
  "stats.count": "{count} 次",
  "status.error": "出错",
});

Object.assign(i18n.en, {
  "settings.fontFamily": "Font",
  "settings.advancedReplyInfo": "Advanced reply info",
  "settings.advancedReplyInfoDesc": "Show model, context tokens, output tokens, and duration on replies",
  "settings.on": "On",
  "settings.off": "Off",
  "usage.context": "Context",
  "usage.modelLimit": "Model limit",
  "usage.compress": "Compress context",
  "context.pin": "Pin conversation",
  "context.unpin": "Unpin conversation",
  "context.exportAll": "Export All Sessions",
  "context.importSessions": "Import Sessions",
  "context.toolStats": "Tool Stats",
  "session.untitled": "Untitled Session",
  "session.exportedAll": "Sessions exported",
  "session.importedCount": "Imported {count} sessions",
  "session.importFailed": "Import failed",
  "stats.title": "Tool Call Stats",
  "stats.allSessions": "All Sessions",
  "stats.total": "{count} total",
  "stats.empty": "No tool calls yet",
  "stats.count": "{count} calls",
  "status.error": "error",
});

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
  SearchStatus,
  Message,
  Attachment
} from "./types";

type ToastNotice = {
  id: number;
  text: string;
  type: "info" | "success" | "error" | "cmd";
};

type AgentEventPayload<T extends Record<string, unknown> = Record<string, unknown>> =
  | string
  | (T & {
      requestId?: string;
      content?: string;
      status?: string;
    });

type ToolStatsDialog = {
  title: string;
  stats: Record<string, number>;
};

type SessionRuntime = {
  requestId: string;
  status: "running" | "stopping";
};

type RunCheckpoint = {
  reference: string;
  commit: string;
  createdAt: number;
  label: string;
  workDir: string;
};

type WorkspaceViewState = {
  workDir: string;
  repositoryRoot: string;
  root: DirectoryNode | null;
  branch: string;
  entries: GitStatusEntry[];
  selectedPath: string | null;
  diff: string;
  loading: boolean;
  treeError: string;
  changesError: string;
};

const createEmptyWorkspaceState = (): WorkspaceViewState => ({
  workDir: "",
  repositoryRoot: "",
  root: null,
  branch: "",
  entries: [],
  selectedPath: null,
  diff: "",
  loading: false,
  treeError: "",
  changesError: "",
});

const resolveWorkspacePath = (workDir: string, path: string) => {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")) return path;
  const separator = workDir.includes("\\") ? "\\" : "/";
  return `${workDir.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
};

const comparableWorkspacePath = (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
};

const isSendableAttachment = (attachment: Attachment) => (
  attachment.type === "image" ? Boolean(attachment.data) : Boolean(attachment.data.trim())
);

const MAX_ATTACHMENT_TEXT_PER_FILE = 50_000;
const MAX_ATTACHMENT_TEXT_TOTAL = 100_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_COUNT = 8;
const MAX_IMAGE_ATTACHMENT_TOTAL_BYTES = 40 * 1024 * 1024;

const estimateImageAttachmentBytes = (attachment: Attachment) => {
  if (attachment.originalSize && attachment.originalSize > 0) return attachment.originalSize;
  const payload = attachment.data.includes(",")
    ? attachment.data.slice(attachment.data.indexOf(",") + 1)
    : attachment.data;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
};

const fitAttachmentBudget = (existing: Attachment[], candidates: Attachment[]) => {
  let used = existing
    .filter((attachment) => attachment.type === "text" && isSendableAttachment(attachment))
    .reduce((sum, attachment) => sum + attachment.data.length, 0);
  let imageCount = existing.filter((attachment) => attachment.type === "image" && isSendableAttachment(attachment)).length;
  let imageBytes = existing
    .filter((attachment) => attachment.type === "image" && isSendableAttachment(attachment))
    .reduce((sum, attachment) => sum + estimateImageAttachmentBytes(attachment), 0);
  const accepted: Attachment[] = [];
  const invalid: string[] = [];
  const overBudget: string[] = [];

  for (const attachment of candidates) {
    if (!isSendableAttachment(attachment)) {
      invalid.push(attachment.name);
      continue;
    }
    if (attachment.type === "image") {
      const bytes = estimateImageAttachmentBytes(attachment);
      if (bytes <= 0) {
        invalid.push(attachment.name);
        continue;
      }
      if (bytes > MAX_IMAGE_ATTACHMENT_BYTES
        || imageCount >= MAX_IMAGE_ATTACHMENT_COUNT
        || imageBytes + bytes > MAX_IMAGE_ATTACHMENT_TOTAL_BYTES) {
        overBudget.push(attachment.name);
        continue;
      }
      accepted.push(attachment);
      imageCount += 1;
      imageBytes += bytes;
      continue;
    }
    const allowance = Math.min(MAX_ATTACHMENT_TEXT_PER_FILE, Math.max(0, MAX_ATTACHMENT_TEXT_TOTAL - used));
    if (allowance === 0) {
      overBudget.push(attachment.name);
      continue;
    }
    const data = attachment.data.slice(0, allowance);
    used += data.length;
    accepted.push({
      ...attachment,
      data,
      truncated: attachment.truncated || data.length < attachment.data.length,
    });
  }
  return { accepted, invalid, overBudget };
};

const omitSessionKey = <T,>(record: Record<string, T>, sessionId: string) => {
  const next = { ...record };
  delete next[sessionId];
  return next;
};

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  schemaVersion: 2,
  mode: "chat",
  profileId: null,
  workDir: null,
  systemPrompt: null,
  model: null,
  contextLimit: null,
  temperature: null,
  topP: null,
  maxTokens: "inherit",
  streaming: null,
  thinkingLevel: null,
  backgroundImage: "",
  activeRolePresetId: null,
  searchMode: "auto",
};

const THINKING_LEVELS: NonNullable<SessionConfig["thinkingLevel"]>[] = ["low", "medium", "high"];

const DEFAULT_CONFIG: AppConfig = {
  provider: "openai",
  wire_format: "openai",
  base_url: "https://api.deepseek.com/v1",
  api_key: "",
  model: "deepseek-chat",
  temperature: 0.7,
  top_p: 1.0,
  max_tokens: null,
  system_prompt:
    "You are a helpful AI assistant with access to local tools. Help the user accomplish tasks by using the available tools when needed. Be careful, honest, and direct. If you are unsure or lack enough information, say so instead of guessing. Do not invent facts, files, command results, or tool output.",
  streaming: true,
  thinking_level: "medium",
  context_limit: 50,
  tools_enabled: [
    "execute_command",
    "read_file",
    "write_file",
    "edit_file",
    "list_dir",
    "run_python",
    "web_search",
    "grep",
    "glob",
    "todo_write",
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
  font_family: "system",
  show_advanced_reply_info: false,
  command_timeout: 30,
  max_agent_loops: 10,
  max_tool_calls_per_request: 30,
  preview_sandbox: true,
  tools_migration_version: 1,
};

function createDefaultSession(): ChatSession {
  const now = Date.now();
  return {
    id: "default",
    title: "",
    messages: [],
    sessionConfig: { ...DEFAULT_SESSION_CONFIG },
    sidebarOrder: -now,
    createdAt: now,
    updatedAt: now,
  };
}

function createSession(mode: SessionConfig["mode"], title = "", messages: Message[] = []): ChatSession {
  const now = Date.now();
  return {
    id: `session-${now}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    messages,
    sessionConfig: { ...DEFAULT_SESSION_CONFIG, mode },
    sidebarOrder: -now,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeSessionConfig(raw: unknown): SessionConfig {
  const input = raw && typeof raw === "object" ? raw as Partial<SessionConfig> : {};
  const legacy = input.schemaVersion !== 2;
  const nullableText = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;
  const nullableNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const thinkingLevel = input.thinkingLevel === "low" || input.thinkingLevel === "medium" || input.thinkingLevel === "high"
    ? input.thinkingLevel
    : null;
  return {
    schemaVersion: 2,
    mode: input.mode === "code" ? "code" : "chat",
    profileId: nullableText(input.profileId),
    workDir: nullableText(input.workDir),
    systemPrompt: typeof input.systemPrompt === "string" && input.systemPrompt.length > 0 ? input.systemPrompt : null,
    model: nullableText(input.model),
    contextLimit: legacy && input.contextLimit === 50 ? null : nullableNumber(input.contextLimit),
    temperature: legacy && input.temperature === 0.7 ? null : nullableNumber(input.temperature),
    topP: legacy && input.topP === 1 ? null : nullableNumber(input.topP),
    maxTokens: legacy && input.maxTokens == null
      ? "inherit"
      : input.maxTokens === "inherit"
      ? "inherit"
      : input.maxTokens === null
        ? null
        : nullableNumber(input.maxTokens) ?? "inherit",
    streaming: legacy && input.streaming === true
      ? null
      : typeof input.streaming === "boolean" ? input.streaming : null,
    thinkingLevel: legacy && thinkingLevel === "medium" ? null : thinkingLevel,
    backgroundImage: typeof input.backgroundImage === "string" ? input.backgroundImage : "",
    activeRolePresetId: nullableText(input.activeRolePresetId),
    searchMode: input.searchMode === "off" || input.searchMode === "force" ? input.searchMode : "auto",
  };
}

const TOOL_ACTION_STATUSES = new Set<ToolAction["status"]>([
  "drafting", "executing", "done", "error", "blocked", "pending_approval",
]);

function normalizeMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Partial<Message>;
  if (!input.role || !["user", "assistant", "system", "context_divider"].includes(input.role)) return null;

  const attachments = Array.isArray(input.attachments)
    ? input.attachments.flatMap((rawAttachment) => {
        if (!rawAttachment || typeof rawAttachment !== "object") return [];
        const attachment = rawAttachment as Partial<Attachment>;
        if ((attachment.type !== "image" && attachment.type !== "text")
          || typeof attachment.data !== "string") return [];
        return [{
          name: typeof attachment.name === "string" && attachment.name.trim() ? attachment.name : "Attachment",
          type: attachment.type,
          data: attachment.data,
          ...(typeof attachment.mimeType === "string" ? { mimeType: attachment.mimeType } : {}),
          ...(typeof attachment.path === "string" ? { path: attachment.path } : {}),
          ...(typeof attachment.warning === "string" ? { warning: attachment.warning } : {}),
          ...(typeof attachment.truncated === "boolean" ? { truncated: attachment.truncated } : {}),
          ...(typeof attachment.originalSize === "number" && Number.isFinite(attachment.originalSize)
            ? { originalSize: attachment.originalSize }
            : {}),
        } satisfies Attachment];
      })
    : undefined;

  const actions = Array.isArray(input.actions)
    ? input.actions.flatMap((rawAction) => {
        if (!rawAction || typeof rawAction !== "object") return [];
        const action = rawAction as Partial<ToolAction>;
        if (typeof action.id !== "string" || typeof action.name !== "string") return [];
        const status = action.status && TOOL_ACTION_STATUSES.has(action.status) ? action.status : "done";
        return [{
          id: action.id,
          name: action.name,
          arguments: typeof action.arguments === "string" ? action.arguments : "",
          status,
          ...(typeof action.output === "string" ? { output: action.output } : {}),
          ...(typeof action.approval_level === "string" ? { approval_level: action.approval_level } : {}),
        } satisfies ToolAction];
      })
    : undefined;

  const variants = Array.isArray(input.variants)
    ? input.variants.filter((value): value is string => typeof value === "string")
    : undefined;
  const currentVariantIndex = variants && variants.length > 0 && typeof input.currentVariantIndex === "number"
    ? Math.max(0, Math.min(variants.length - 1, Math.floor(input.currentVariantIndex)))
    : undefined;
  const searchStatus = Array.isArray(input.searchStatus)
    ? input.searchStatus.flatMap((rawStatus) => {
        if (!rawStatus || typeof rawStatus !== "object") return [];
        const status = rawStatus as Partial<SearchStatus>;
        if (!status.type || !["searching", "results", "error"].includes(status.type)
          || typeof status.query !== "string") return [];
        const sources = Array.isArray(status.sources)
          ? status.sources.flatMap((rawSource) => (
              rawSource && typeof rawSource === "object"
                ? [{
                    title: typeof rawSource.title === "string" ? rawSource.title : "",
                    link: typeof rawSource.link === "string" ? rawSource.link : "",
                    snippet: typeof rawSource.snippet === "string" ? rawSource.snippet : "",
                  }]
                : []
            ))
          : undefined;
        return [{
          type: status.type,
          query: status.query,
          ...(typeof status.results === "string" ? { results: status.results } : {}),
          ...(sources && sources.length > 0 ? { sources } : {}),
          ...(typeof status.resultCount === "number" && Number.isFinite(status.resultCount) ? { resultCount: status.resultCount } : {}),
          ...(typeof status.message === "string" ? { message: status.message } : {}),
          ...(typeof status.duration === "number" && Number.isFinite(status.duration) ? { duration: status.duration } : {}),
          ...(typeof status.provider === "string" ? { provider: status.provider } : {}),
        } as SearchStatus];
      })
    : undefined;

  return {
    role: input.role,
    content: input.role === "context_divider" ? "" : typeof input.content === "string" ? input.content : "",
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(actions && actions.length > 0 ? { actions } : {}),
    ...(typeof input.model === "string" ? { model: input.model } : {}),
    ...(typeof input.contextTokens === "number" && Number.isFinite(input.contextTokens) ? { contextTokens: input.contextTokens } : {}),
    ...(typeof input.reasoningContent === "string" ? { reasoningContent: input.reasoningContent } : {}),
    ...(variants && variants.length > 0 ? { variants, currentVariantIndex } : {}),
    ...(typeof input.timestamp === "number" && Number.isFinite(input.timestamp) ? { timestamp: input.timestamp } : {}),
    ...(searchStatus && searchStatus.length > 0 ? { searchStatus } : {}),
    ...(input.usage && typeof input.usage === "object" ? { usage: input.usage } : {}),
  };
}

function normalizeSessions(raw: unknown): ChatSession[] {
  if (!Array.isArray(raw)) return [];

  const seenIds = new Set<string>();
  const normalized = raw
    .filter((item): item is Partial<ChatSession> & { id: string } => (
      !!item
      && typeof item === "object"
      && typeof (item as Partial<ChatSession>).id === "string"
      && Boolean((item as Partial<ChatSession>).id?.trim())
    ))
    .filter((item) => {
      const id = item.id.trim();
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    })
    .map((item) => {
      const id = item.id.trim();
      const messages = Array.isArray(item.messages)
        ? item.messages.map(normalizeMessage).filter((message): message is Message => Boolean(message))
        : [];
      const inferredTimestamp = [...messages].reverse().find((message) => typeof message?.timestamp === "number")?.timestamp;
      const idTimestamp = Number(item.id.match(/(\d{10,})/)?.[1]);
      const createdAt = typeof item.createdAt === "number"
        ? item.createdAt
        : Number.isFinite(idTimestamp) ? idTimestamp : inferredTimestamp || Date.now();
      const updatedAt = typeof item.updatedAt === "number" ? item.updatedAt : inferredTimestamp || createdAt;
      const sidebarOrder = typeof item.sidebarOrder === "number" && Number.isFinite(item.sidebarOrder)
        ? item.sidebarOrder
        : -updatedAt;
      return {
        ...item,
        id,
        title: typeof item.title === "string" ? item.title : "",
        messages,
        sessionConfig: normalizeSessionConfig(item.sessionConfig),
        sidebarOrder,
        createdAt,
        updatedAt,
        compactBackup: Array.isArray(item.compactBackup) ? item.compactBackup : undefined,
      };
    });

  return normalized.length > 0 ? normalized : [createDefaultSession()];
}

function readLocalSessions(): ChatSession[] {
  try {
    const saved = localStorage.getItem("gx_sessions");
    if (saved) return normalizeSessions(JSON.parse(saved));
  } catch { /* ignore corrupt data */ }
  return [createDefaultSession()];
}

const TOOL_NAMES: { key: string; label: string; shortLabel: string; description: string; risk: "low" | "medium" | "high" }[] = [
  { key: "execute_command", label: "PowerShell", shortLabel: "Shell", description: "Run local Windows PowerShell commands.", risk: "high" },
  { key: "read_file", label: "Read File", shortLabel: "Read", description: "Inspect local text files and logs.", risk: "low" },
  { key: "write_file", label: "Write File", shortLabel: "Write", description: "Create or update local files.", risk: "high" },
  { key: "edit_file", label: "Edit File", shortLabel: "Edit", description: "Make precise in-place edits to existing files.", risk: "high" },
  { key: "list_dir", label: "List Folder", shortLabel: "Files", description: "Browse folders in the workspace.", risk: "low" },
  { key: "run_python", label: "Python", shortLabel: "Py", description: "Run short Python scripts for analysis.", risk: "medium" },
  { key: "web_search", label: "Web Search", shortLabel: "Web", description: "Search the web for current information.", risk: "low" },
  { key: "grep", label: "Grep", shortLabel: "Grep", description: "Search file contents by regex across the workspace.", risk: "low" },
  { key: "glob", label: "Find Files", shortLabel: "Glob", description: "Find files by name pattern.", risk: "low" },
  { key: "todo_write", label: "Task List", shortLabel: "Todo", description: "Track multi-step tasks as a checklist.", risk: "low" },
];

const toolIcon = (key: string, size = 11) => {
  switch (key) {
    case "execute_command":
      return <TerminalIcon size={size} />;
    case "read_file":
      return <FileText size={size} />;
    case "write_file":
      return <Pencil size={size} />;
    case "list_dir":
      return <FolderOpen size={size} />;
    case "run_python":
      return <Zap size={size} />;
    case "web_search":
      return <Globe size={size} />;
    case "edit_file":
      return <Pencil size={size} />;
    case "grep":
      return <Search size={size} />;
    case "glob":
      return <FolderOpen size={size} />;
    case "todo_write":
      return <CheckCircle2 size={size} />;
    default:
      return <Settings2 size={size} />;
  }
};

const LANGUAGE_OPTIONS = [
  { code: "zh", label: "中文", locale: "zh-CN" },
  { code: "en", label: "English", locale: "en-US" },
  { code: "ja", label: "日本語", locale: "ja-JP" },
  { code: "ko", label: "한국어", locale: "ko-KR" },
  { code: "es", label: "Español", locale: "es-ES" },
];

const FONT_OPTIONS = [
  { value: "system", label: "System", css: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { value: "segoe", label: "Segoe UI", css: "'Segoe UI', sans-serif" },
  { value: "inter", label: "Inter", css: "'Inter', sans-serif" },
  { value: "arial", label: "Arial", css: "Arial, sans-serif" },
  { value: "verdana", label: "Verdana", css: "Verdana, Geneva, sans-serif" },
  { value: "tahoma", label: "Tahoma", css: "Tahoma, Geneva, sans-serif" },
  { value: "trebuchet", label: "Trebuchet MS", css: "'Trebuchet MS', Arial, sans-serif" },
  { value: "yahei", label: "Microsoft YaHei", css: "'Microsoft YaHei', 'Segoe UI', sans-serif" },
  { value: "pingfang", label: "PingFang SC", css: "'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { value: "noto", label: "Noto Sans", css: "'Noto Sans', 'Noto Sans CJK SC', sans-serif" },
  { value: "jp", label: "Japanese Sans", css: "'Yu Gothic', 'Hiragino Sans', 'Noto Sans JP', sans-serif" },
  { value: "kr", label: "Korean Sans", css: "'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif" },
  { value: "serif", label: "Serif", css: "Georgia, 'Times New Roman', serif" },
  { value: "mono", label: "Monospace", css: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace" },
];

// Available color themes. `mode` drives the `data-mode` attribute so that the
// generic light/dark component tweaks apply, while `value` drives `data-theme`
// for the actual palette. `swatch` is the dot shown in the theme picker.
const THEME_OPTIONS: {
  value: string;
  mode: "light" | "dark";
  labelZh: string;
  label: string;
  swatch: { bg: string; border: string; accent: string };
}[] = [
  { value: "light", mode: "light", labelZh: "浅色", label: "Light", swatch: { bg: "#ffffff", border: "#e5e5e5", accent: "#2f9e6f" } },
  { value: "dark", mode: "dark", labelZh: "深色", label: "Dark", swatch: { bg: "#2f2f2f", border: "#424242", accent: "#45b385" } },
  { value: "yuzu", mode: "light", labelZh: "柚木书房", label: "Yuzu Study", swatch: { bg: "#f3e8d6", border: "#d8c4a0", accent: "#a9743f" } },
  { value: "ember", mode: "dark", labelZh: "炭火终端", label: "Ember Terminal", swatch: { bg: "#1b1d19", border: "#3a3f33", accent: "#9bcf5f" } },
  { value: "grape", mode: "dark", labelZh: "午夜葡萄", label: "Midnight Grape", swatch: { bg: "#221631", border: "#3e2a52", accent: "#c084fc" } },
  { value: "amber", mode: "dark", labelZh: "暮光琥珀", label: "Twilight Amber", swatch: { bg: "#221a14", border: "#46352b", accent: "#f0a868" } },
];

const themeMode = (theme: string): "light" | "dark" =>
  THEME_OPTIONS.find((t) => t.value === theme)?.mode ?? "light";

const modelContextLimit = (modelId: string) => {
  const id = modelId.toLowerCase();
  if (id.includes("gpt-4o") || id.includes("gpt-4.1") || id.includes("gpt-5")) return 128000;
  if (id.includes("claude")) return 200000;
  if (id.includes("gemini")) return 1000000;
  if (id.includes("deepseek")) return 64000;
  if (id.includes("qwen")) return 128000;
  if (id.includes("llama")) return 128000;
  return 128000;
};

function App() {
  // ==========================================
  // Config & State
  // ==========================================

  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [configSaveStatus, setConfigSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const lastSavedConfigRef = useRef("");
  const onboardingInitializedRef = useRef(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingConnection, setOnboardingConnection] = useState<ConnectionCheck>({ state: "idle" });
  const [onboardingValues, setOnboardingValues] = useState<OnboardingValues>({
    mode: "chat",
    profileId: null,
    provider: DEFAULT_CONFIG.provider,
    wireFormat: DEFAULT_CONFIG.wire_format,
    baseUrl: DEFAULT_CONFIG.base_url,
    apiKey: DEFAULT_CONFIG.api_key,
    model: DEFAULT_CONFIG.model,
    workDir: DEFAULT_CONFIG.default_work_dir,
  });
  const onboardingValuesRef = useRef(onboardingValues);
  const onboardingTestSequenceRef = useRef(0);
  const [currentSessionId, setCurrentSessionId] = useState(
    () => localStorage.getItem("gx_current_session") || "default"
  );

  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem("gx_drafts");
      if (saved) return JSON.parse(saved);
      const legacy = localStorage.getItem("gx_draft");
      if (legacy) return { [localStorage.getItem("gx_current_session") || "default"]: legacy };
    } catch { /* ignore corrupt drafts */ }
    return {};
  });
  const prompt = draftsBySession[currentSessionId] || "";
  const setPrompt = useCallback((next: string | ((previous: string) => string)) => {
    setDraftsBySession((previous) => {
      const current = previous[currentSessionId] || "";
      const value = typeof next === "function" ? next(current) : next;
      return { ...previous, [currentSessionId]: value };
    });
  }, [currentSessionId]);

  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, Attachment[]>>({});
  const attachments = attachmentsBySession[currentSessionId] || [];
  const [attachmentLoadingBySession, setAttachmentLoadingBySession] = useState<Record<string, boolean>>({});
  const isAttachmentLoading = Boolean(attachmentLoadingBySession[currentSessionId]);
  const hasAttachmentLoading = Object.values(attachmentLoadingBySession).some(Boolean);
  const setAttachments = useCallback((next: Attachment[] | ((previous: Attachment[]) => Attachment[])) => {
    setAttachmentsBySession((previous) => {
      const current = previous[currentSessionId] || [];
      const value = typeof next === "function" ? next(current) : next;
      return { ...previous, [currentSessionId]: value };
    });
  }, [currentSessionId]);

  // Global hotkeys
  useGlobalHotkeys(() => createNewSession());

  const [editingSessionTitle, setEditingSessionTitle] = useState(false);
  const { menu, handleContextMenu, closeMenu } = useContextMenu();

  // Auto-save drafts per session — debounced so each keystroke does not hit localStorage.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem("gx_drafts", JSON.stringify(draftsBySession));
        localStorage.removeItem("gx_draft");
      } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(timer);
  }, [draftsBySession]);

  // Listen for tray menu events
  useEffect(() => {
    const unlisten = listen<void>('open-settings', () => {
      setSettingsOpen(true);
    });
    return () => {
      unlisten.then(fn => fn());
    };
  }, []);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [mcpStatusByName, setMcpStatusByName] = useState<Record<string, Pick<McpServerView, "state" | "toolCount" | "message">>>({});

  const [activeRunSessionId, setActiveRunSessionId] = useState<string | null>(null);
  const [preparingRequestSessionId, setPreparingRequestSessionId] = useState<string | null>(null);
  const [runtimeBySession, setRuntimeBySession] = useState<Record<string, SessionRuntime | null>>({});
  const [checkpointBySession, setCheckpointBySession] = useState<Record<string, RunCheckpoint | null>>({});
  const isStreaming = activeRunSessionId === currentSessionId;
  const hasActiveRequest = activeRunSessionId !== null;
  const hasPendingRequest = hasActiveRequest || preparingRequestSessionId !== null;
  const currentRuntime = runtimeBySession[currentSessionId] || null;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("model");
  const [activeTab, setActiveTab] = useState<"activity" | "files" | "preview">("activity");
  const [previewBySession, setPreviewBySession] = useState<Record<string, string>>({});
  const previewSrc = previewBySession[currentSessionId] || "";
  const setPreviewSrc = useCallback((next: string | ((previous: string) => string)) => {
    setPreviewBySession((previous) => {
      const current = previous[currentSessionId] || "";
      const value = typeof next === "function" ? next(current) : next;
      return { ...previous, [currentSessionId]: value };
    });
  }, [currentSessionId]);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [newProfileName, setNewProfileName] = useState("");
  const [modifiedFilesBySession, setModifiedFilesBySession] = useState<Record<string, Record<string, { old: string; new: string }>>>({});
  const modifiedFiles = modifiedFilesBySession[currentSessionId] || {};
  const [diffView, setDiffView] = useState(false);
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
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [workspaceBySession, setWorkspaceBySession] = useState<Record<string, WorkspaceViewState>>({});
  const [terminalLogsBySession, setTerminalLogsBySession] = useState<Record<string, { text: string; type: "info" | "success" | "error" | "cmd" }[]>>({});
  const terminalLogs = terminalLogsBySession[currentSessionId] || [];
  const [previewConsoleLogsBySession, setPreviewConsoleLogsBySession] = useState<Record<string, { text: string; type: "log" | "error" | "warn" | "info" }[]>>({});
  const previewConsoleLogs = previewConsoleLogsBySession[currentSessionId] || [];
  const setPreviewConsoleLogs = useCallback((next: { text: string; type: "log" | "error" | "warn" | "info" }[] | ((previous: { text: string; type: "log" | "error" | "warn" | "info" }[]) => { text: string; type: "log" | "error" | "warn" | "info" }[])) => {
    setPreviewConsoleLogsBySession((previous) => {
      const current = previous[currentSessionId] || [];
      const value = typeof next === "function" ? next(current) : next;
      return { ...previous, [currentSessionId]: value };
    });
  }, [currentSessionId]);
  const [toasts, setToasts] = useState<ToastNotice[]>([]);
  const {
    saveSession,
    saveSessions,
    loadSessions,
    deleteSession: deleteStoredSession,
  } = useSessionStorage();

  const [sessions, setSessions] = useState<ChatSession[]>(readLocalSessions);
  const [sessionStorageReady, setSessionStorageReady] = useState(false);
  const sessionMutationLocked = !sessionStorageReady || hasPendingRequest;
  const [sessionSaveStatus, setSessionSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const [pendingApprovalsBySession, setPendingApprovalsBySession] = useState<Record<string, PendingApproval | null>>({});
  const pendingApprovals = pendingApprovalsBySession[currentSessionId] || null;
  const [approvalSubmittingBySession, setApprovalSubmittingBySession] = useState<Record<string, boolean>>({});
  const approvalSubmitting = Boolean(approvalSubmittingBySession[currentSessionId]);
  const [usageStatsBySession, setUsageStatsBySession] = useState<Record<string, UsageStats | null>>({});
  const usageStats = usageStatsBySession[currentSessionId] || null;
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [toolStatsDialog, setToolStatsDialog] = useState<ToolStatsDialog | null>(null);
  const [sidebarNav, setSidebarNav] = useState<"chat" | "code">("chat");
  const [editingMessageIdxBySession, setEditingMessageIdxBySession] = useState<Record<string, number | null>>({});
  const editingMessageIdx = editingMessageIdxBySession[currentSessionId] ?? null;
  const setEditingMessageIdx = useCallback((value: number | null) => {
    setEditingMessageIdxBySession((previous) => ({ ...previous, [currentSessionId]: value }));
  }, [currentSessionId]);
  const [editTextBySession, setEditTextBySession] = useState<Record<string, string>>({});
  const editText = editTextBySession[currentSessionId] || "";
  const setEditText = useCallback((value: string) => {
    setEditTextBySession((previous) => ({ ...previous, [currentSessionId]: value }));
  }, [currentSessionId]);

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
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const historyListRef = useRef<HTMLDivElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const sessionSettingsPanelRef = useRef<HTMLDivElement>(null);
  const sessionSettingsToggleRef = useRef<HTMLButtonElement>(null);
  const isAtBottomRef = useRef(true);
  const currentSessionIdRef = useRef(currentSessionId);
  const sidebarNavRef = useRef(sidebarNav);
  const lastSessionByModeRef = useRef<Partial<Record<SessionConfig["mode"], string>>>({});
  const isStreamingRef = useRef(false);
  const requestStartingRef = useRef(false);
  const activeRequestIdRef = useRef("");
  const activeRequestSessionIdRef = useRef("");
  const activeRequestModelRef = useRef("");
  const activeRequestContextTokensRef = useRef(0);
  const activeRequestWorkDirRef = useRef("");
  const requestSessionByIdRef = useRef<Record<string, string>>({});
  const mcpRuntimeNamesByRequestRef = useRef<Record<string, string[]>>({});
  const streamedToolOutputKeysRef = useRef<Set<string>>(new Set());
  const workspaceRequestSequenceRef = useRef<Record<string, number>>({});
  const fileRequestSequenceRef = useRef<Record<string, number>>({});
  const effectiveWorkDirRef = useRef("");
  const langRef = useRef("zh");
  const selectedFileRef = useRef<string | null>(null);
  const switchSidebarModeRef = useRef<(mode: SessionConfig["mode"]) => void>(() => {});
  const lastPersistedSessionsRef = useRef<Record<string, string>>({});
  const sessionPersistenceEpochRef = useRef(0);
  // Stream token batching: accumulate chunks and flush once per animation frame
  // so a burst of tokens triggers one setSessions/render instead of one per token.
  const streamBufferRef = useRef<{
    requestId: string;
    sessionId: string;
    text: string;
    model: string;
    contextTokens: number;
  } | null>(null);
  const streamFlushRafRef = useRef<number | null>(null);
  const flushStreamBufferNowRef = useRef<() => void>(() => {});
  const closeSessionSettings = useCallback((restoreFocus = false) => {
    setSessionSettingsOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => sessionSettingsToggleRef.current?.focus());
    }
  }, []);

  // Keep the input textarea height in sync with its content. This auto-shrinks
  // the box back after sending (prompt → "") and after programmatic sets.
  useLayoutEffect(() => {
    const el = chatTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [prompt]);

  // Keep the ref in sync with the reactive state
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    sidebarNavRef.current = sidebarNav;
  }, [sidebarNav]);

  useEffect(() => {
    isStreamingRef.current = hasActiveRequest;
  }, [hasActiveRequest]);

  useLayoutEffect(() => {
    if (settingsOpen && settingsBodyRef.current) {
      settingsBodyRef.current.scrollTop = 0;
    }
  }, [settingsOpen, settingsTab]);

  useEffect(() => {
    if (!sessionSettingsOpen) return;
    const panel = sessionSettingsPanelRef.current;
    if (!panel) return;
    panel.focus();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.contains(target) || sessionSettingsToggleRef.current?.contains(target)) return;
      closeSessionSettings(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSessionSettings(true);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    panel.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      panel.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeSessionSettings, sessionSettingsOpen]);

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId) || sessions[0] || createDefaultSession(),
    [sessions, currentSessionId]
  );
  const activeRunSession = activeRunSessionId
    ? sessions.find((session) => session.id === activeRunSessionId) || null
    : null;
  const activeRunRuntime = activeRunSessionId ? runtimeBySession[activeRunSessionId] || null : null;
  const currentMode = currentSession.sessionConfig.mode || "chat";
  useEffect(() => {
    lastSessionByModeRef.current[currentMode] = currentSession.id;
  }, [currentMode, currentSession.id]);

  const visibleSessions = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    return sessions
      .filter((session) => (session.sessionConfig.mode || "chat") === sidebarNav)
      .filter((session) => {
        if (!query) return true;
        if ((session.title || "").toLowerCase().includes(query)) return true;
        return session.messages
          .slice(-10)
          .some((message) => message.content.toLowerCase().includes(query));
      })
      .sort(compareSidebarSessions);
  }, [debouncedSearch, sessions, sidebarNav]);
  const tabbableSessionId = visibleSessions.some((session) => session.id === currentSessionId)
    ? currentSessionId
    : visibleSessions[0]?.id;

  useLayoutEffect(() => {
    const list = historyListRef.current;
    if (!list) return;
    const activeItem = Array.from(list.querySelectorAll<HTMLElement>(".history-item"))
      .find((item) => item.dataset.sessionId === currentSessionId);
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [currentSessionId, sidebarNav, visibleSessions.length]);
  const lang = config.language || "zh";
  const currentLocale = LANGUAGE_OPTIONS.find((l) => l.code === lang)?.locale || "en-US";
  const searchMode = currentSession.sessionConfig.searchMode || "auto";
  const webSearchAvailable = config.tools_enabled.includes("web_search");
  const effectiveSearchMode = webSearchAvailable ? searchMode : "off";
  const resolvedCurrentConfig = useMemo(
    () => resolveRequestConfig(config, currentSession.sessionConfig, effectiveSearchMode),
    [config, currentSession.sessionConfig, effectiveSearchMode],
  );
  const effectiveWorkDir = resolvedCurrentConfig.default_work_dir;
  const currentWorkspace = workspaceBySession[currentSessionId] || createEmptyWorkspaceState();

  useEffect(() => {
    if (!configReady || onboardingInitializedRef.current) return;
    onboardingInitializedRef.current = true;

    const initialOnboardingValues: OnboardingValues = {
      mode: currentMode,
      profileId: currentSession.sessionConfig.profileId,
      provider: resolvedCurrentConfig.provider,
      wireFormat: resolvedCurrentConfig.wire_format,
      baseUrl: resolvedCurrentConfig.base_url,
      apiKey: resolvedCurrentConfig.api_key,
      model: resolvedCurrentConfig.model,
      workDir: effectiveWorkDir,
    };
    onboardingValuesRef.current = initialOnboardingValues;
    setOnboardingValues(initialOnboardingValues);

    let onboardingHandled = false;
    try {
      onboardingHandled = localStorage.getItem("gx_onboarding_v1") === "complete"
        || sessionStorage.getItem("gx_onboarding_v1_dismissed") === "true";
    } catch { /* ignore unavailable local storage */ }

    const customConnection = config.base_url !== DEFAULT_CONFIG.base_url
      || config.model !== DEFAULT_CONFIG.model;
    const existingSetup = Object.keys(config.profiles).length > 0
      || config.provider === "ollama"
      || Boolean(config.api_key.trim())
      || customConnection;

    if (existingSetup && !onboardingHandled) {
      try { localStorage.setItem("gx_onboarding_v1", "complete"); } catch { /* ignore */ }
    }
    setOnboardingOpen(!existingSetup && !onboardingHandled);
  }, [configReady, config, currentMode, currentSession.sessionConfig.profileId, effectiveWorkDir, resolvedCurrentConfig]);

  const createRequestId = () => `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  useEffect(() => {
    effectiveWorkDirRef.current = effectiveWorkDir;
  }, [effectiveWorkDir]);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  const isCurrentRequestPayload = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return true;
    const requestId = (payload as { requestId?: string }).requestId;
    return !requestId || requestId === activeRequestIdRef.current;
  };

  const payloadContent = (payload: AgentEventPayload) =>
    typeof payload === "string" ? payload : String(payload.content || "");

  const payloadRequestId = (payload?: unknown) => {
    if (!payload || typeof payload !== "object") return "";
    return String((payload as { requestId?: string }).requestId || "");
  };

  const agentEventSessionId = (payload?: unknown) => {
    const requestId = payloadRequestId(payload);
    return (requestId && requestSessionByIdRef.current[requestId])
      || activeRequestSessionIdRef.current
      || currentSessionIdRef.current;
  };

  const finishStreamingLocally = (expectedRequestId = activeRequestIdRef.current) => {
    if (expectedRequestId && activeRequestIdRef.current && expectedRequestId !== activeRequestIdRef.current) return;
    flushStreamBufferNowRef.current();
    const sessionId = activeRequestSessionIdRef.current;
    if (expectedRequestId) delete requestSessionByIdRef.current[expectedRequestId];
    isStreamingRef.current = false;
    activeRequestIdRef.current = "";
    activeRequestSessionIdRef.current = "";
    if (sessionId) {
      setPendingApprovalsBySession((previous) => ({ ...previous, [sessionId]: null }));
      setApprovalSubmittingBySession((previous) => ({ ...previous, [sessionId]: false }));
      setRuntimeBySession((previous) => ({ ...previous, [sessionId]: null }));
    }
    setActiveRunSessionId(null);
    setTimeout(() => chatTextareaRef.current?.focus(), 100);
  };

  const upsertToolActions = (messages: Message[], incoming: ToolAction[]) => {
    const next = [...messages];
    if (next.length === 0 || next[next.length - 1].role !== "assistant") {
      next.push({
        role: "assistant",
        content: "",
        actions: incoming,
        timestamp: Date.now(),
        model: activeRequestModelRef.current,
        contextTokens: activeRequestContextTokensRef.current,
      });
      return next;
    }

    const last = { ...next[next.length - 1] };
    const actions = last.actions ? [...last.actions] : [];
    for (const action of incoming) {
      const idx = actions.findIndex((a) => a.id === action.id);
      if (idx >= 0) {
        const merged = { ...actions[idx], ...action };
        if (!action.arguments && actions[idx].arguments) {
          merged.arguments = actions[idx].arguments;
        }
        actions[idx] = merged;
      } else {
        actions.push(action);
      }
    }
    last.actions = actions;
    next[next.length - 1] = last;
    return next;
  };

  useEffect(() => {
    setRightPanelOpen(currentMode === "code");
    setSidebarNav(currentMode);
  }, [currentMode]);

  // ==========================================
  // Theme
  // ==========================================

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        switchSidebarModeRef.current(sidebarNavRef.current === "chat" ? "code" : "chat");
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
        if (toolStatsDialog) { setToolStatsDialog(null); return; }
        if (rolePresetsOpen) { setRolePresetsOpen(false); setCustomPresetForm(false); setEditingCustomPreset(null); return; }
        if (modelPickerOpen) { setModelPickerOpen(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (sessionSettingsOpen) { closeSessionSettings(true); return; }
        if (rightPanelOpen && window.matchMedia("(max-width: 980px)").matches) {
          setRightPanelOpen(false);
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu, toolStatsDialog, rolePresetsOpen, modelPickerOpen, settingsOpen, sessionSettingsOpen, rightPanelOpen]);

  useEffect(() => {
    const theme = config.theme || "light";
    const mode = themeMode(theme);
    document.documentElement.setAttribute("data-theme", theme);
    // data-mode drives the light/dark component tweaks so any dark-family theme
    // inherits them without duplicating every override per theme.
    document.documentElement.setAttribute("data-mode", mode);
  }, [config.theme]);

  useEffect(() => {
    document.documentElement.lang = config.language || "zh";
  }, [config.language]);

  useEffect(() => {
    document.documentElement.style.setProperty("--dynamic-font-size", `${config.font_size || 14}px`);
  }, [config.font_size]);

  useEffect(() => {
    const selected = FONT_OPTIONS.find((font) => font.value === (config.font_family || "system")) || FONT_OPTIONS[0];
    document.documentElement.style.setProperty("--app-font-family", selected.css);
  }, [config.font_family]);

  useEffect(() => {
    const handleIframeMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "iframe-console-log") {
        const { logType, text } = event.data;
        const sessionId = currentSessionIdRef.current;
        setPreviewConsoleLogsBySession((previous) => {
          const next = [...(previous[sessionId] || []), { text, type: logType }];
          return { ...previous, [sessionId]: next.length > 200 ? next.slice(-200) : next };
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

  useEffect(() => {
    const unlisten = listen<string>("config-import-warning", (event) => {
      addLog(event.payload, "info", true);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Header quick-toggle: flip between light and dark. If the active theme is a
  // custom dark theme, this jumps to the plain light theme and vice versa.
  const toggleTheme = () => {
    setConfig((prev) => {
      const current = THEME_OPTIONS.find((th) => th.value === prev.theme);
      const isDark = current?.mode === "dark";
      return { ...prev, theme: isDark ? "light" : "dark" };
    });
  };

  // ==========================================
  // Init logs with language
  // ==========================================

  useEffect(() => {
    const sessionId = currentSessionIdRef.current;
    setTerminalLogsBySession((previous) => ({
      ...previous,
      [sessionId]: [
        { text: t("log.init", lang), type: "info" },
        { text: t("log.backend", lang), type: "info" },
      ],
    }));
  }, []);

  // ==========================================
  // Resize handlers
  // ==========================================

  const handleSidebarDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingSidebar(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(180, Math.min(400, startWidth + delta));
      latestWidth = newWidth;
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      setDraggingSidebar(false);
      try { localStorage.setItem("gx_sidebar_width", String(latestWidth)); } catch { /* ignore */ }
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
    let latestWidth = startWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const newWidth = Math.max(200, Math.min(600, startWidth + delta));
      latestWidth = newWidth;
      setRightPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      setDraggingRight(false);
      try { localStorage.setItem("gx_right_panel_width", String(latestWidth)); } catch { /* ignore */ }
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
        const nextConfig = { ...DEFAULT_CONFIG, ...loadedConfig };
        lastSavedConfigRef.current = JSON.stringify(nextConfig);
        setConfig(nextConfig);
        setPresets(loadedPresets);
      } catch (e) {
        console.error("Failed to load config:", e);
        try {
          const loadedPresets = await invoke<ProviderPreset[]>("get_provider_presets");
          setPresets(loadedPresets);
        } catch { /* ignore */ }
      } finally {
        setConfigReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!configReady) return;
    const serialized = JSON.stringify(config);
    if (serialized === lastSavedConfigRef.current) return;

    setConfigSaveStatus("saving");
    const timer = window.setTimeout(async () => {
      try {
        await invoke("save_config", { config });
        lastSavedConfigRef.current = serialized;
        setConfigSaveStatus("saved");
      } catch (error) {
        console.error("Failed to auto-save config:", error);
        setConfigSaveStatus("error");
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [config, configReady]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const loadedSessions = await loadSessions();
      if (cancelled) return;
      if (loadedSessions !== null) {
        const storedSessions = normalizeSessions(loadedSessions);
        lastPersistedSessionsRef.current = Object.fromEntries(
          storedSessions.map((session) => [session.id, JSON.stringify(session)]),
        );
        setSessions(storedSessions);
        setCurrentSessionId((prev) =>
          storedSessions.some((session) => session.id === prev) ? prev : storedSessions[0].id
        );
        try {
          localStorage.setItem("gx_sessions", JSON.stringify(storedSessions));
        } catch { /* backend remains authoritative */ }
      }

      setSessionStorageReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!sessionStorageReady) return;

    let cancelled = false;
    const persistenceEpoch = sessionPersistenceEpochRef.current;
    const persist = async () => {
      if (persistenceEpoch !== sessionPersistenceEpochRef.current) return;
      const data = JSON.stringify(sessions);

      try {
        if (data.length > 4 * 1024 * 1024) {
          const trimmed = sessions.map((s: ChatSession) => ({
            ...s,
            messages: s.messages.slice(-20).map((m) => (
              m.attachments
                ? {
                    ...m,
                    attachments: m.attachments.map((att) =>
                      att.type === "image" ? { ...att, data: "" } : att
                    ),
                  }
                : m
            )),
          }));
          localStorage.setItem("gx_sessions", JSON.stringify(trimmed));
        } else {
          localStorage.setItem("gx_sessions", data);
        }
      } catch {
        try { localStorage.removeItem("gx_sessions"); } catch { /* quota exceeded, nothing to do */ }
      }

      const changed = sessions
        .map((session) => ({ session, serialized: JSON.stringify(session) }))
        .filter(({ session, serialized }) => lastPersistedSessionsRef.current[session.id] !== serialized);
      if (changed.length === 0) return;

      setSessionSaveStatus("saving");
      try {
        await Promise.all(changed.map(({ session }) => saveSession(session)));
        if (cancelled || persistenceEpoch !== sessionPersistenceEpochRef.current) return;
        for (const { session, serialized } of changed) {
          lastPersistedSessionsRef.current[session.id] = serialized;
        }
        setSessionSaveStatus("saved");
      } catch (error) {
        if (!cancelled) setSessionSaveStatus("error");
        console.error("Failed to persist changed sessions:", error);
      }
    };

    // While streaming, defer persistence until tokens stop arriving. The
    // stream-complete handler flips isStreaming, re-running this effect and
    // persisting the final state once.
    const delay = hasActiveRequest ? 1500 : 400;
    const timer = setTimeout(() => { void persist(); }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [saveSession, sessionStorageReady, sessions, hasActiveRequest]);

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

  const ALL_PRESETS = useMemo(() => [...ROLE_PRESETS, ...customPresets], [customPresets]);
  const activeRolePresetFingerprint = useMemo(
    () => sessions
      .map((session) => `${session.id}:${session.sessionConfig.activeRolePresetId || ""}`)
      .join("\u0000"),
    [sessions],
  );

  // A preset id is the source of truth while a role is active. Keep the
  // session snapshot current after loading/importing sessions or editing a
  // custom preset, and remove stale ids instead of showing a false "active"
  // state in the UI.
  useEffect(() => {
    setSessions((previous) => {
      let changed = false;
      const next = previous.map((session) => {
        const presetId = session.sessionConfig.activeRolePresetId;
        if (!presetId) return session;

        const preset = ALL_PRESETS.find((candidate) => candidate.id === presetId);
        if (!preset) {
          changed = true;
          return {
            ...session,
            sessionConfig: {
              ...session.sessionConfig,
              activeRolePresetId: null,
            },
          };
        }

        if (
          session.sessionConfig.systemPrompt === preset.prompt
          && session.sessionConfig.temperature === preset.temperature
        ) {
          return session;
        }

        changed = true;
        return {
          ...session,
          sessionConfig: {
            ...session.sessionConfig,
            systemPrompt: preset.prompt,
            temperature: preset.temperature,
          },
        };
      });
      return changed ? next : previous;
    });
  }, [ALL_PRESETS, activeRolePresetFingerprint]);

  useEffect(() => {
    if (!isAtBottomRef.current) return;
    // Virtualized path scrolls via the Virtuoso handle; plain path scrolls the container.
    if (virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({
        index: currentSession.messages.length - 1,
        align: "end",
        behavior: "auto",
      });
    } else if (chatContainerRef.current) {
      const el = chatContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [currentSession.messages, isStreaming]);

  useEffect(() => {
    const previousWorkspace = workspaceBySession[currentSessionId];
    if (previousWorkspace && previousWorkspace.workDir !== effectiveWorkDir) {
      setModifiedFilesBySession((previous) => ({ ...previous, [currentSessionId]: {} }));
      setPreviewBySession((previous) => ({ ...previous, [currentSessionId]: "" }));
    }
    fileRequestSequenceRef.current[currentSessionId] = (fileRequestSequenceRef.current[currentSessionId] || 0) + 1;
    setFileContent(null);
    setSelectedFile(null);
    void refreshWorkspace(currentSessionId, effectiveWorkDir);
  }, [currentSessionId, effectiveWorkDir]);

  // ==========================================
  // Helpers
  // ==========================================

  const MAX_LOG_LINES = 500;
  const notify = (text: string, type: "info" | "success" | "error" | "cmd" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-3), { id, text, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 3200);
  };

  const addLog = (
    text: string,
    type: "info" | "success" | "error" | "cmd" = "info",
    showToast = false,
    sessionId = currentSessionIdRef.current,
  ) => {
    setTerminalLogsBySession((previous) => {
      const next = [...(previous[sessionId] || []), { text, type }];
      return {
        ...previous,
        [sessionId]: next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next,
      };
    });
    if (showToast) notify(text, type);
  };

  const estimateTextTokens = (text: string) => {
    const value = text || "";
    const nonAscii = (value.match(/[^\x00-\x7f]/g) || []).length;
    return Math.ceil((value.length - nonAscii) / 4 + nonAscii);
  };

  const estimateMessagesTokens = (messages: Message[]) =>
    messages
      .filter((m) => m.role !== "context_divider")
      .reduce((sum, msg) => {
        const content = msg.variants ? (msg.variants[msg.currentVariantIndex || 0] || msg.content) : msg.content;
        const attachmentTokens = (msg.attachments || []).reduce((attSum, att) => {
          if (att.type === "image" && att.data) return attSum + 1100;
          return attSum + estimateTextTokens(att.data || "");
        }, 0);
        return sum + estimateTextTokens(content) + attachmentTokens + 6;
      }, 0);

  const formatTokenCount = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);

  const formatDuration = (ms?: number) => {
    if (ms == null) return "";
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  };

  const imageExtensionFromMime = (mimeType: string) => {
    const subtype = mimeType.split("/")[1]?.split(";")[0]?.toLowerCase();
    if (!subtype) return "png";
    return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/g, "") || "png";
  };

  const pastedImageName = (mimeType: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `pasted-image-${stamp}.${imageExtensionFromMime(mimeType)}`;
  };

  const readFileAsAttachment = async (file: File): Promise<Attachment> => {
    const name = file.name || (file.type.startsWith("image/") ? pastedImageName(file.type || "image/png") : "pasted-file.txt");
    if (file.type.startsWith("image/")) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error(lang === "zh"
          ? `${name} 超过 20 MB 图片上限。`
          : `${name} exceeds the 20 MB image limit.`);
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(String(ev.target?.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
        reader.readAsDataURL(file);
      });
      return { name, type: "image", data, mimeType: file.type || "image/png", originalSize: file.size };
    }

    const extension = name.split(".").pop()?.toLowerCase() || "";
    const nativeDocuments = ["pdf", "docx", "xlsx", "pptx"];
    if (nativeDocuments.includes(extension)) {
      throw new Error(lang === "zh"
        ? `${name} 是二进制文档，请使用附件按钮通过原生解析器添加。`
        : `${name} is a binary document. Use the attachment button so it can be parsed.`);
    }
    if (["doc", "xls", "ppt", "zip", "7z"].includes(extension)) {
      throw new Error(lang === "zh"
        ? `${name} 的格式暂不支持，请先转换为 PDF、DOCX、XLSX、PPTX 或文本。`
        : `${name} is not supported yet. Convert it to PDF, DOCX, XLSX, PPTX, or text first.`);
    }

    const textSlice = file.slice(0, MAX_ATTACHMENT_TEXT_PER_FILE * 4);
    const text = await textSlice.text();
    const data = text.substring(0, MAX_ATTACHMENT_TEXT_PER_FILE);
    return {
      name,
      type: "text",
      data,
      mimeType: file.type || "text/plain",
      truncated: file.size > textSlice.size || data.length < text.length,
      originalSize: file.size,
    };
  };

  const reportAttachmentFit = (
    fitted: ReturnType<typeof fitAttachmentBudget>,
    sessionId: string,
    warnedNames: Set<string> = new Set(),
  ) => {
    const unexplainedInvalid = fitted.invalid.filter((name) => !warnedNames.has(name));
    if (unexplainedInvalid.length > 0) {
      addLog(lang === "zh"
        ? `没有可发送内容，未添加：${unexplainedInvalid.join("、")}`
        : `No sendable content was found. Not added: ${unexplainedInvalid.join(", ")}`, "error", true, sessionId);
    }
    if (fitted.overBudget.length > 0) {
      addLog(lang === "zh"
        ? `附件超出限制（文本共 100,000 字符；图片单张 20 MB、最多 8 张且共 40 MB），未添加：${fitted.overBudget.join("、")}`
        : `Attachment limits were exceeded (100,000 text characters; images: 20 MB each, 8 files and 40 MB total). Not added: ${fitted.overBudget.join(", ")}`, "error", true, sessionId);
    }
  };

  const addFilesAsAttachments = async (files: File[], targetSessionId = currentSessionId) => {
    if (!sessionStorageReady || files.length === 0 || attachmentLoadingBySession[targetSessionId]) return;
    setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: true }));
    try {
      const existingAttachments = attachmentsBySession[targetSessionId] || [];
      let plannedImageCount = existingAttachments.filter((attachment) => attachment.type === "image" && isSendableAttachment(attachment)).length;
      let plannedImageBytes = existingAttachments
        .filter((attachment) => attachment.type === "image" && isSendableAttachment(attachment))
        .reduce((sum, attachment) => sum + estimateImageAttachmentBytes(attachment), 0);
      const preRejectedImages: string[] = [];
      const filesToRead = files.filter((file) => {
        if (!file.type.startsWith("image/")) return true;
        if (file.size > MAX_IMAGE_ATTACHMENT_BYTES
          || plannedImageCount >= MAX_IMAGE_ATTACHMENT_COUNT
          || plannedImageBytes + file.size > MAX_IMAGE_ATTACHMENT_TOTAL_BYTES) {
          preRejectedImages.push(file.name || pastedImageName(file.type || "image/png"));
          return false;
        }
        plannedImageCount += 1;
        plannedImageBytes += file.size;
        return true;
      });
      const results = await Promise.allSettled(filesToRead.map(readFileAsAttachment));
      const next = results
        .filter((result): result is PromiseFulfilledResult<Attachment> => result.status === "fulfilled")
        .map((result) => result.value);
      const fitted = fitAttachmentBudget(existingAttachments, next);
      fitted.overBudget.push(...preRejectedImages);
      if (fitted.accepted.length > 0) {
        setAttachmentsBySession((previous) => ({
          ...previous,
          [targetSessionId]: [...(previous[targetSessionId] || []), ...fitted.accepted],
        }));
      }
      reportAttachmentFit(fitted, targetSessionId);
      for (const result of results) {
        if (result.status === "rejected") {
          addLog(`${lang === "zh" ? "添加附件失败" : "Failed to attach file"}: ${result.reason}`, "error", true, targetSessionId);
        }
      }
    } finally {
      setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: false }));
    }
  };

  const pickAndParseAttachments = async () => {
    type ParsedFile = {
      name: string;
      path: string;
      kind: string;
      content: string;
      mimeType: string;
      truncated: boolean;
      warning?: string | null;
    };
    const targetSessionId = currentSessionId;
    if (!sessionStorageReady || attachmentLoadingBySession[targetSessionId]) return;
    setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: true }));
    try {
      const parsed = await invoke<ParsedFile[]>("pick_and_parse_files");
      const next: Attachment[] = parsed.map((file) => {
        if (file.kind === "image") {
          return {
            name: file.name,
            path: file.path,
            type: "image",
            data: file.content ? `data:${file.mimeType};base64,${file.content}` : "",
            mimeType: file.mimeType,
            originalSize: Math.max(0, Math.floor(file.content.length * 3 / 4)),
            warning: file.warning || undefined,
          };
        }
        const data = file.content.slice(0, MAX_ATTACHMENT_TEXT_PER_FILE);
        const emptyWarning = !file.warning && !data.trim()
          ? (lang === "zh" ? "没有提取到可发送的文本；扫描版 PDF 需要先做 OCR。" : "No sendable text was extracted. Scanned PDFs need OCR first.")
          : undefined;
        return {
          name: file.name,
          path: file.path,
          type: "text",
          data,
          mimeType: file.mimeType,
          originalSize: file.content.length,
          truncated: file.truncated || data.length < file.content.length,
          warning: file.warning || emptyWarning,
        };
      });
      const fitted = fitAttachmentBudget(attachmentsBySession[targetSessionId] || [], next);
      if (fitted.accepted.length > 0) {
        setAttachmentsBySession((previous) => ({
          ...previous,
          [targetSessionId]: [...(previous[targetSessionId] || []), ...fitted.accepted],
        }));
      }
      const warnedNames = new Set(next.filter((file) => file.warning).map((file) => file.name));
      for (const file of next) {
        if (file.warning) addLog(`${file.name}: ${file.warning}`, "error", true, targetSessionId);
        else if (file.truncated) addLog(`${file.name}: ${lang === "zh" ? "内容过长，已截断" : "content was truncated"}`, "info", true, targetSessionId);
      }
      reportAttachmentFit(fitted, targetSessionId, warnedNames);
    } catch (error) {
      addLog(`${lang === "zh" ? "添加附件失败" : "Failed to attach files"}: ${error}`, "error", true, targetSessionId);
    } finally {
      setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: false }));
    }
  };

  const imageAttachmentsForApi = (list: Attachment[]) =>
    list.filter((att) => att.type === "image" && att.data);

  const buildPromptWithAttachments = (message: string, list: Attachment[]) => {
    const usable = list.filter(isSendableAttachment);
    if (usable.length === 0) return message;
    const parts = usable.map((att) => {
      if (att.type === "image") {
        return `[Attached Image: ${att.name}]`;
      }
      const longestFence = Math.max(2, ...(att.data.match(/`+/g) || []).map((run) => run.length));
      const fence = "`".repeat(longestFence + 1);
      return `[Attached File: ${att.name}]\n${fence}\n${att.data}\n${fence}`;
    });
    const trimmed = message.trim();
    return trimmed ? `${parts.join("\n\n")}\n\n${trimmed}` : parts.join("\n\n");
  };

  const serializeMessageForApi = (message: Message) => {
    if (!["user", "assistant", "system"].includes(message.role)) return null;
    const imgs = imageAttachmentsForApi(message.attachments || []);
    const rawContent = message.variants
      ? (message.variants[message.currentVariantIndex || 0] || message.content)
      : message.content;
    const content = message.role === "user"
      ? buildPromptWithAttachments(rawContent, message.attachments || [])
      : rawContent;
    if (message.role === "assistant" && !content.trim()) return null;
    return {
      role: message.role,
      content,
      ...(message.role === "user" && imgs.length > 0 ? { attachments: imgs } : {}),
    };
  };

  const handlePasteImage = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const itemFiles = Array.from(e.clipboardData.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const fileList = itemFiles.length > 0
      ? itemFiles
      : Array.from(e.clipboardData.files || []).filter((file) => file.type.startsWith("image/"));

    if (fileList.length === 0) return;
    e.preventDefault();
    if (isAttachmentLoading || preparingRequestSessionId !== null) return;
    await addFilesAsAttachments(fileList);
  };

  const refreshWorkspace = async (sessionId = currentSessionIdRef.current, workDir = effectiveWorkDir) => {
    const sequence = (workspaceRequestSequenceRef.current[sessionId] || 0) + 1;
    workspaceRequestSequenceRef.current[sessionId] = sequence;
    if (!workDir.trim()) {
      setWorkspaceBySession((previous) => ({
        ...previous,
        [sessionId]: {
          workDir,
          repositoryRoot: "",
          root: null,
          branch: "",
          entries: [],
          selectedPath: null,
          diff: "",
          loading: false,
          treeError: lang === "zh" ? "请先设置工作目录" : "Choose a working directory first",
          changesError: "",
        },
      }));
      return;
    }
    setWorkspaceBySession((previous) => ({
      ...previous,
      [sessionId]: {
        ...(previous[sessionId] || createEmptyWorkspaceState()),
        workDir,
        loading: true,
        selectedPath: null,
        diff: "",
        treeError: "",
        changesError: "",
      },
    }));
    const [treeResult, statusResult] = await Promise.allSettled([
      invoke<DirectoryNode>("list_directory_tree", { workDir, maxDepth: 5, includeHidden: false }),
      invoke<{ repositoryRoot: string; branch: string; entries: GitStatusEntry[] }>("get_git_status", { workDir }),
    ]);
    if (workspaceRequestSequenceRef.current[sessionId] !== sequence) return;
    setWorkspaceBySession((previous) => ({
      ...previous,
      [sessionId]: {
        ...(previous[sessionId] || createEmptyWorkspaceState()),
        root: treeResult.status === "fulfilled" ? treeResult.value : null,
        repositoryRoot: statusResult.status === "fulfilled" ? statusResult.value.repositoryRoot : "",
        branch: statusResult.status === "fulfilled" ? statusResult.value.branch : "",
        entries: statusResult.status === "fulfilled" ? statusResult.value.entries : [],
        loading: false,
        treeError: treeResult.status === "rejected" ? String(treeResult.reason) : "",
        changesError: statusResult.status === "rejected" ? String(statusResult.reason) : "",
      },
    }));
  };

  const selectWorkspaceFile = async (node: DirectoryNode) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    const sequence = (fileRequestSequenceRef.current[sessionId] || 0) + 1;
    fileRequestSequenceRef.current[sessionId] = sequence;
    setSelectedFile(node.path);
    setFileContent(null);
    try {
      const content = await invoke<string>("read_file_content", { path: node.path, workDir });
      if (currentSessionIdRef.current !== sessionId
        || effectiveWorkDirRef.current !== workDir
        || fileRequestSequenceRef.current[sessionId] !== sequence) return;
      setSelectedFile(node.path);
      setFileContent(content);
    } catch (error) {
      addLog(`Failed to read file: ${error}`, "error", true, sessionId);
    }
  };

  const attachWorkspaceFile = async (node: DirectoryNode) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    if (attachmentLoadingBySession[sessionId] || sessionMutationLocked) {
      notify(lang === "zh" ? "请等待附件处理或请求准备完成。" : "Wait for attachment processing or request preparation to finish.", "info");
      return;
    }
    setAttachmentLoadingBySession((previous) => ({ ...previous, [sessionId]: true }));
    try {
      const content = await invoke<string>("read_file_content", { path: node.path, workDir });
      const data = content.slice(0, MAX_ATTACHMENT_TEXT_PER_FILE);
      const fitted = fitAttachmentBudget(attachmentsBySession[sessionId] || [], [{
        name: node.name,
        path: node.path,
        type: "text",
        data,
        mimeType: "text/plain",
        truncated: data.length < content.length,
        originalSize: content.length,
      }]);
      if (fitted.accepted.length > 0) {
        setAttachmentsBySession((previous) => ({
          ...previous,
          [sessionId]: [...(previous[sessionId] || []), ...fitted.accepted],
        }));
      }
      reportAttachmentFit(fitted, sessionId);
    } catch (error) {
      addLog(`Failed to attach file: ${error}`, "error", true, sessionId);
    } finally {
      setAttachmentLoadingBySession((previous) => ({ ...previous, [sessionId]: false }));
    }
  };

  const selectGitEntry = async (entry: GitStatusEntry) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    setWorkspaceBySession((previous) => ({
      ...previous,
      [sessionId]: { ...(previous[sessionId] || currentWorkspace), selectedPath: entry.path, diff: "" },
    }));
    try {
      const hasStaged = Boolean(entry.indexStatus.trim() && entry.indexStatus !== "?");
      const hasWorktree = Boolean(entry.worktreeStatus.trim()) || entry.worktreeStatus === "?";
      const [stagedResult, worktreeResult] = await Promise.all([
        hasStaged
          ? invoke<string>("get_git_diff", { workDir, path: entry.path, staged: true })
          : Promise.resolve(""),
        hasWorktree
          ? invoke<string>("get_git_diff", { workDir, path: entry.path, staged: false })
          : Promise.resolve(""),
      ]);
      const sections = [
        stagedResult ? `${lang === "zh" ? "--- 已暂存 ---" : "--- Staged ---"}\n${stagedResult}` : "",
        worktreeResult ? `${lang === "zh" ? "--- 工作区 ---" : "--- Worktree ---"}\n${worktreeResult}` : "",
      ].filter(Boolean);
      const diff = sections.join("\n\n") || (lang === "zh" ? "没有可显示的文本差异。" : "No textual diff to display.");
      setWorkspaceBySession((previous) => {
        if (previous[sessionId]?.workDir !== workDir
          || previous[sessionId]?.selectedPath !== entry.path) return previous;
        return {
          ...previous,
          [sessionId]: { ...previous[sessionId], diff },
        };
      });
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const restoreGitEntry = async (entry: GitStatusEntry) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    const repositoryRoot = currentWorkspace.repositoryRoot || workDir;
    if (sessionMutationLocked) {
      notify(lang === "zh" ? "任务运行中不能恢复文件。" : "Files cannot be restored while the task is running.", "error");
      return;
    }
    if (!window.confirm(lang === "zh" ? `恢复 ${entry.path}？未提交改动会丢失。` : `Restore ${entry.path}? Uncommitted changes will be lost.`)) return;
    try {
      if (entry.indexStatus.trim() && entry.indexStatus !== "?") {
        await invoke("restore_git_path", { workDir, path: entry.path, staged: true });
      }
      await invoke("restore_git_path", { workDir, path: entry.path, staged: false });
      if (entry.originalPath && entry.originalPath !== entry.path) {
        await invoke("restore_git_path", { workDir, path: entry.originalPath, staged: false });
      }
      if (currentSessionIdRef.current === sessionId && effectiveWorkDirRef.current === workDir) {
        fileRequestSequenceRef.current[sessionId] = (fileRequestSequenceRef.current[sessionId] || 0) + 1;
        setFileContent(null);
        setSelectedFile(null);
        setDiffView(false);
      }
      const restoredKeys = new Set([
        resolveWorkspacePath(repositoryRoot, entry.path),
        ...(entry.originalPath ? [resolveWorkspacePath(repositoryRoot, entry.originalPath)] : []),
      ]);
      setModifiedFilesBySession((previous) => {
        const nextFiles = { ...(previous[sessionId] || {}) };
        for (const key of restoredKeys) delete nextFiles[key];
        return { ...previous, [sessionId]: nextFiles };
      });
      if (/\.(html?|svg)$/i.test(entry.path)) {
        setPreviewBySession((previous) => ({ ...previous, [sessionId]: "" }));
      }
      if (currentSessionIdRef.current === sessionId && effectiveWorkDirRef.current === workDir) {
        await refreshWorkspace(sessionId, workDir);
      }
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const restoreRunCheckpoint = async () => {
    const sessionId = currentSessionId;
    const checkpoint = checkpointBySession[sessionId];
    if (!checkpoint) return;
    if (sessionMutationLocked) {
      notify(lang === "zh" ? "请先停止当前任务，再恢复本轮。" : "Stop the current task before restoring the run.", "error");
      return;
    }
    if (!window.confirm(lang === "zh"
      ? `恢复 ${checkpoint.workDir} 到本轮工具执行前？当前未提交改动会丢失。`
      : `Restore ${checkpoint.workDir} to before this run?`)) return;
    try {
      await invoke("restore_git_checkpoint", { workDir: checkpoint.workDir, commit: checkpoint.commit });
      if (currentSessionIdRef.current === sessionId && effectiveWorkDirRef.current === checkpoint.workDir) {
        fileRequestSequenceRef.current[sessionId] = (fileRequestSequenceRef.current[sessionId] || 0) + 1;
        setFileContent(null);
        setSelectedFile(null);
        setDiffView(false);
      }
      setModifiedFilesBySession((previous) => ({ ...previous, [sessionId]: {} }));
      setPreviewBySession((previous) => ({ ...previous, [sessionId]: "" }));
      if (effectiveWorkDirRef.current === checkpoint.workDir) {
        await refreshWorkspace(sessionId, checkpoint.workDir);
      }
      await invoke("delete_git_checkpoint", { workDir: checkpoint.workDir, reference: checkpoint.reference });
      setCheckpointBySession((previous) => ({ ...previous, [sessionId]: null }));
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const acceptRunCheckpoint = async () => {
    const sessionId = currentSessionId;
    const checkpoint = checkpointBySession[sessionId];
    if (!checkpoint) return;
    if (sessionMutationLocked) {
      notify(lang === "zh" ? "任务完成后才能保留本轮改动。" : "Run changes can be kept after the task finishes.", "error");
      return;
    }
    try {
      await invoke("delete_git_checkpoint", { workDir: checkpoint.workDir, reference: checkpoint.reference });
      setCheckpointBySession((previous) => ({ ...previous, [sessionId]: null }));
      notify(lang === "zh" ? "已保留本轮改动。" : "Run changes kept.", "success");
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const updateOnboardingValues = (patch: Partial<OnboardingValues>) => {
    const next = { ...onboardingValuesRef.current, ...patch };
    onboardingValuesRef.current = next;
    setOnboardingValues(next);
    onboardingTestSequenceRef.current += 1;
    const connectionChanged = ["profileId", "provider", "wireFormat", "baseUrl", "apiKey", "model"]
      .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
    if (connectionChanged || onboardingConnection.state === "testing") {
      setOnboardingConnection({ state: "idle" });
    }
  };

  const pickOnboardingWorkspace = async () => {
    try {
      const selected = await invoke<string | null>("pick_workspace_directory");
      if (selected) updateOnboardingValues({ workDir: selected });
    } catch (error) {
      notify(`${lang === "zh" ? "无法打开目录选择器" : "Could not open the folder picker"}: ${error}`, "error");
    }
  };

  const testOnboardingConnection = async () => {
    const sequence = onboardingTestSequenceRef.current + 1;
    onboardingTestSequenceRef.current = sequence;
    const snapshot = onboardingValuesRef.current;
    setOnboardingConnection({ state: "testing" });
    try {
      const list = snapshot.wireFormat === "ollama"
        ? await invoke<ModelInfo[]>("fetch_ollama_models", { baseUrl: snapshot.baseUrl })
        : await invoke<ModelInfo[]>("fetch_models", {
            wireFormat: snapshot.wireFormat,
            baseUrl: snapshot.baseUrl,
            apiKey: snapshot.apiKey,
          });
      if (onboardingTestSequenceRef.current !== sequence || onboardingValuesRef.current !== snapshot) return;
      setModels(list);
      const selectedModelExists = list.length === 0
        || list.some((model) => model.id === snapshot.model);
      if (!selectedModelExists) {
        setOnboardingConnection({
          state: "error",
          message: lang === "zh"
            ? `端点可访问，但模型列表中没有 ${snapshot.model}。`
            : `The endpoint is reachable, but ${snapshot.model} is not in its model list.`,
        });
        return;
      }
      setOnboardingConnection({
        state: "success",
        message: list.length > 0
          ? (lang === "zh" ? `端点可用，发现 ${list.length} 个模型。` : `Endpoint ready. Found ${list.length} models.`)
          : (lang === "zh" ? "端点可用，模型列表为空。" : "Endpoint ready. The model list is empty."),
      });
    } catch (error) {
      if (onboardingTestSequenceRef.current !== sequence || onboardingValuesRef.current !== snapshot) return;
      setOnboardingConnection({ state: "error", message: String(error) });
    }
  };

  const completeOnboarding = async () => {
    if (onboardingConnection.state !== "success") return;
    try {
      if (onboardingValues.mode === "code") {
        await invoke("validate_workspace", { path: onboardingValues.workDir, create: false });
      }

      const nextConfig: AppConfig = {
        ...config,
        provider: onboardingValues.provider,
        wire_format: onboardingValues.wireFormat,
        base_url: onboardingValues.baseUrl.trim(),
        api_key: onboardingValues.apiKey.trim(),
        model: onboardingValues.model.trim(),
        active_profile: onboardingValues.profileId,
        default_work_dir: onboardingValues.mode === "code"
          ? onboardingValues.workDir.trim()
          : config.default_work_dir,
      };
      await invoke("save_config", { config: nextConfig });
      lastSavedConfigRef.current = JSON.stringify(nextConfig);
      setConfig(nextConfig);
      setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
        ...session,
        sessionConfig: {
          ...session.sessionConfig,
          mode: onboardingValues.mode,
          profileId: onboardingValues.profileId,
          model: null,
          workDir: onboardingValues.mode === "code" ? onboardingValues.workDir.trim() : null,
        },
        updatedAt: Date.now(),
      } : session));
      setSidebarNav(onboardingValues.mode);
      try { localStorage.setItem("gx_onboarding_v1", "complete"); } catch { /* ignore */ }
      try { sessionStorage.removeItem("gx_onboarding_v1_dismissed"); } catch { /* ignore */ }
      setOnboardingOpen(false);
      notify(lang === "zh" ? "首次设置已保存。" : "Setup saved.", "success");
    } catch (error) {
      notify(`${lang === "zh" ? "无法保存首次设置" : "Could not save setup"}: ${error}`, "error");
    }
  };

  const dismissOnboarding = () => {
    try { sessionStorage.setItem("gx_onboarding_v1_dismissed", "true"); } catch { /* ignore */ }
    setOnboardingOpen(false);
  };

  const fetchModelList = async () => {
    if (!config.base_url) return;
    setModelsLoading(true);
    try {
      const wire = config.wire_format || "openai";
      // Ollama has a distinct models endpoint; route the shared "fetch models"
      // button to it so the button works regardless of the active wire format.
      const list = wire === "ollama"
        ? await invoke<ModelInfo[]>("fetch_ollama_models", { baseUrl: config.base_url })
        : await invoke<ModelInfo[]>("fetch_models", {
            wireFormat: wire,
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
      wire_format: preset.wire_format || "openai",
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
        currentConfig: config,
        profile: { name, base_url: config.base_url, api_key: config.api_key, default_model: config.model, wire_format: config.wire_format || "openai", provider: config.provider || "openai" },
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
      const updated = await invoke<AppConfig>("set_active_profile", { currentConfig: config, name });
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
      const updated = await invoke<AppConfig>("delete_profile", { currentConfig: config, name });
      setConfig(updated);
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const handleClearActiveProfile = async () => {
    try {
      const updated = await invoke<AppConfig>("clear_active_profile", { currentConfig: config });
      setConfig(updated);
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const testMcpServer = async (name: string) => {
    const server = config.mcp_servers[name];
    if (!server) return;
    setMcpStatusByName((previous) => ({ ...previous, [name]: { state: "starting" } }));
    try {
      const result = await invoke<{
        status: "ready" | "error";
        toolCount: number;
        error?: string | null;
      }>("test_mcp_server", {
        name,
        command: server.command,
        args: server.args || [],
        env: server.env || {},
      });
      setMcpStatusByName((previous) => ({
        ...previous,
        [name]: {
          state: result.status === "ready" ? "ready" : "error",
          toolCount: result.toolCount,
          message: result.error || undefined,
        },
      }));
    } catch (error) {
      setMcpStatusByName((previous) => ({ ...previous, [name]: { state: "error", message: String(error) } }));
    }
  };

  const deleteMcpServer = async (name: string) => {
    try {
      const updated = await invoke<AppConfig>("delete_mcp_server", { currentConfig: config, name });
      setConfig(updated);
      setMcpStatusByName((previous) => {
        const next = { ...previous };
        delete next[name];
        return next;
      });
    } catch (error) {
      addLog(String(error), "error", true);
    }
  };

  const handleCompact = async () => {
    if (!sessionStorageReady || isStreamingRef.current || requestStartingRef.current) return;
    const sessionId = currentSession.id;
    const messages = currentSession.messages;
    if (messages.length < 3) {
      addLog(t("compact.tooShort", lang), "info");
      return;
    }
    if (requestNeedsApiKey(resolvedCurrentConfig)) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error", true, sessionId);
      return;
    }
    const requestId = `compact-${createRequestId()}`;
    activeRequestIdRef.current = requestId;
    activeRequestSessionIdRef.current = sessionId;
    requestSessionByIdRef.current[requestId] = sessionId;
    isStreamingRef.current = true;
    setActiveRunSessionId(sessionId);
    setRuntimeBySession((previous) => ({ ...previous, [sessionId]: { requestId, status: "running" } }));
    addLog(t("compact.start", lang), "info", false, sessionId);
    try {
      const result = await invoke<string>("compact_history", {
        currentConfig: resolvedCurrentConfig,
        requestId,
        contextTokenLimit: modelContextLimit(resolvedCurrentConfig.model),
        messages: messages.flatMap((message) => {
          const serialized = serializeMessageForApi(message);
          return serialized ? [{ role: serialized.role, content: serialized.content }] : [];
        }),
      });
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            compactBackup: messages,
            messages: [
              { role: "assistant" as const, content: result, actions: [], timestamp: Date.now() },
            ],
            updatedAt: Date.now(),
          };
        })
      );
      addLog(t("compact.done", lang), "success", false, sessionId);
    } catch (e) {
      const message = String(e);
      if (message.toLowerCase().includes("cancelled")) {
        addLog(lang === "zh" ? "已取消压缩上下文。" : "History compaction cancelled.", "info", false, sessionId);
      } else {
        addLog(t("compact.failed", lang) + message, "error", true, sessionId);
      }
    } finally {
      finishStreamingLocally(requestId);
    }
  };

  const undoCompact = () => {
    if (sessionMutationLocked || !currentSession.compactBackup) return;
    setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
      ...session,
      messages: session.compactBackup || session.messages,
      compactBackup: undefined,
      updatedAt: Date.now(),
    } : session));
    notify(lang === "zh" ? "已恢复压缩前的对话。" : "Conversation restored.", "success");
  };

  const saveConfig = async () => {
    setConfigSaveStatus("saving");
    try {
      await invoke("save_config", { config });
      lastSavedConfigRef.current = JSON.stringify(config);
      setConfigSaveStatus("saved");
      addLog(t("log.configSaved", lang), "success", true);
    } catch (e) {
      setConfigSaveStatus("error");
      addLog(t("log.configFailed", lang) + e, "error", true);
    }
  };

  // ==========================================
  // Tauri Event Listeners — registered once on mount, use ref for current session
  // ==========================================

  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    let disposed = false;

    // Apply all buffered stream text in a single state update. Safe to call
    // synchronously (e.g. right before a tool/done event mutates the last
    // message) — it cancels any pending frame and applies immediately.
    const flushStreamBuffer = () => {
      if (streamFlushRafRef.current !== null) {
        cancelAnimationFrame(streamFlushRafRef.current);
        streamFlushRafRef.current = null;
      }
      const buffered = streamBufferRef.current;
      if (!buffered?.text) return;
      streamBufferRef.current = null;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== buffered.sessionId) return s;
          const messages = [...s.messages];
          if (
            messages.length === 0 ||
            messages[messages.length - 1].role !== "assistant"
          ) {
            messages.push({
              role: "assistant",
              content: buffered.text,
              actions: [],
              variants: [buffered.text],
              currentVariantIndex: 0,
              timestamp: Date.now(),
              model: buffered.model,
              contextTokens: buffered.contextTokens,
            });
          } else {
            const last = { ...messages[messages.length - 1] };
            last.content += buffered.text;
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
    };
    flushStreamBufferNowRef.current = flushStreamBuffer;

    async function setup() {
      unlisteners.push(
        await listen<AgentEventPayload>("agent-stream-chunk", (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          let payload = payloadContent(event.payload);
          if (!payload) return;
          if (payload.includes("DSML")) {
            payload = payload.replace(/<[｜|][｜|][^>]*>/g, "");
            payload = payload.replace(/<\/[｜|][｜|][^>]*>/g, "");
            if (!payload.trim()) return;
          }
          // Accumulate and flush once per frame instead of one render per token.
          const requestId = payloadRequestId(event.payload) || activeRequestIdRef.current;
          const sessionId = agentEventSessionId(event.payload);
          if (streamBufferRef.current
            && (streamBufferRef.current.requestId !== requestId || streamBufferRef.current.sessionId !== sessionId)) {
            flushStreamBuffer();
          }
          if (!streamBufferRef.current) {
            streamBufferRef.current = {
              requestId,
              sessionId,
              text: "",
              model: activeRequestModelRef.current,
              contextTokens: activeRequestContextTokensRef.current,
            };
          }
          streamBufferRef.current.text += payload;
          if (streamFlushRafRef.current === null) {
            streamFlushRafRef.current = requestAnimationFrame(flushStreamBuffer);
          }
        })
      );

      unlisteners.push(
        await listen<SearchStatus>("agent-search-status", (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const status = event.payload;
          const sessionId = agentEventSessionId(event.payload);
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const messages = [...s.messages];
              if (messages.length === 0) return s;
              const last = { ...messages[messages.length - 1] };
              // If last message is not assistant (e.g. user msg during force search),
              // only create assistant message when we have results, not for "searching" status
              if (last.role !== "assistant") {
                if (status.type === "searching") {
                  // Don't create empty assistant message yet, wait for results or stream start
                  return s;
                }
                // Create assistant message now that we have results or error
                const assistantMsg: Message = {
                  role: "assistant",
                  content: "",
                  searchStatus: [status],
                  actions: [],
                };
                messages.push(assistantMsg);
                return { ...s, messages };
              }
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
        await listen<AgentEventPayload>("agent-reasoning-chunk", (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const payload = payloadContent(event.payload);
          if (!payload) return;
          const sessionId = agentEventSessionId(event.payload);
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const messages = [...s.messages];
              if (
                messages.length === 0 ||
                messages[messages.length - 1].role !== "assistant"
              ) {
                messages.push({
                  role: "assistant",
                  content: "",
                  actions: [],
                  reasoningContent: payload,
                  timestamp: Date.now(),
                  model: activeRequestModelRef.current,
                  contextTokens: activeRequestContextTokensRef.current,
                });
              } else {
                const last = { ...messages[messages.length - 1] };
                last.reasoningContent = (last.reasoningContent || "") + payload;
                messages[messages.length - 1] = last;
              }
              return { ...s, messages };
            })
          );
        })
      );

      unlisteners.push(
        await listen<{
          requestId?: string;
          status: string;
          serverStatuses: Array<{
            name: string;
            status: "started" | "error";
            toolCount: number;
            error?: string | null;
          }>;
        }>("agent-mcp-status", (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const requestId = event.payload.requestId || activeRequestIdRef.current;
          const sessionId = agentEventSessionId(event.payload);
          const startedNames = event.payload.serverStatuses
            .filter((server) => server.status === "started")
            .map((server) => server.name);
          if (requestId) mcpRuntimeNamesByRequestRef.current[requestId] = startedNames;
          setMcpStatusByName((previous) => {
            const next = { ...previous };
            for (const server of event.payload.serverStatuses) {
              next[server.name] = server.status === "started"
                ? {
                    state: "ready",
                    toolCount: server.toolCount,
                    message: langRef.current === "zh" ? "本轮已启动" : "Active in this run",
                  }
                : {
                    state: "error",
                    toolCount: 0,
                    message: server.error || (langRef.current === "zh" ? "启动失败" : "Failed to start"),
                  };
            }
            return next;
          });
          for (const server of event.payload.serverStatuses.filter((item) => item.status === "error")) {
            addLog(`MCP ${server.name}: ${server.error || "Failed to start"}`, "error", true, sessionId);
          }
        }),
      );

      unlisteners.push(
        await listen<{ index: number; id: string; name: string; arguments: string }>(
          "agent-tool-drafting",
          (event) => {
            if (!isCurrentRequestPayload(event.payload)) return;
            const { index, id: toolId, name, arguments: args } = event.payload;
            const sessionId = agentEventSessionId(event.payload);
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const messages = [...s.messages];
                if (messages.length === 0 || messages[messages.length - 1].role !== "assistant") {
                  messages.push({
                    role: "assistant",
                    content: "",
                    actions: [],
                    timestamp: Date.now(),
                    model: activeRequestModelRef.current,
                    contextTokens: activeRequestContextTokensRef.current,
                  });
                }
                const last = { ...messages[messages.length - 1] };
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
        await listen<{
          id: string;
          name: string;
          arguments: string;
          path?: string;
          beforeExists?: boolean;
          beforeContent?: string | null;
        }>(
          "agent-tool-executing",
          (event) => {
            if (!isCurrentRequestPayload(event.payload)) return;
            const { id, name, arguments: args } = event.payload;
            const sessionId = agentEventSessionId(event.payload);
            addLog(`[Exec] ${name}: ${args.substring(0, 200)}`, "cmd", false, sessionId);
            if (name === "write_file" || name === "edit_file") {
              try {
                const parsed = JSON.parse(args);
                const filePath = event.payload.path || parsed.path || "";
                if (filePath) {
                  const oldContent = event.payload.beforeExists ? (event.payload.beforeContent || "") : "";
                  const optimisticNewContent = name === "write_file" ? (parsed.content || "") : oldContent;
                  setModifiedFilesBySession((previous) => {
                    const existing = previous[sessionId]?.[filePath];
                    return {
                      ...previous,
                      [sessionId]: {
                        ...(previous[sessionId] || {}),
                        [filePath]: { old: existing?.old ?? oldContent, new: optimisticNewContent },
                      },
                    };
                  });
                }
              } catch {}
            }
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const messages = upsertToolActions(s.messages, [{
                  id,
                  name,
                  arguments: args,
                  status: "executing" as const,
                }]);
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
        await listen<{
          requestId?: string;
          id: string;
          name: string;
          stream: string;
          content: string;
        }>("agent-tool-output-chunk", (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const sessionId = agentEventSessionId(event.payload);
          const requestId = event.payload.requestId || activeRequestIdRef.current;
          streamedToolOutputKeysRef.current.add(`${requestId}:${event.payload.id}`);
          if (event.payload.content) {
            addLog(event.payload.content, event.payload.stream === "stderr" ? "error" : "cmd", false, sessionId);
          }
        }),
      );

      unlisteners.push(
        await listen<{
          requestId?: string;
          status: string;
          reference?: string;
          commit?: string;
          createdAt?: number;
          label?: string;
          error?: string;
        }>("agent-checkpoint", (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const sessionId = agentEventSessionId(event.payload);
          if (event.payload.status === "created" && event.payload.reference && event.payload.commit) {
            setCheckpointBySession((previous) => previous[sessionId] ? previous : {
              ...previous,
              [sessionId]: {
                reference: event.payload.reference!,
                commit: event.payload.commit!,
                createdAt: event.payload.createdAt || Date.now(),
                label: event.payload.label || "before tool execution",
                workDir: activeRequestWorkDirRef.current,
              },
            });
          } else if (event.payload.error) {
            addLog(event.payload.error, "info", false, sessionId);
          }
        }),
      );

      unlisteners.push(
        await listen<{
          requestId?: string;
          id: string;
          name: string;
          output: string;
          path?: string;
          afterExists?: boolean;
          afterContent?: string | null;
        }>(
          "agent-tool-output",
          (event) => {
            if (!isCurrentRequestPayload(event.payload)) return;
            const { id, name, output } = event.payload;
            const sessionId = agentEventSessionId(event.payload);
            const requestId = event.payload.requestId || activeRequestIdRef.current;
            const outputKey = `${requestId}:${id}`;
            const isErrorOutput = output.trimStart().startsWith("Error:");
            if (!streamedToolOutputKeysRef.current.has(outputKey)) {
              addLog(
                `[${isErrorOutput ? "Error" : "Done"}] ${name}: ${output.substring(0, 200)}${output.length > 200 ? "..." : ""}`,
                isErrorOutput ? "error" : "success",
                false,
                sessionId,
              );
            }
            if (!isErrorOutput && ["write_file", "edit_file", "execute_command", "run_python"].includes(name)) {
              const requestWorkDir = activeRequestWorkDirRef.current;
              void refreshWorkspace(sessionId, requestWorkDir);
              const visibleSessionId = currentSessionIdRef.current;
              if (visibleSessionId !== sessionId && effectiveWorkDirRef.current === requestWorkDir) {
                void refreshWorkspace(visibleSessionId, requestWorkDir);
              }
            }
            if (name === "write_file" || name === "edit_file") {
              const filePath = event.payload.path || "";
              const content = event.payload.afterContent;
              if (filePath) {
                setModifiedFilesBySession((previous) => {
                  const files = { ...(previous[sessionId] || {}) };
                  const old = files[filePath]?.old || "";
                  if (event.payload.afterExists && typeof content === "string" && content !== old) {
                    files[filePath] = { old, new: content };
                  } else {
                    delete files[filePath];
                  }
                  return { ...previous, [sessionId]: files };
                });
              }
              if (filePath && event.payload.afterExists && typeof content === "string") {
                if (!isErrorOutput && /\.(html?|svg)$/i.test(filePath)) {
                  setPreviewBySession((previous) => ({ ...previous, [sessionId]: content }));
                  if (currentSessionIdRef.current === sessionId) setActiveTab("preview");
                }
                const absoluteFilePath = resolveWorkspacePath(activeRequestWorkDirRef.current, filePath);
                if (effectiveWorkDirRef.current === activeRequestWorkDirRef.current
                  && selectedFileRef.current
                  && comparableWorkspacePath(selectedFileRef.current) === comparableWorkspacePath(absoluteFilePath)) {
                  const visibleSessionId = currentSessionIdRef.current;
                  fileRequestSequenceRef.current[visibleSessionId] = (fileRequestSequenceRef.current[visibleSessionId] || 0) + 1;
                  setFileContent(content);
                }
              }
            }
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const messages = upsertToolActions(s.messages, [{
                  id,
                  name,
                  arguments: "",
                  status: isErrorOutput ? "error" as const : "done" as const,
                  output,
                }]);
                if (messages.length === 0) return s;
                const last = { ...messages[messages.length - 1] };
                if (last.role !== "assistant" || !last.actions) return s;
                last.actions = last.actions.map((a) =>
                  a.id === id ? { ...a, status: isErrorOutput ? "error" as const : "done" as const, output } : a
                );
                messages[messages.length - 1] = last;
                return { ...s, messages };
              })
            );
          }
        )
      );

      unlisteners.push(
        await listen<{ requestId?: string; id: string; name: string; reason: string }>(
          "agent-tool-blocked",
          (event) => {
            if (!isCurrentRequestPayload(event.payload)) return;
            const { id, name, reason } = event.payload;
            const sessionId = agentEventSessionId(event.payload);
            addLog(`[Blocked] ${name}: ${reason}`, "error", false, sessionId);
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                const messages = upsertToolActions(s.messages, [{
                  id,
                  name,
                  arguments: "",
                  status: "blocked" as const,
                  output: reason,
                }]);
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
          if (!isCurrentRequestPayload(event.payload)) return;
          const sessionId = agentEventSessionId(event.payload);
          setPendingApprovalsBySession((previous) => ({ ...previous, [sessionId]: event.payload }));
          const pendingActions: ToolAction[] = event.payload.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            status: "pending_approval" as const,
          }));
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              return { ...s, messages: upsertToolActions(s.messages, pendingActions) };
            })
          );
        })
      );

      unlisteners.push(
        await listen<{
          requestId?: string;
          content?: string;
          loopCount?: number;
          ttftMs?: number;
          responseTimeMs?: number;
        }>("agent-stream-done", (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          flushStreamBuffer();
          const done = event.payload || {};
          const sessionId = agentEventSessionId(event.payload);
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const messages = [...s.messages];
              if (messages.length === 0) return s;
              const last = { ...messages[messages.length - 1] };
              if (last.role !== "assistant") return s;
              const usage = last.usage || {
                promptTokens: last.contextTokens || activeRequestContextTokensRef.current || 0,
                completionTokens: estimateTextTokens(last.content),
                totalPromptTokens: last.contextTokens || activeRequestContextTokensRef.current || 0,
                totalCompletionTokens: estimateTextTokens(last.content),
                ttftMs: done.ttftMs || 0,
                responseTimeMs: done.responseTimeMs || 0,
                loopCount: done.loopCount || 1,
              };
              last.model = last.model || activeRequestModelRef.current;
              last.contextTokens = last.contextTokens || activeRequestContextTokensRef.current;
              last.usage = {
                ...usage,
                completionTokens: usage.completionTokens || estimateTextTokens(last.content),
                ttftMs: done.ttftMs ?? usage.ttftMs,
                responseTimeMs: done.responseTimeMs ?? usage.responseTimeMs,
                loopCount: done.loopCount ?? usage.loopCount,
              };
              messages[messages.length - 1] = last;
              return { ...s, messages };
            })
          );
        })
      );

      unlisteners.push(
        await listen<AgentEventPayload<{ status?: string }>>("agent-complete", (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          flushStreamBuffer();
          const status = typeof event.payload === "string" ? "" : event.payload.status;
          const sessionId = agentEventSessionId(event.payload);
          const requestId = payloadRequestId(event.payload) || activeRequestIdRef.current;
          const mcpRuntimeNames = mcpRuntimeNamesByRequestRef.current[requestId] || [];
          if (mcpRuntimeNames.length > 0) {
            setMcpStatusByName((previous) => {
              const next = { ...previous };
              for (const name of mcpRuntimeNames) {
                if (next[name]?.message === "Active in this run" || next[name]?.message === "本轮已启动") {
                  next[name] = { state: "stopped" };
                }
              }
              return next;
            });
          }
          delete mcpRuntimeNamesByRequestRef.current[requestId];
          const completedWorkDir = activeRequestWorkDirRef.current;
          void refreshWorkspace(sessionId, completedWorkDir);
          const visibleSessionId = currentSessionIdRef.current;
          if (visibleSessionId !== sessionId && effectiveWorkDirRef.current === completedWorkDir) {
            void refreshWorkspace(visibleSessionId, completedWorkDir);
          }
          finishStreamingLocally(requestId);
          const eventLang = langRef.current;
          addLog(status === "cancelled" ? (eventLang === "zh" ? "已停止当前输出。" : "Current output stopped.") : t("log.complete", eventLang), "info", false, sessionId);
        })
      );

      unlisteners.push(
        await listen<{
          requestId?: string;
          prompt_tokens: number;
          completion_tokens: number;
          total_prompt_tokens: number;
          total_completion_tokens: number;
          ttft_ms: number;
          response_time_ms: number;
          loop_count: number;
        }>("agent-usage", (event) => {
          if (!isCurrentRequestPayload(event.payload)) return;
          const sessionId = agentEventSessionId(event.payload);
          const usage = {
            promptTokens: event.payload.prompt_tokens,
            completionTokens: event.payload.completion_tokens,
            totalPromptTokens: event.payload.total_prompt_tokens,
            totalCompletionTokens: event.payload.total_completion_tokens,
            ttftMs: event.payload.ttft_ms,
            responseTimeMs: event.payload.response_time_ms,
            loopCount: event.payload.loop_count,
          };
          setUsageStatsBySession((previous) => ({ ...previous, [sessionId]: usage }));
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const messages = [...s.messages];
              if (messages.length === 0) return s;
              const last = { ...messages[messages.length - 1] };
              if (last.role !== "assistant") return s;
              last.model = last.model || activeRequestModelRef.current;
              last.contextTokens = usage.promptTokens || last.contextTokens || activeRequestContextTokensRef.current;
              last.usage = usage;
              messages[messages.length - 1] = last;
              return { ...s, messages };
            })
          );
        })
      );
    }

    setup().then(() => {
      if (disposed) {
        unlisteners.splice(0).forEach((fn) => fn());
      }
    }).catch((e) => {
      addLog(`Listener setup failed: ${e}`, "error");
    });

    return () => {
      disposed = true;
      if (streamFlushRafRef.current !== null) {
        cancelAnimationFrame(streamFlushRafRef.current);
        streamFlushRafRef.current = null;
      }
      streamBufferRef.current = null;
      flushStreamBufferNowRef.current = () => {};
      unlisteners.splice(0).forEach((fn) => fn());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ==========================================
  // Actions
  // ==========================================

  const serializeSessionHistory = (messages: Message[]) => {
    let lastDividerIdx = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "context_divider") {
        lastDividerIdx = index;
        break;
      }
    }
    const activeMessages = lastDividerIdx >= 0 ? messages.slice(lastDividerIdx + 1) : messages;
    return activeMessages.flatMap((message) => {
      const serialized = serializeMessageForApi(message);
      return serialized ? [serialized] : [];
    });
  };

  const resolveSessionRequest = (sessionConfig: SessionConfig) => {
    const sessionSearchMode = config.tools_enabled.includes("web_search")
      ? sessionConfig.searchMode
      : "off";
    return {
      requestConfig: resolveRequestConfig(config, sessionConfig, sessionSearchMode),
      searchMode: sessionSearchMode,
    };
  };

  const requestNeedsApiKey = (requestConfig: AppConfig) => (
    !requestConfig.api_key.trim()
    && requestConfig.provider !== "ollama"
    && (requestConfig.base_url.includes("deepseek") || requestConfig.base_url.includes("openai.com"))
  );

  const startAgentRequest = async ({
    targetSessionId,
    sessionConfig,
    history,
    userMessage,
    requestAttachments,
    label = "send",
    onAccepted,
  }: {
    targetSessionId: string;
    sessionConfig: SessionConfig;
    history: Message[];
    userMessage: string;
    requestAttachments: Attachment[];
    label?: string;
    onAccepted?: () => void;
  }): Promise<boolean> => {
    if (!sessionStorageReady || isStreamingRef.current || requestStartingRef.current) return false;
    const { requestConfig, searchMode: requestSearchMode } = resolveSessionRequest(sessionConfig);
    if (requestNeedsApiKey(requestConfig)) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error", true, targetSessionId);
      return false;
    }

    const requestId = createRequestId();
    const sessionMessages = serializeSessionHistory(history);
    const finalMessage = buildPromptWithAttachments(userMessage, requestAttachments);
    const imageAttachments = imageAttachmentsForApi(requestAttachments);
    const instructionTokens = estimateTextTokens(requestConfig.system_prompt)
      + (requestConfig.role_prompt ? estimateTextTokens(requestConfig.role_prompt) + 24 : 0);
    const estimatedRequestTokens = sessionMessages.reduce((sum, message) => (
      sum
      + estimateTextTokens(String(message.content || ""))
      + ((message as { attachments?: Attachment[] }).attachments || []).length * 1100
      + 6
    ), instructionTokens) + estimateTextTokens(finalMessage) + imageAttachments.length * 1100;
    const requestContextLimit = modelContextLimit(requestConfig.model);
    if (estimatedRequestTokens > requestContextLimit * 0.9) {
      addLog(
        lang === "zh"
          ? `预计上下文 ${formatTokenCount(estimatedRequestTokens)} tokens，接近或超过模型上限 ${formatTokenCount(requestContextLimit)}。请先压缩上下文或移除附件。`
          : `Estimated context is ${formatTokenCount(estimatedRequestTokens)} tokens, near or above the ${formatTokenCount(requestContextLimit)} model limit. Compact the context or remove attachments first.`,
        "error",
        true,
        targetSessionId,
      );
      return false;
    }

    requestStartingRef.current = true;
    setPreparingRequestSessionId(targetSessionId);
    const finishPreparingRequest = () => {
      requestStartingRef.current = false;
      setPreparingRequestSessionId((current) => current === targetSessionId ? null : current);
    };

    // Only consume the previous restore point after every pure validation has
    // passed. A rejected oversized request must not destroy the user's ability
    // to restore the last successful run.
    const previousCheckpoint = checkpointBySession[targetSessionId];
    if (previousCheckpoint) {
      try {
        await invoke("delete_git_checkpoint", {
          workDir: previousCheckpoint.workDir,
          reference: previousCheckpoint.reference,
        });
        setCheckpointBySession((previous) => ({ ...previous, [targetSessionId]: null }));
      } catch (error) {
        finishPreparingRequest();
        addLog(`${lang === "zh" ? "无法接受上一轮改动" : "Could not accept the previous run"}: ${error}`, "error", true, targetSessionId);
        return false;
      }
    }

    try {
      onAccepted?.();
    } catch (error) {
      finishPreparingRequest();
      addLog(`${lang === "zh" ? "无法启动请求" : "Could not start request"}: ${error}`, "error", true, targetSessionId);
      return false;
    }

    activeRequestIdRef.current = requestId;
    activeRequestSessionIdRef.current = targetSessionId;
    activeRequestModelRef.current = requestConfig.model;
    activeRequestWorkDirRef.current = requestConfig.default_work_dir;
    activeRequestContextTokensRef.current = estimatedRequestTokens;
    requestSessionByIdRef.current[requestId] = targetSessionId;
    isStreamingRef.current = true;
    setActiveRunSessionId(targetSessionId);
    setRuntimeBySession((previous) => ({
      ...previous,
      [targetSessionId]: { requestId, status: "running" },
    }));
    setPendingApprovalsBySession((previous) => ({ ...previous, [targetSessionId]: null }));
    setUsageStatsBySession((previous) => ({ ...previous, [targetSessionId]: null }));
    setCheckpointBySession((previous) => ({ ...previous, [targetSessionId]: null }));
    setModifiedFilesBySession((previous) => ({ ...previous, [targetSessionId]: {} }));
    finishPreparingRequest();

    addLog(
      `[Request:${label} ${requestId}] mode=${sessionConfig.mode} model=${requestConfig.model} history=${sessionMessages.length}`,
      "info",
      false,
      targetSessionId,
    );

    try {
      await invoke("start_agent_session", {
        requestId,
        prompt: finalMessage,
        config: requestConfig,
        sessionMessages,
        sessionMode: sessionConfig.mode,
        searchMode: requestSearchMode,
        imageAttachments,
      });
      if (activeRequestIdRef.current === requestId) finishStreamingLocally(requestId);
      return true;
    } catch (error) {
      if (activeRequestIdRef.current === requestId) finishStreamingLocally(requestId);
      addLog(`Agent error: ${error}`, "error", true, targetSessionId);
      setSessions((previous) => previous.map((session) => session.id === targetSessionId ? {
        ...session,
        messages: [
          ...session.messages,
          { role: "assistant", content: `Error: ${error}`, actions: [], timestamp: Date.now() },
        ],
        updatedAt: Date.now(),
      } : session));
      return false;
    }
  };

  const createBranchSession = (source: ChatSession, messages: Message[]) => {
    const branch = createSession(
      source.sessionConfig.mode,
      `${source.title || t("session.new", lang)} ${lang === "zh" ? "(分支)" : "(branch)"}`,
      messages,
    );
    branch.sessionConfig = { ...source.sessionConfig };
    return branch;
  };

  const handleSendMessage = async () => {
    if (!sessionStorageReady) return;
    const sendableAttachments = fitAttachmentBudget([], attachments).accepted;
    if ((!prompt.trim() && sendableAttachments.length === 0) || isStreamingRef.current || requestStartingRef.current || isAttachmentLoading) return;

    // Quick commands using helper
    const { isCommand, command } = parseCommand(prompt.trim());
    if (isCommand && sendableAttachments.length === 0) {
      setPrompt("");

      if (command === "clear") {
        setSessions(prev => prev.map(s => s.id === currentSessionId ? {
          ...s,
          messages: [...s.messages, { role: "context_divider" as const, content: "" }]
        } : s));
        return;
      }

      if (command === "compact") {
        await handleCompact();
        return;
      }

      if (command === "export") {
        const session = sessions.find(s => s.id === currentSessionId);
        if (session) {
          const md = sessionToMarkdown(session.title, session.messages);
          const blob = new Blob([md], { type: 'text/markdown' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${session.title}.md`;
          a.click();
          URL.revokeObjectURL(url);
          notify("已导出为 Markdown", "success");
        }
        return;
      }

      if (command === "help") {
        notify("快捷命令：/clear /compact /export /help", "info");
        return;
      }
    }

    // Slash command: /compact — compress conversation history
    if (sendableAttachments.length === 0 && prompt.trim().toLowerCase() === "/compact") {
      setPrompt("");
      await handleCompact();
      return;
    }

    // Slash command: /clear — insert context divider
    if (sendableAttachments.length === 0 && prompt.trim().toLowerCase() === "/clear") {
      setPrompt("");
      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
        ...s,
        messages: [...s.messages, { role: "context_divider" as const, content: "" }]
      } : s));
      return;
    }

    const { requestConfig } = resolveSessionRequest(currentSession.sessionConfig);
    if (requestNeedsApiKey(requestConfig)) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error", true, currentSessionId);
      return;
    }

    const targetSessionId = currentSessionId;
    const targetSession = currentSession;
    const userMessage = prompt.trim();
    const pendingAttachments = [...sendableAttachments];
    await startAgentRequest({
      targetSessionId,
      sessionConfig: targetSession.sessionConfig,
      history: targetSession.messages,
      userMessage,
      requestAttachments: pendingAttachments,
      onAccepted: () => {
        setDraftsBySession((previous) => ({ ...previous, [targetSessionId]: "" }));
        setAttachmentsBySession((previous) => ({ ...previous, [targetSessionId]: [] }));
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== targetSessionId) return s;
            let title = s.title;
            if (s.messages.length === 0) {
              const titleSource = userMessage || pendingAttachments[0]?.name || "Attachment";
              title = titleSource.length > 25 ? titleSource.substring(0, 25) + "..." : titleSource;
            }
            return {
              ...s,
              title,
              messages: [
                ...s.messages,
                {
                  role: "user" as const,
                  content: userMessage,
                  attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
                  timestamp: Date.now(),
                },
              ],
              compactBackup: undefined,
              updatedAt: Date.now(),
            };
          })
        );
      },
    });
  };

  const handleStopStreaming = async () => {
    const requestId = activeRequestIdRef.current;
    const sessionId = activeRequestSessionIdRef.current;
    if (!requestId || !isStreamingRef.current || sessionId !== currentSessionId || currentRuntime?.status === "stopping") return;

    try {
      setRuntimeBySession((previous) => ({
        ...previous,
        [sessionId]: { requestId, status: "stopping" },
      }));
      await invoke("cancel_agent_session", { requestId });
      addLog(lang === "zh" ? "已请求停止当前输出。" : "Stop requested for current output.", "info", false, sessionId);
    } catch (e) {
      addLog(`Stop request failed: ${e}`, "error", true, sessionId);
      if (activeRequestIdRef.current === requestId) {
        setRuntimeBySession((previous) => ({
          ...previous,
          [sessionId]: { requestId, status: "running" },
        }));
      }
    }
  };

  const handleSteeringMessage = async () => {
    const message = prompt.trim();
    const sessionId = activeRequestSessionIdRef.current;
    const requestId = activeRequestIdRef.current;
    if (!message || !isStreaming || sessionId !== currentSessionId || !requestId || currentMode !== "code") return;
    try {
      await invoke("push_steering_message", { requestId, message });
      setSessions(prev => prev.map(s => s.id === sessionId ? {
        ...s,
        messages: [...s.messages, { role: "user" as const, content: `[Steering] ${message}`, timestamp: Date.now() }],
        updatedAt: Date.now(),
      } : s));
      setPrompt("");
      addLog(lang === "zh" ? "干预指令已发送" : "Steering message sent", "info", false, sessionId);
    } catch (e) {
      addLog(`Steering error: ${e}`, "error", true, sessionId);
    }
  };

  const handleRetry = async (msgIdx: number) => {
    if (!sessionStorageReady || isStreamingRef.current || requestStartingRef.current) return;
    const msgs = currentSession.messages;
    let userIndex = -1;
    for (let i = msgIdx; i >= 0; i--) {
      if (msgs[i].role === "user") {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;
    const userMessage = msgs[userIndex];
    const userAttachments = [...(userMessage.attachments || [])];
    const userText = userMessage.content;
    if (!userText && userAttachments.length === 0) return;

    const branchMessages = msgs.slice(0, userIndex + 1).map((message) => ({ ...message }));
    const branch = createBranchSession(currentSession, branchMessages);

    await startAgentRequest({
      targetSessionId: branch.id,
      sessionConfig: branch.sessionConfig,
      history: msgs.slice(0, userIndex),
      userMessage: userText,
      requestAttachments: userAttachments,
      label: "retry-branch",
      onAccepted: () => {
        setSessions((previous) => [...previous, branch]);
        setCurrentSessionId(branch.id);
        setSidebarNav(branch.sessionConfig.mode);
      },
    });
  };

  const handleEditBranch = async (msgIdx: number) => {
    if (!sessionStorageReady || isStreamingRef.current || requestStartingRef.current) return;
    const sourceMessage = currentSession.messages[msgIdx];
    if (!sourceMessage) return;
    const editedMessage: Message = {
      ...sourceMessage,
      content: editText,
      variants: undefined,
      currentVariantIndex: undefined,
      timestamp: Date.now(),
    };
    const branch = createBranchSession(
      currentSession,
      [...currentSession.messages.slice(0, msgIdx), editedMessage],
    );
    if (editedMessage.role !== "user") {
      setSessions((previous) => [...previous, branch]);
      setCurrentSessionId(branch.id);
      setSidebarNav(branch.sessionConfig.mode);
      setEditingMessageIdx(null);
      return;
    }
    const editedAttachments = [...(editedMessage.attachments || [])];
    if (!editedMessage.content.trim() && editedAttachments.length === 0) {
      setSessions((previous) => [...previous, branch]);
      setCurrentSessionId(branch.id);
      setSidebarNav(branch.sessionConfig.mode);
      setEditingMessageIdx(null);
      return;
    }
    await startAgentRequest({
      targetSessionId: branch.id,
      sessionConfig: branch.sessionConfig,
      history: currentSession.messages.slice(0, msgIdx),
      userMessage: editedMessage.content,
      requestAttachments: editedAttachments,
      label: "edit-branch",
      onAccepted: () => {
        setSessions((previous) => [...previous, branch]);
        setCurrentSessionId(branch.id);
        setSidebarNav(branch.sessionConfig.mode);
        setEditingMessageIdx(null);
      },
    });
  };

  const handleApproval = async (approved: boolean, trustPattern: boolean = false) => {
    if (!pendingApprovals || approvalSubmitting) return;
    const sessionId = currentSessionId;
    setApprovalSubmittingBySession((previous) => ({ ...previous, [sessionId]: true }));
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
      setPendingApprovalsBySession((previous) => ({ ...previous, [sessionId]: null }));

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
          } else if (tc.name === "write_file" || tc.name === "edit_file") {
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
            currentConfig: config,
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
    } finally {
      setApprovalSubmittingBySession((previous) => ({ ...previous, [sessionId]: false }));
    }
  };

  const renderApprovalCard = (className = "") => {
    if (!pendingApprovals) return null;
    return (
      <div className={`approval-card ${className}`.trim()}>
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
          <button className="btn btn-approve" disabled={approvalSubmitting} onClick={() => handleApproval(true)}>
            <CheckCircle2 size={13} /> {t("approval.approve", lang)}
          </button>
          <button className="btn btn-approve-trust" disabled={approvalSubmitting} onClick={() => handleApproval(true, true)} title={t("approval.trustHint", lang)}>
            <ShieldAlert size={13} /> {t("approval.approveAndTrust", lang)}
          </button>
          <button className="btn btn-reject" disabled={approvalSubmitting} onClick={() => handleApproval(false)}>
            <XCircle size={13} /> {t("approval.reject", lang)}
          </button>
        </div>
      </div>
    );
  };

  const createNewSessionInMode = (mode: SessionConfig["mode"]) => {
    if (!sessionStorageReady) return null;
    const session = createSession(mode);
    setSessions((previous) => [...previous, session]);
    setSidebarNav(mode);
    setCurrentSessionId(session.id);
    return session;
  };

  const createNewSession = () => {
    createNewSessionInMode(sidebarNav);
  };

  const switchSidebarMode = (mode: SessionConfig["mode"]) => {
    setSidebarNav(mode);
    if (currentSession.sessionConfig.mode === mode) return;
    const rememberedSessionId = lastSessionByModeRef.current[mode];
    const target = sessions.find((session) => (
      session.id === rememberedSessionId && session.sessionConfig.mode === mode
    )) || sessions
      .filter((session) => session.sessionConfig.mode === mode)
      .sort(compareSidebarSessions)[0];
    if (target) {
      setCurrentSessionId(target.id);
    } else {
      createNewSessionInMode(mode);
    }
  };
  switchSidebarModeRef.current = switchSidebarMode;

  const consumeSessionCheckpoints = async (sessionIds = Object.keys(checkpointBySession)) => {
    const checkpoints = sessionIds
      .map((sessionId) => checkpointBySession[sessionId])
      .filter((checkpoint): checkpoint is RunCheckpoint => Boolean(checkpoint));
    await Promise.all(checkpoints.map((checkpoint) => invoke("delete_git_checkpoint", {
      workDir: checkpoint.workDir,
      reference: checkpoint.reference,
    })));
  };

  const resetAllSessionUiState = () => {
    setDraftsBySession({});
    setAttachmentsBySession({});
    setAttachmentLoadingBySession({});
    setRuntimeBySession({});
    setCheckpointBySession({});
    setPreviewBySession({});
    setModifiedFilesBySession({});
    setWorkspaceBySession({});
    setTerminalLogsBySession({});
    setPreviewConsoleLogsBySession({});
    setPendingApprovalsBySession({});
    setApprovalSubmittingBySession({});
    setUsageStatsBySession({});
    setEditingMessageIdxBySession({});
    setEditTextBySession({});
    setExpandedActions({});
    setActiveRunSessionId(null);
    setPreparingRequestSessionId(null);
    isStreamingRef.current = false;
    requestStartingRef.current = false;
    activeRequestIdRef.current = "";
    activeRequestSessionIdRef.current = "";
    setFileContent(null);
    setSelectedFile(null);
    setDiffView(false);
    setActiveTab("activity");
    requestSessionByIdRef.current = {};
    workspaceRequestSequenceRef.current = {};
    fileRequestSequenceRef.current = {};
    streamedToolOutputKeysRef.current.clear();
    streamBufferRef.current = null;
    if (streamFlushRafRef.current !== null) {
      cancelAnimationFrame(streamFlushRafRef.current);
      streamFlushRafRef.current = null;
    }
    try {
      localStorage.removeItem("gx_drafts");
      localStorage.removeItem("gx_draft");
    } catch { /* ignore */ }
  };

  const dropSessionUiState = (sessionId: string) => {
    setDraftsBySession((previous) => omitSessionKey(previous, sessionId));
    setAttachmentsBySession((previous) => omitSessionKey(previous, sessionId));
    setAttachmentLoadingBySession((previous) => omitSessionKey(previous, sessionId));
    setRuntimeBySession((previous) => omitSessionKey(previous, sessionId));
    setCheckpointBySession((previous) => omitSessionKey(previous, sessionId));
    setPreviewBySession((previous) => omitSessionKey(previous, sessionId));
    setModifiedFilesBySession((previous) => omitSessionKey(previous, sessionId));
    setWorkspaceBySession((previous) => omitSessionKey(previous, sessionId));
    setTerminalLogsBySession((previous) => omitSessionKey(previous, sessionId));
    setPreviewConsoleLogsBySession((previous) => omitSessionKey(previous, sessionId));
    setPendingApprovalsBySession((previous) => omitSessionKey(previous, sessionId));
    setApprovalSubmittingBySession((previous) => omitSessionKey(previous, sessionId));
    setUsageStatsBySession((previous) => omitSessionKey(previous, sessionId));
    setEditingMessageIdxBySession((previous) => omitSessionKey(previous, sessionId));
    setEditTextBySession((previous) => omitSessionKey(previous, sessionId));
    delete workspaceRequestSequenceRef.current[sessionId];
    delete fileRequestSequenceRef.current[sessionId];
  };

  const replaceAllSessions = async (nextSessions: ChatSession[], preferredSessionId?: string) => {
    await consumeSessionCheckpoints();
    sessionPersistenceEpochRef.current += 1;
    await saveSessions(nextSessions);
    try { localStorage.setItem("gx_sessions", JSON.stringify(nextSessions)); } catch { /* backend is authoritative */ }
    resetAllSessionUiState();
    lastPersistedSessionsRef.current = Object.fromEntries(
      nextSessions.map((session) => [session.id, JSON.stringify(session)]),
    );
    setSessions(nextSessions);
    const nextId = preferredSessionId && nextSessions.some((session) => session.id === preferredSessionId)
      ? preferredSessionId
      : nextSessions[0].id;
    setCurrentSessionId(nextId);
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sessionStorageReady) return;
    if (sessions.length <= 1) return;
    if (attachmentLoadingBySession[id] || preparingRequestSessionId === id) {
      notify(lang === "zh" ? "附件仍在解析，请稍候再删除会话。" : "Wait for attachments to finish parsing before deleting this session.", "error");
      return;
    }
    if (runtimeBySession[id]) {
      notify(lang === "zh" ? "运行中的会话不能删除，请先停止任务。" : "Stop the running task before deleting this session.", "error");
      return;
    }
    const target = sessions.find(s => s.id === id);
    if (!window.confirm(lang === "zh" ? `确定删除会话"${target?.title || "未命名"}"吗？` : `Delete session "${target?.title || "Untitled"}"?`)) return;
    const remaining = sessions.filter((s) => s.id !== id);
    const targetMode = target?.sessionConfig.mode || sidebarNav;
    const orderedModeSessions = sessions
      .filter((session) => session.sessionConfig.mode === targetMode)
      .sort(compareSidebarSessions);
    const deletedVisibleIndex = orderedModeSessions.findIndex((session) => session.id === id);
    const remainingInMode = orderedModeSessions.filter((session) => session.id !== id);
    const fallbackSession = remainingInMode[Math.min(
      Math.max(deletedVisibleIndex, 0),
      Math.max(remainingInMode.length - 1, 0),
    )] || remaining[0];
    try {
      await consumeSessionCheckpoints([id]);
      sessionPersistenceEpochRef.current += 1;
      await deleteStoredSession(id);
      try { localStorage.setItem("gx_sessions", JSON.stringify(remaining)); } catch { /* backend is authoritative */ }
      setSessions(remaining);
      dropSessionUiState(id);
      delete lastPersistedSessionsRef.current[id];
    } catch (error) {
      addLog(`${lang === "zh" ? "删除失败" : "Delete failed"}: ${error}`, "error", true);
      return;
    }
    if (currentSessionId === id) {
      setCurrentSessionId(fallbackSession.id);
      setSidebarNav(fallbackSession.sessionConfig.mode || "chat");
    }
    notify(
      lang === "zh" ? `已删除会话：${target?.title || "未命名"}` : `Deleted session: ${target?.title || "Untitled"}`,
      "success",
    );
  };

  const toggleActionExpanded = (id: string) => {
    setExpandedActions((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleTool = (tool: string) => {
    const meta = TOOL_NAMES.find((item) => item.key === tool);
    const wasEnabled = config.tools_enabled.includes(tool);
    setConfig((prev) => ({
      ...prev,
      tools_enabled: prev.tools_enabled.includes(tool)
        ? prev.tools_enabled.filter((t) => t !== tool)
        : [...prev.tools_enabled, tool],
    }));
    addLog(
      lang === "zh"
        ? `${meta?.label || tool} 已${wasEnabled ? "禁用" : "启用"}`
        : `${meta?.label || tool} ${wasEnabled ? "disabled" : "enabled"}`,
      wasEnabled ? "info" : "success",
      true
    );
  };

  const removeTrustedPattern = async (toolName: string, pattern: string) => {
    try {
      const updatedConfig = await invoke<AppConfig>("remove_trusted_pattern", {
        currentConfig: config,
        toolName,
        pattern,
      });
      setConfig(updatedConfig);
    } catch (e) {
      addLog(`Failed to remove whitelist pattern: ${e}`, "error");
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setPrompt("");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming && currentMode === "code") {
        handleSteeringMessage();
      } else if (hasPendingRequest && !isStreaming) {
        notify(lang === "zh" ? "另一个会话正在运行，请先查看或停止该任务。" : "Another session is running. View or stop that task first.", "info");
      } else if (isAttachmentLoading) {
        notify(lang === "zh" ? "请等待附件解析完成。" : "Wait for attachments to finish parsing.", "info");
      } else {
        handleSendMessage();
      }
    }
  };

  const thinkingLevelLabel = (level: NonNullable<SessionConfig["thinkingLevel"]>) =>
    t(`session.thinking${level.charAt(0).toUpperCase() + level.slice(1)}`, lang);

  const setCurrentThinkingLevel = (level: NonNullable<SessionConfig["thinkingLevel"]>) => {
    setSessions((prev) => prev.map((s) =>
      s.id === currentSessionId
        ? { ...s, sessionConfig: { ...s.sessionConfig, thinkingLevel: level }, updatedAt: Date.now() }
        : s
    ));
  };

  const cycleThinkingLevel = () => {
    const currentLevel = currentSession.sessionConfig.thinkingLevel || "medium";
    const currentIndex = THINKING_LEVELS.indexOf(currentLevel);
    const nextLevel = THINKING_LEVELS[(currentIndex + 1) % THINKING_LEVELS.length];
    setCurrentThinkingLevel(nextLevel);
  };

  const statusIcon = (status: ToolAction["status"]) => {
    switch (status) {
      case "drafting":
      case "executing":
        return <Loader2 size={13} className="animate-spin" style={{ color: "var(--accent)" }} />;
      case "done":
        return <CheckCircle2 size={13} style={{ color: "var(--success)" }} />;
      case "error":
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
      case "error": return t("status.error", lang);
      case "blocked": return t("status.blocked", lang);
      case "pending_approval": return t("status.awaiting", lang);
      default: return status;
    }
  };

  const activeModelId = resolvedCurrentConfig.model;
  const currentThinkingLevel = resolvedCurrentConfig.thinking_level;
  const currentInputAttachmentTokens = attachments.reduce((sum, att) => {
    if (att.type === "image" && att.data) return sum + 1100;
    return sum + estimateTextTokens(att.data || "");
  }, 0);
  // Context token count shown in each message's meta line. Deliberately EXCLUDES
  // the live `prompt` so the message list can be memoized without depending on
  // every keystroke — the counter is an approximation and this meta line is
  // hidden by default (show_advanced_reply_info). The live input's contribution
  // is added back where a keystroke-accurate figure is actually needed.
  const currentContextTokensBase =
    estimateTextTokens(resolvedCurrentConfig.system_prompt) +
    (resolvedCurrentConfig.role_prompt ? estimateTextTokens(resolvedCurrentConfig.role_prompt) + 24 : 0) +
    estimateMessagesTokens(currentSession.messages) +
    currentInputAttachmentTokens;
  const currentModelLimit = modelContextLimit(activeModelId);
  const messageHasPendingApproval = (message: Message) => Boolean(
    pendingApprovals
    && message.actions?.some((action) => pendingApprovals.tool_calls.some((tc) => tc.id === action.id)),
  );
  const pendingApprovalHasInlineAction = currentSession.messages.some(messageHasPendingApproval);

  // Render a single message row. Kept as a closure (not a separate component)
  // so all the surrounding handlers/state stay in scope with zero prop
  // threading — this same function feeds both the plain list (short sessions)
  // and the virtualized list (long sessions).
  const renderMessage = (msg: Message, mIdx: number) => (
    msg.role === "context_divider" ? (
      <div key={mIdx} className="context-divider">
        <div className="context-divider-line" />
        <span className="context-divider-label">{lang === "zh" ? "上方上下文已忽略" : "Context Ignored Above"}</span>
        <div className="context-divider-line" />
        <button
          className="context-divider-remove"
          disabled={sessionMutationLocked}
          aria-label={lang === "zh" ? "移除上下文分隔线" : "Remove context divider"}
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
    <div
      key={mIdx}
      className={`chat-bubble-container ${msg.role} ${isStreaming && mIdx === currentSession.messages.length - 1 && msg.role === "assistant" ? "is-streaming" : ""}`}
      aria-busy={isStreaming && mIdx === currentSession.messages.length - 1 && msg.role === "assistant" ? true : undefined}
    >
      {editingMessageIdx === mIdx ? (
        <div className="edit-message-container">
          <textarea
            className="edit-message-textarea"
            disabled={sessionMutationLocked}
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
            <button className="btn btn-primary btn-sm" disabled={sessionMutationLocked} onClick={() => { void handleEditBranch(mIdx); }}>
              {lang === "zh" ? "创建分支" : "Create branch"}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditingMessageIdx(null)}>{lang === "zh" ? "取消" : "Cancel"}</button>
          </div>
        </div>
      ) : (
        <>
          {msg.role === "assistant" && msg.variants && msg.variants.length > 1 && (
            <div className="variant-nav variant-nav-top">
              <button
                className="variant-nav-btn"
                disabled={sessionMutationLocked || (msg.currentVariantIndex || 0) === 0}
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
                disabled={sessionMutationLocked || (msg.currentVariantIndex || 0) >= msg.variants.length - 1}
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
          {msg.role === "assistant" && msg.reasoningContent && (
            <details className="reasoning-chain reasoning-chain-top">
              <summary className="reasoning-chain-summary">
                <span className="reasoning-chain-icon">CoT</span>
                {t("reasoning.label", lang)}
                {isStreaming && mIdx === currentSession.messages.length - 1 && !msg.content && (
                  <span className="reasoning-chain-typing">...</span>
                )}
              </summary>
              <div className="reasoning-chain-content">
                <MarkdownContent content={msg.reasoningContent} lang={lang} />
              </div>
            </details>
          )}
          <div className="chat-bubble">
            {msg.role === "assistant" ? (
              <>
                {/* Tool actions — rendered BEFORE content, in order */}
                {msg.actions?.map((act, aIdx) => (
                  <Fragment key={`${act.id}-${aIdx}`}>
                    {act.name === "todo_write" && (
                      <TaskProgress
                        argumentsJson={act.arguments}
                        title={lang === "zh" ? "任务进度" : "Task progress"}
                      />
                    )}
                    <div className={`agent-action-card ${act.status}`}>
                    <div
                      className="agent-action-header"
                      role="button"
                      tabIndex={0}
                      aria-expanded={Boolean(expandedActions[act.id])}
                      onClick={() => toggleActionExpanded(act.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleActionExpanded(act.id);
                        }
                      }}
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
                  </Fragment>
                ))}

                {/* Search status indicators */}
                {msg.searchStatus && msg.searchStatus.length > 0 && (
                  <div className="search-status-list">
                    {msg.searchStatus.map((ss, ssIdx) => {
                      if (ss.type === "searching") {
                        return (
                          <div key={ssIdx} className="search-card searching">
                            <div className="search-card-header">
                              <span className="search-card-icon">&#128269;</span>
                              <span className="search-card-query">{ss.query}</span>
                              <span className="search-card-spinner" />
                            </div>
                          </div>
                        );
                      }
                      if (ss.type === "error") {
                        return (
                          <div key={ssIdx} className="search-card search-error">
                            <div className="search-card-header">
                              <span className="search-card-icon">&#9888;&#65039;</span>
                              <span className="search-card-query">{ss.query}</span>
                            </div>
                            <div className="search-card-meta">
                              <span>{ss.message}</span>
                              {ss.duration != null && <span> &middot; {ss.duration.toFixed(1)}s</span>}
                            </div>
                          </div>
                        );
                      }
                      if (ss.type === "results") {
                        // Use structured sources from backend, fallback to parsing if not available
                        const sources = ss.sources && ss.sources.length > 0
                          ? ss.sources
                          : ss.results
                            ? ss.results.split("\n---\n").map((block) => {
                                const title = (block.match(/Title:\s*(.+)/) || [])[1] || "";
                                const link = (block.match(/Link:\s*(.+)/) || [])[1] || "";
                                const snippet = (block.match(/Snippet:\s*([\s\S]+)/) || [])[1] || "";
                                return { title, link, snippet: snippet.trim() };
                              }).filter((s) => s.title || s.snippet)
                            : [];
                        return (
                          <details key={ssIdx} className="search-card results" open>
                            <summary className="search-card-header">
                              <span className="search-card-icon">&#128270;</span>
                              <span className="search-card-query">{ss.query}</span>
                              <span className="search-card-meta-inline">
                                {ss.resultCount ?? sources.length} {lang === "zh" ? "个结果" : "results"}
                                {ss.duration != null && ` · ${ss.duration.toFixed(1)}s`}
                                {ss.provider && ` · ${ss.provider}`}
                              </span>
                            </summary>
                            {sources.length > 0 && (
                              <div className="search-card-sources">
                                {sources.slice(0, 5).map((src, si) => (
                                  <div key={si} className="search-source-item">
                                    <div className="search-source-title">
                                      {src.link ? <a href={src.link} target="_blank" rel="noopener noreferrer">{src.title || src.link}</a> : src.title}
                                    </div>
                                    {src.snippet && <div className="search-source-snippet">{src.snippet}</div>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </details>
                        );
                      }
                      return null;
                    })}
                  </div>
                )}

                {/* Markdown content — rendered AFTER tool actions */}
                <div className="md-content">
                  <MarkdownContent content={msg.content} lang={lang} />
                  {isStreaming && mIdx === currentSession.messages.length - 1 && msg.role === "assistant" && (
                    <span className="typing-cursor" />
                  )}
                </div>

                {/* Inline approval card */}
                {pendingApprovals &&
                  msg.actions?.some((a) =>
                    pendingApprovals.tool_calls.some((tc) => tc.id === a.id)
                  ) && renderApprovalCard()}
              </>
            ) : (
              <>
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="message-attachments">
                    {msg.attachments.map((att, aIdx) => (
                      att.type === "image" && att.data ? (
                        <img
                          key={aIdx}
                          className="message-attachment-image"
                          src={att.data}
                          alt={att.name}
                        />
                      ) : (
                        <div key={aIdx} className="message-attachment-file">
                          <FileText size={12} />
                          <span title={att.warning || (att.truncated ? (lang === "zh" ? "内容已截断" : "Content truncated") : att.path)}>
                            {att.name}{att.warning ? " !" : att.truncated ? " …" : ""}
                          </span>
                        </div>
                      )
                    ))}
                  </div>
                )}
                {msg.content && <div className="user-message-text">{msg.content}</div>}
              </>
            )}
          </div>
          {isStreaming && mIdx === currentSession.messages.length - 1 && msg.role === "assistant" ? (
            <div
              className={`message-footer streaming-answer-status ${messageHasPendingApproval(msg) ? "awaiting-approval" : currentRuntime?.status === "stopping" ? "stopping" : ""}`}
              role="status"
              aria-live="polite"
            >
              {messageHasPendingApproval(msg) ? (
                <><ShieldAlert size={11} /> <span>{lang === "zh" ? "等待确认" : "Awaiting approval"}</span></>
              ) : currentRuntime?.status === "stopping" ? (
                <><Loader2 size={11} className="animate-spin" /> <span>{lang === "zh" ? "正在停止" : "Stopping"}</span></>
              ) : (
                <>
                  <span>{lang === "zh" ? "正在回答" : "Answering"}</span>
                  <span className="streaming-answer-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="message-footer">
              {msg.timestamp && (
                <div className="bubble-timestamp">
                  <span>{new Date(msg.timestamp).toLocaleTimeString(currentLocale, { hour: "2-digit", minute: "2-digit" })}</span>
                  {config.show_advanced_reply_info && msg.role === "assistant" && (
                    <>
                      <span className="bubble-meta-sep">·</span>
                      <span>{getModelDisplayName(msg.model || activeRequestModelRef.current || currentSession.sessionConfig.model || config.model)}</span>
                      <span className="bubble-meta-sep">·</span>
                      <span>输入 {formatTokenCount(msg.usage?.promptTokens || msg.contextTokens || 0)} / 输出 {formatTokenCount(msg.usage?.completionTokens || estimateTextTokens(msg.content))}</span>
                      <span className="bubble-meta-sep">·</span>
                      <span>上下文 {formatTokenCount(currentContextTokensBase)} / {formatTokenCount(currentModelLimit)}</span>
                      <span className="bubble-meta-sep">·</span>
                      <span>{formatDuration(msg.usage?.responseTimeMs)}</span>
                    </>
                  )}
                </div>
              )}
              {/* Message actions live outside the bubble so short user text is
                  never widened or made taller by invisible controls. */}
              <div className="bubble-actions">
              {msg.role === "assistant" && (
                <button
                  className="bubble-action-btn"
                  title={t("msg.retry", lang)}
                  disabled={sessionMutationLocked}
                  onClick={() => handleRetry(mIdx)}
                >
                  <RotateCcw size={12} />
                </button>
              )}
              <button
                className="bubble-action-btn"
                title={t("msg.edit", lang)}
                disabled={sessionMutationLocked}
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
                disabled={sessionMutationLocked}
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
          )}
        </>
      )}
    </div>
    )
  );

  // Above this many messages, switch to a virtualized list so DOM node count
  // stays bounded regardless of conversation length. Below it, a plain list
  // keeps native Ctrl+F and all existing behavior intact.
  const VIRTUALIZE_THRESHOLD = 80;
  const useVirtualized = currentSession.messages.length > VIRTUALIZE_THRESHOLD;

  // Pre-render the plain-list rows. Deps list everything renderMessage actually
  // reads EXCEPT `prompt` — so typing in the input box no longer rebuilds the
  // (up to 80) message shells. The live prompt was intentionally removed from
  // the meta line above so this exclusion is correct, not stale.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plainMessageRows = useMemo(
    () => currentSession.messages.map((msg, mIdx) => renderMessage(msg, mIdx)),
    [
      currentSession.messages,
      currentSessionId,
      editingMessageIdx,
      editText,
      isStreaming,
      sessionMutationLocked,
      expandedActions,
      lang,
      config.show_advanced_reply_info,
      pendingApprovals,
      currentRuntime?.status,
      currentContextTokensBase,
      currentModelLimit,
      currentLocale,
    ]
  );

  // ==========================================
  // Render
  // ==========================================

  const handleExportSessions = () => {
    exportAllSessions(sessions);
    notify(t("session.exportedAll", lang), "success");
    closeMenu();
  };

  const handleImportSessions = () => {
    if (sessionMutationLocked || hasAttachmentLoading) {
      notify(lang === "zh" ? "请先停止任务并等待附件解析完成，再导入会话。" : "Stop the active task and wait for attachments to finish parsing before importing sessions.", "error");
      closeMenu();
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        try {
          const imported = await importSessions(file);
          const normalized = normalizeSessions(imported);
          await replaceAllSessions(normalized, currentSessionId);
          notify(t("session.importedCount", lang, { count: String(normalized.length) }), "success");
        } catch (err) {
          notify(t("session.importFailed", lang), "error");
        }
      }
    };
    input.click();
    closeMenu();
  };

  const handleClearAll = async () => {
    if (sessionMutationLocked || hasAttachmentLoading) {
      notify(lang === "zh" ? "请先停止任务并等待附件解析完成，再清空会话。" : "Stop the active task and wait for attachments to finish parsing before clearing sessions.", "error");
      closeMenu();
      return;
    }
    if (confirm(t("settings.clearSessionsConfirm", lang))) {
      try {
        const replacement = createDefaultSession();
        await replaceAllSessions([replacement], replacement.id);
        notify(t("settings.cleared", lang), "success");
      } catch (error) {
        notify(`${lang === "zh" ? "清空失败" : "Clear failed"}: ${error}`, "error");
      }
    }
    closeMenu();
  };

  const handleShowStats = () => {
    setToolStatsDialog({
      title: t("stats.allSessions", lang),
      stats: getToolStats(sessions),
    });
    closeMenu();
  };

  const moveSessionInList = (sessionId: string, direction: "up" | "down") => {
    setSessions((previous) => moveSessionInSidebar(previous, sessionId, direction));
  };

  const toolStatsEntries = toolStatsDialog
    ? Object.entries(toolStatsDialog.stats).sort((a, b) => b[1] - a[1])
    : [];
  const toolStatsTotal = toolStatsEntries.reduce((sum, [, count]) => sum + count, 0);
  const toolStatsMax = toolStatsEntries[0]?.[1] || 0;
  const currentSettingsTabLabel = {
    model: t("settings.tab.model", lang),
    chat: t("settings.tab.chat", lang),
    agent: t("settings.tab.agent", lang),
    search: t("settings.tab.search", lang),
    data: t("settings.tab.data", lang),
  }[settingsTab];

  const handleSettingsTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = SETTINGS_TAB_ORDER.indexOf(settingsTab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? SETTINGS_TAB_ORDER.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + SETTINGS_TAB_ORDER.length)
          % SETTINGS_TAB_ORDER.length;
    const nextTab = SETTINGS_TAB_ORDER[nextIndex];
    setSettingsTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`settings-tab-${nextTab}`)?.focus());
  };

  return (
    <div className="app-container" onContextMenu={(e) => {
      // 只在空白区域显示全局菜单
      if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('chat-panel') || (e.target as HTMLElement).classList.contains('chat-messages')) {
        handleContextMenu(e);
      }
    }}>
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item ${toast.type === "cmd" ? "info" : toast.type}`}>
            <span className="toast-dot" />
            <span className="toast-text">{toast.text}</span>
          </div>
        ))}
      </div>

      {/* ====== Sidebar ====== */}
      <aside className="sidebar" style={{ width: sidebarWidth }}>
        {/* Pill Navigation */}
        <div className="sidebar-nav-pills">
          <button
            className={`sidebar-pill ${sidebarNav === "chat" ? "active" : ""}`}
            onClick={() => switchSidebarMode("chat")}
            aria-pressed={sidebarNav === "chat"}
          >
            <MessageSquare size={12} /> Chat
          </button>
          <button
            className={`sidebar-pill ${sidebarNav === "code" ? "active" : ""}`}
            onClick={() => switchSidebarMode("code")}
            aria-pressed={sidebarNav === "code"}
          >
            <TerminalIcon size={12} /> Code
          </button>
        </div>

        {/* New Session Button */}
        <div style={{ padding: "4px 10px" }}>
          <button className="btn sidebar-new-btn" disabled={!sessionStorageReady} onClick={createNewSession}>
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
              aria-label={lang === "zh" ? "搜索会话" : "Search sessions"}
            />
            {sessionSearch && (
              <button
                className="session-search-clear"
                aria-label={lang === "zh" ? "清除会话搜索" : "Clear session search"}
                onClick={() => setSessionSearch("")}
              >
                <X size={10} />
              </button>
            )}
          </div>
        </div>

        {/* Session List */}
        <div ref={historyListRef} className="history-list" aria-label={lang === "zh" ? "会话列表" : "Conversation list"}>
          {visibleSessions.map((s) => {
              const activePreset = ALL_PRESETS.find(p => p.id === s.sessionConfig.activeRolePresetId);
              const runtime = runtimeBySession[s.id];
              const awaitingApproval = Boolean(pendingApprovalsBySession[s.id]);
              const openSession = () => {
                setCurrentSessionId(s.id);
              };
              return (
            <div
              key={s.id}
              className={`history-item ${s.id === currentSessionId ? "active" : ""} ${s.pinned ? "pinned" : ""}`}
              role="button"
              data-session-id={s.id}
              tabIndex={s.id === tabbableSessionId ? 0 : -1}
              aria-current={s.id === currentSessionId ? "true" : undefined}
              onClick={openSession}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openSession();
                  return;
                }
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const items = Array.from(
                    event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".history-item") || [],
                  );
                  const currentIndex = items.indexOf(event.currentTarget);
                  const nextIndex = event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : Math.max(0, Math.min(
                          items.length - 1,
                          currentIndex + (event.key === "ArrowDown" ? 1 : -1),
                        ));
                  items[nextIndex]?.focus();
                }
              }}
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
                    {runtime && <> · {runtime.status === "stopping" ? (lang === "zh" ? "停止中" : "stopping") : (lang === "zh" ? "运行中" : "running")}</>}
                    {awaitingApproval && <> · {lang === "zh" ? "待审批" : "approval"}</>}
                    {s.messages.length > 0 && s.messages[s.messages.length - 1].timestamp && (
                      <> · {new Date(s.messages[s.messages.length - 1].timestamp!).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}</>
                    )}
                  </span>
                </div>
              </div>
              <span className="history-mode-tag" title={s.sessionConfig.mode === "code" ? t("mode.code", lang) : t("mode.chat", lang)}>
                {s.pinned ? <Pin size={10} /> : s.sessionConfig.mode === "code" ? <TerminalIcon size={10} /> : <MessageSquare size={10} />}
              </span>
            </div>
            );
          })}
          {visibleSessions.length === 0 && debouncedSearch.trim() && (
            <div className="search-empty-hint">
              {lang === "zh" ? "没有匹配的会话" : "No matching sessions"}
            </div>
          )}
        </div>

        {/* Context Menu */}
        {contextMenu && (
          <PositionedContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            className="context-menu"
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
                  <button className="context-menu-item" onClick={() => {
                    setSessions(prev => prev.map(s => s.id === contextMenu.sessionId ? {
                      ...s,
                      pinned: !s.pinned,
                    } : s));
                    setContextMenu(null);
                  }}>
                    <Pin size={12} /> {targetSession?.pinned ? t("context.unpin", lang) : t("context.pin", lang)}
                  </button>
                  {hasPreset && (
                    <button className="context-menu-item" onClick={() => {
                      setSessions(prev => prev.map(s => s.id === contextMenu.sessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, activeRolePresetId: null, systemPrompt: null, temperature: null },
                        updatedAt: Date.now(),
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
                    const s = sessions.find(s => s.id === contextMenu.sessionId);
                    if (!s) return;
                    setToolStatsDialog({
                      title: s.title || t("session.untitled", lang),
                      stats: getToolStats([s]),
                    });
                    setContextMenu(null);
                  }}>
                    <BarChart3 size={12} /> {t("context.toolStats", lang)}
                  </button>
                  <div className="context-menu-divider" />
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
                            const importedSession = createSession(
                              normalizeSessionConfig(imported.sessionConfig).mode,
                              imported.title || input.files![0].name,
                              imported.messages,
                            );
                            importedSession.sessionConfig = normalizeSessionConfig(imported.sessionConfig);
                            setSessions(prev => [...prev, importedSession]);
                            setCurrentSessionId(importedSession.id);
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
                            const titleMatch = text.match(/^# (.+)/m);
                            const importedSession = createSession(
                              sidebarNav,
                              titleMatch ? titleMatch[1] : input.files![0].name,
                              msgs,
                            );
                            setSessions(prev => [...prev, importedSession]);
                            setCurrentSessionId(importedSession.id);
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
                    moveSessionInList(contextMenu.sessionId, "up");
                    setContextMenu(null);
                  }}>
                    <ChevronLeft size={12} style={{ transform: "rotate(90deg)" }} /> {t("context.moveUp", lang)}
                  </button>
                  <button className="context-menu-item" onClick={() => {
                    moveSessionInList(contextMenu.sessionId, "down");
                    setContextMenu(null);
                  }}>
                    <ChevronRight size={12} style={{ transform: "rotate(90deg)" }} /> {t("context.moveDown", lang)}
                  </button>
                  {sessions.length > 1 && (
                    <button className="context-menu-item context-menu-item-danger" onClick={() => {
                      void deleteSession(contextMenu.sessionId, { stopPropagation: () => {} } as React.MouseEvent);
                      setContextMenu(null);
                    }}>
                      <Trash2 size={12} /> {t("context.delete", lang)}
                    </button>
                  )}
                </>
              );
            })()}
          </PositionedContextMenu>
        )}

        {/* Sidebar Footer */}
        <div className="sidebar-footer">
          <button
            className="sidebar-tools-summary"
            onClick={() => { setSettingsTab("agent"); setSettingsOpen(true); }}
            title={lang === "zh" ? "管理 Agent 与工具" : "Manage agent and tools"}
          >
            <span className="sidebar-tools-summary-icon"><Zap size={13} /></span>
            <span>{lang === "zh" ? "已启用工具" : "Enabled tools"}</span>
            <strong>{config.tools_enabled.length}</strong>
            <ChevronRight size={12} aria-hidden="true" />
          </button>
          {/* Profile Card */}
          <div className="sidebar-profile-card">
            <div className="sidebar-profile-avatar">
              {config.model ? getModelDisplayName(config.model).charAt(0).toUpperCase() : "G"}
            </div>
            <div className="sidebar-profile-info">
              <span className="sidebar-profile-name">{getModelDisplayName(resolvedCurrentConfig.model) || "gxAgent"}</span>
              <span className="sidebar-profile-meta">
                {resolvedCurrentConfig.base_url.replace(/^https?:\/\//, "").split("/")[0]}
              </span>
            </div>
            <ConnectionStatus
              compact
              state={resolvedCurrentConfig.base_url && resolvedCurrentConfig.model && (resolvedCurrentConfig.provider === "ollama" || Boolean(resolvedCurrentConfig.api_key)) ? "configured" : "unconfigured"}
              label={lang === "zh" ? "模型配置" : "Model configuration"}
              detail={resolvedCurrentConfig.base_url
                ? `${lang === "zh" ? "已配置" : "Configured"}: ${resolvedCurrentConfig.base_url}`
                : (lang === "zh" ? "尚未配置" : "Not configured")}
              onClick={() => { setSettingsTab("model"); setSettingsOpen(true); }}
            />
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
        role="separator"
        aria-orientation="vertical"
        aria-label={lang === "zh" ? "调整会话栏宽度" : "Resize conversation sidebar"}
        aria-valuemin={180}
        aria-valuemax={400}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const nextWidth = Math.max(180, Math.min(400, sidebarWidth + (event.key === "ArrowRight" ? 12 : -12)));
          setSidebarWidth(nextWidth);
          try { localStorage.setItem("gx_sidebar_width", String(nextWidth)); } catch { /* ignore */ }
        }}
      />

      {/* ====== Main Workspace ====== */}
      <div className="workspace-container">
        {/* LEFT: Chat */}
        <section className="chat-panel">
          <header className="panel-header">
            <div className="panel-heading">
              {editingSessionTitle ? (
                <input
                  className="session-title-editable"
                  value={currentSession.title}
                  onChange={(e) => {
                    setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, title: e.target.value } : s));
                  }}
                  onBlur={() => setEditingSessionTitle(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setEditingSessionTitle(false);
                    if (e.key === 'Escape') setEditingSessionTitle(false);
                  }}
                  autoFocus
                />
              ) : (
                <span
                  className="panel-title"
                  style={{ fontSize: "0.82rem", cursor: "pointer" }}
                  onDoubleClick={() => setEditingSessionTitle(true)}
                  title="双击编辑标题"
                >
                  {currentSession.title || t("session.new", lang)}
                </span>
              )}
              <div className="panel-subtitle">
                {effectiveWorkDir || "."}
                {sessionSaveStatus === "saving" && ` · ${lang === "zh" ? "保存中" : "saving"}`}
                {sessionSaveStatus === "error" && ` · ${lang === "zh" ? "保存失败" : "save failed"}`}
              </div>
            </div>
            <div className="panel-header-controls">
              <div className="panel-status-cluster">
                <span className={`mode-indicator ${currentMode}`}>
                  {currentMode === "chat" ? <MessageSquare size={11} /> : <TerminalIcon size={11} />}
                  {currentMode === "chat" ? t("mode.chat", lang) : t("mode.code", lang)}
                </span>
              </div>
              <div className="panel-action-cluster">
                <button
                  className="panel-toggle-btn"
                  onClick={toggleTheme}
                  title="Toggle theme"
                  aria-label={lang === "zh" ? "切换主题" : "Toggle theme"}
                >
                  {config.theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
                </button>
                <button
                  ref={sessionSettingsToggleRef}
                  className="panel-toggle-btn"
                  onClick={() => setSessionSettingsOpen(!sessionSettingsOpen)}
                  title={t("session.settings", lang)}
                  aria-haspopup="dialog"
                  aria-expanded={sessionSettingsOpen}
                >
                  <Settings2 size={14} />
                </button>
                <button
                  className="panel-toggle-btn"
                  onClick={() => setRightPanelOpen(!rightPanelOpen)}
                  title={rightPanelOpen ? "Close panel" : "Open panel"}
                  aria-expanded={rightPanelOpen}
                >
                  {rightPanelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
                </button>
                <button
                  className={`panel-toggle-btn ${alwaysOnTop ? "active" : ""}`}
                  aria-pressed={alwaysOnTop}
                  onClick={async () => {
                    const result = await invoke<boolean>("toggle_always_on_top");
                    setAlwaysOnTop(result);
                  }}
                  title={alwaysOnTop ? t("window.unpin", lang) : t("window.pin", lang)}
                >
                  <Pin size={14} />
                </button>
              </div>
            </div>
          </header>

          {/* Session Settings Panel */}
          {sessionSettingsOpen && (
            <div
              ref={sessionSettingsPanelRef}
              className="session-settings-panel"
              role="dialog"
              aria-labelledby="session-settings-title"
              tabIndex={-1}
            >
              <div className="session-settings-header">
                <span id="session-settings-title" style={{ fontWeight: 600, fontSize: "0.82rem" }}>{t("session.settings", lang)}</span>
                <button
                  className="panel-toggle-btn"
                  onClick={() => closeSessionSettings(true)}
                  aria-label={t("settings.close", lang)}
                >
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
                    value={currentSession.sessionConfig.systemPrompt ?? ""}
                    placeholder={config.system_prompt}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: {
                          ...s.sessionConfig,
                          systemPrompt: e.target.value || null,
                          activeRolePresetId: null,
                        },
                        updatedAt: Date.now(),
                      } : s));
                    }}
                  />
                </label>
                <label className="session-field">
                  <span className="session-label">Profile / API</span>
                  <select
                    className="session-select"
                    value={currentSession.sessionConfig.profileId || ""}
                    onChange={(event) => {
                      const profileId = event.target.value || null;
                      setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
                        ...session,
                        sessionConfig: { ...session.sessionConfig, profileId, model: null },
                        updatedAt: Date.now(),
                      } : session));
                    }}
                  >
                    <option value="">{lang === "zh" ? "继承全局连接" : "Inherit global connection"}</option>
                    {Object.entries(config.profiles).map(([profileId, profile]) => (
                      <option key={profileId} value={profileId}>{profile.name} ({profile.default_model})</option>
                    ))}
                  </select>
                </label>
                {/* Model */}
                <label className="session-field">
                  <span className="session-label">{t("session.model", lang)}</span>
                  <select
                    className="session-select"
                    value={currentSession.sessionConfig.model || ""}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, model: e.target.value || null },
                        updatedAt: Date.now(),
                      } : s));
                    }}
                  >
                    <option value="">{lang === "zh" ? `继承 (${resolvedCurrentConfig.model})` : `Inherit (${resolvedCurrentConfig.model})`}</option>
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
                    value={currentSession.sessionConfig.contextLimit ?? ""}
                    placeholder={String(config.context_limit)}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, contextLimit: e.target.value ? parseInt(e.target.value) : null },
                        updatedAt: Date.now(),
                      } : s));
                    }}
                  />
                </label>
                {/* Temperature */}
                <label className="session-field">
                  <span className="session-label">{t("session.temperature", lang)}: {resolvedCurrentConfig.temperature}{currentSession.sessionConfig.temperature === null ? ` (${lang === "zh" ? "继承" : "inherit"})` : ""}</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={currentSession.sessionConfig.temperature ?? resolvedCurrentConfig.temperature}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, temperature: parseFloat(e.target.value) },
                        updatedAt: Date.now(),
                      } : s));
                    }}
                  />
                  <button type="button" className={`session-btn ${currentSession.sessionConfig.temperature === null ? "active" : ""}`} onClick={() => {
                    setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
                      ...session,
                      sessionConfig: { ...session.sessionConfig, temperature: null },
                      updatedAt: Date.now(),
                    } : session));
                  }}>{lang === "zh" ? "继承" : "Inherit"}</button>
                </label>
                {/* Top P */}
                <label className="session-field">
                  <span className="session-label">{t("session.topP", lang)}: {resolvedCurrentConfig.top_p}{currentSession.sessionConfig.topP === null ? ` (${lang === "zh" ? "继承" : "inherit"})` : ""}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={currentSession.sessionConfig.topP ?? resolvedCurrentConfig.top_p}
                    onChange={(e) => {
                      setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, topP: parseFloat(e.target.value) },
                        updatedAt: Date.now(),
                      } : s));
                    }}
                  />
                  <button type="button" className={`session-btn ${currentSession.sessionConfig.topP === null ? "active" : ""}`} onClick={() => {
                    setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
                      ...session,
                      sessionConfig: { ...session.sessionConfig, topP: null },
                      updatedAt: Date.now(),
                    } : session));
                  }}>{lang === "zh" ? "继承" : "Inherit"}</button>
                </label>
                {/* Max Tokens */}
                <label className="session-field">
                  <span className="session-label">{t("session.maxTokens", lang)}</span>
                  <select className="session-select" value={currentSession.sessionConfig.maxTokens === "inherit" ? "inherit" : currentSession.sessionConfig.maxTokens === null ? "unlimited" : "custom"} onChange={(event) => {
                    const maxTokens = event.target.value === "inherit" ? "inherit" : event.target.value === "unlimited" ? null : (resolvedCurrentConfig.max_tokens || 4096);
                    setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
                      ...session,
                      sessionConfig: { ...session.sessionConfig, maxTokens },
                      updatedAt: Date.now(),
                    } : session));
                  }}>
                    <option value="inherit">{lang === "zh" ? "继承全局" : "Inherit global"}</option>
                    <option value="unlimited">{lang === "zh" ? "不限制" : "Unlimited"}</option>
                    <option value="custom">{lang === "zh" ? "自定义" : "Custom"}</option>
                  </select>
                  {typeof currentSession.sessionConfig.maxTokens === "number" && <input type="number" className="session-input session-input-sm" min={1} value={currentSession.sessionConfig.maxTokens} onChange={(event) => {
                    setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
                      ...session,
                      sessionConfig: { ...session.sessionConfig, maxTokens: Math.max(1, parseInt(event.target.value) || 1) },
                      updatedAt: Date.now(),
                    } : session));
                  }} />}
                </label>
                {/* Streaming */}
                <label className="session-field session-field-row">
                  <span className="session-label">{t("session.streaming", lang)}</span>
                  <select className="session-select" value={currentSession.sessionConfig.streaming === null ? "inherit" : String(currentSession.sessionConfig.streaming)} onChange={(event) => {
                    const streaming = event.target.value === "inherit" ? null : event.target.value === "true";
                    setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
                      ...session,
                      sessionConfig: { ...session.sessionConfig, streaming },
                      updatedAt: Date.now(),
                    } : session));
                  }}>
                    <option value="inherit">{lang === "zh" ? `继承 (${resolvedCurrentConfig.streaming ? "开" : "关"})` : `Inherit (${resolvedCurrentConfig.streaming ? "on" : "off"})`}</option>
                    <option value="true">{lang === "zh" ? "开启" : "On"}</option>
                    <option value="false">{lang === "zh" ? "关闭" : "Off"}</option>
                  </select>
                </label>
                <label className="session-field">
                  <span className="session-label">{lang === "zh" ? "工作目录" : "Working directory"}</span>
                  <input disabled={Boolean(runtimeBySession[currentSessionId])} className="session-input" value={currentSession.sessionConfig.workDir ?? ""} placeholder={config.default_work_dir || "."} onChange={(event) => {
                    setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
                      ...session,
                      sessionConfig: { ...session.sessionConfig, workDir: event.target.value || null },
                      updatedAt: Date.now(),
                    } : session));
                  }} />
                </label>
                {/* Thinking Level */}
                <label className="session-field">
                  <span className="session-label">{t("session.thinkingLevel", lang)}</span>
                  <div className="session-btn-group">
                    <button
                      type="button"
                      className={`session-btn ${currentSession.sessionConfig.thinkingLevel === null ? "active" : ""}`}
                      onClick={() => setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
                        ...session,
                        sessionConfig: { ...session.sessionConfig, thinkingLevel: null },
                        updatedAt: Date.now(),
                      } : session))}
                    >
                      {lang === "zh" ? "继承" : "Inherit"}
                    </button>
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
                      sessionConfig: { ...DEFAULT_SESSION_CONFIG, mode: s.sessionConfig.mode },
                      updatedAt: Date.now(),
                    } : s));
                  }}
                >
                  {t("session.reset", lang)}
                </button>
                {currentSession.compactBackup && (
                  <button className="btn btn-secondary" disabled={sessionMutationLocked} style={{ marginTop: 8, width: "100%" }} onClick={undoCompact}>
                    <RotateCcw size={13} /> {lang === "zh" ? "撤销历史压缩" : "Undo history compact"}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="chat-messages-outer">
            {currentSession.messages.length === 0 ? (
              <div className="chat-messages" ref={chatContainerRef}
                style={currentSession.sessionConfig.backgroundImage ? { backgroundImage: `url(${currentSession.sessionConfig.backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
                <div className="preview-placeholder">
                  <div className="welcome-icon" style={{ display: "flex", justifyContent: "center" }}>
                    <img src={CaturtleLogo} alt="gxAgent" width="80" height="80" style={{ opacity: 0.95 }} />
                  </div>
                  <h2 className="welcome-title">{t("welcome.title", lang)}</h2>
                </div>
              </div>
            ) : useVirtualized ? (
              <Virtuoso
                ref={virtuosoRef}
                className="chat-messages chat-messages-virtual"
                style={currentSession.sessionConfig.backgroundImage ? { backgroundImage: `url(${currentSession.sessionConfig.backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
                data={currentSession.messages}
                followOutput={(atBottom: boolean) => (atBottom ? "auto" : false)}
                atBottomStateChange={(atBottom: boolean) => { isAtBottomRef.current = atBottom; }}
                itemContent={(mIdx: number, msg: Message) => renderMessage(msg, mIdx)}
                components={{
                  Footer: () => (
                    isStreaming &&
                    currentSession.messages[currentSession.messages.length - 1]?.role !== "assistant" ? (
                      <div className="chat-bubble-container assistant is-streaming" aria-busy="true">
                        <div className="chat-bubble" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div className="loading-indicator">
                            <span className="loading-dot" />
                            <span className="loading-dot" />
                            <span className="loading-dot" />
                          </div>
                          <span style={{ fontSize: "0.8rem", color: "var(--accent)" }}>{t("thinking", lang)}</span>
                        </div>
                      </div>
                    ) : null
                  ),
                }}
              />
            ) : (
              <div className="chat-messages" ref={chatContainerRef} onScroll={() => {
                const el = chatContainerRef.current;
                if (!el) return;
                isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              }} style={currentSession.sessionConfig.backgroundImage ? { backgroundImage: `url(${currentSession.sessionConfig.backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
                {plainMessageRows}

                {isStreaming &&
                  currentSession.messages[currentSession.messages.length - 1]?.role !== "assistant" && (
                    <div className="chat-bubble-container assistant is-streaming" aria-busy="true">
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
            )}
          </div>

          <div
            className={`chat-input-wrapper ${dragOver ? "drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); if (!isAttachmentLoading && preparingRequestSessionId === null) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragOver(false);
              if (isAttachmentLoading || preparingRequestSessionId !== null) return;
              await addFilesAsAttachments(Array.from(e.dataTransfer.files));
            }}
          >
            {dragOver && (
              <div className="drag-overlay">{t("attach.drop", lang)}</div>
            )}
            {hasActiveRequest && !isStreaming && activeRunSession && (
              <button
                type="button"
                className="active-run-jump"
                onClick={() => {
                  setCurrentSessionId(activeRunSession.id);
                  setSidebarNav(activeRunSession.sessionConfig.mode);
                }}
              >
                <Loader2 size={13} className="spin" />
                <span>
                  {lang === "zh"
                    ? `“${activeRunSession.title || "未命名"}”${activeRunRuntime?.status === "stopping" ? "正在停止" : "正在运行"}，点击查看`
                    : `“${activeRunSession.title || "Untitled"}” is ${activeRunRuntime?.status === "stopping" ? "stopping" : "running"} — view task`}
                </span>
              </button>
            )}
            {preparingRequestSessionId !== null && !hasActiveRequest && (
              <div className="attachment-loading-status" role="status">
                <Loader2 size={13} className="spin" />
                {lang === "zh" ? "正在校验并准备请求…" : "Validating and preparing request…"}
              </div>
            )}
            {isAttachmentLoading && (
              <div className="attachment-loading-status" role="status">
                <Loader2 size={13} className="spin" />
                {lang === "zh" ? "正在解析附件…" : "Parsing attachments…"}
              </div>
            )}
            {pendingApprovals && (
              <div className={`approval-dock ${pendingApprovalHasInlineAction ? "has-inline" : ""}`}>
                {renderApprovalCard("approval-card-dock")}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="attachments-bar">
                {attachments.map((att, i) => (
                  <div key={i} className={`attachment-chip ${att.type}`}>
                    {att.type === "image" ? (
                      <img className="attachment-thumb" src={att.data} alt={att.name} />
                    ) : (
                      <FileText size={11} />
                    )}
                    <span className="attachment-name" title={att.warning || (att.truncated ? (lang === "zh" ? "内容已截断" : "Content truncated") : att.path)}>
                      {att.name}{att.warning ? " !" : att.truncated ? " …" : ""}
                    </span>
                    <button
                      className="attachment-remove"
                      disabled={!sessionStorageReady || isAttachmentLoading || preparingRequestSessionId !== null}
                      aria-label={`${lang === "zh" ? "移除附件" : "Remove attachment"}: ${att.name}`}
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={`chat-input-container${isStreaming && currentMode === "code" ? " steering-active" : ""}`} style={{ position: 'relative' }}>
              <CommandSuggestions
                input={prompt}
                onSelect={(cmd) => setPrompt(cmd)}
                lang={lang}
              />
              <textarea
                ref={chatTextareaRef}
                className="chat-textarea"
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                }}
                onPaste={handlePasteImage}
                onKeyDown={handleKeyPress}
                placeholder={isStreaming && currentMode === "code" ? t("input.steering", lang) : `${t("input.placeholder", lang)} (Shift+Enter ${lang === "zh" ? "换行" : "newline"})`}
                disabled={!sessionStorageReady || (isStreaming && currentMode === "chat") || preparingRequestSessionId === currentSessionId}
                rows={1}
              />
              <div className="chat-input-toolbar">
                <div className="chat-input-toolbar-left">
                  <span className="token-counter" style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginRight: '8px' }}>
                    {countTokens(prompt)} tokens
                  </span>
                  <div className="input-tool-group">
                  <button
                    className="btn btn-icon input-attach-btn"
                    title={t("role.title", lang)}
                    onClick={() => {
                      setModelPickerOpen(false);
                      setRolePresetsOpen((open) => !open);
                    }}
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
                            sessionConfig: { ...s.sessionConfig, activeRolePresetId: null, systemPrompt: null, temperature: null },
                            updatedAt: Date.now(),
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
                              <button className="role-preset-action-btn role-preset-action-btn-danger" title={t("msg.delete", lang)} onClick={(e) => {
                                e.stopPropagation();
                                setSessions((previous) => previous.map((session) => (
                                  session.sessionConfig.activeRolePresetId === role.id
                                    ? {
                                        ...session,
                                        sessionConfig: {
                                          ...session.sessionConfig,
                                          activeRolePresetId: null,
                                          systemPrompt: null,
                                          temperature: null,
                                        },
                                      }
                                    : session
                                )));
                                setCustomPresets(prev => prev.filter(p => p.id !== role.id));
                              }}>
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
                    disabled={!sessionStorageReady || isAttachmentLoading || preparingRequestSessionId !== null}
                    title={isAttachmentLoading
                      ? (lang === "zh" ? "正在解析附件" : "Attachments are being parsed")
                      : preparingRequestSessionId !== null
                        ? (lang === "zh" ? "正在准备请求" : "A request is being prepared")
                      : t("attach.drop", lang)}
                    onClick={() => { void pickAndParseAttachments(); }}
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
                    className={`input-icon-btn ${effectiveSearchMode !== "off" ? "active" : ""}`}
                    disabled={!webSearchAvailable}
                    title={!webSearchAvailable ? (lang === "zh" ? "请先在设置中启用 Web Search 工具" : "Enable the Web Search tool in settings") : searchMode === "off" ? t("search.modeOff", lang) : searchMode === "auto" ? t("search.modeAuto", lang) : t("search.modeForce", lang)}
                    onClick={() => {
                      const next = searchMode === "off" ? "auto" : searchMode === "auto" ? "force" : "off";
                      setSessions((prev) => prev.map((s) =>
                        s.id === currentSessionId ? { ...s, sessionConfig: { ...s.sessionConfig, searchMode: next }, updatedAt: Date.now() } : s
                      ));
                    }}
                  >
                    <Globe size={12} />
                    {effectiveSearchMode !== "off" && <span className={`search-active-dot ${effectiveSearchMode === "force" ? "force" : ""}`} />}
                  </button>
                  {config.provider === "ollama" && searchMode !== "off" && (
                    <span className="ollama-search-hint" title={lang === "zh" ? "Ollama 本地模型不支持工具调用，搜索功能可能不会生效" : "Ollama local models don't support tool calls, search may not work"}>
                      !
                    </span>
                  )}
                  </div>
                </div>
                <div className="chat-input-toolbar-right">
                <div className="input-run-group">
                <button
                  type="button"
                  className={`input-thinking-btn ${currentThinkingLevel}`}
                  onClick={cycleThinkingLevel}
                  title={`${t("session.thinkingLevel", lang)}: ${thinkingLevelLabel(currentThinkingLevel)}`}
                >
                  <Brain size={12} />
                  <span>{thinkingLevelLabel(currentThinkingLevel)}</span>
                </button>
                <div style={{ position: "relative" }}>
                  <button
                    className="input-model-btn"
                    onClick={() => {
                      setRolePresetsOpen(false);
                      setModelPickerOpen((open) => !open);
                    }}
                    title={t("session.model", lang)}
                  >
                    <span>{getModelDisplayName(resolvedCurrentConfig.model)}</span>
                    <ChevronDown size={9} />
                  </button>
                  {modelPickerOpen && (
                    <div className="model-picker-dropdown">
                      {Object.entries(config.profiles).map(([profileId, p]) => (
                        <button
                          key={profileId}
                          className={`model-picker-item ${currentSession.sessionConfig.profileId === profileId && currentSession.sessionConfig.model === null ? "active" : ""}`}
                          onClick={() => {
                            cacheModelDisplayName(p.default_model, p.name);
                            setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                              ...s,
                              sessionConfig: { ...s.sessionConfig, profileId, model: null },
                              updatedAt: Date.now(),
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
                                  sessionConfig: { ...s.sessionConfig, model: m.id },
                                  updatedAt: Date.now(),
                                } : s));
                                setModelPickerOpen(false);
                              }}
                            >
                              {m.id}
                            </button>
                          ))}
                        </>
                      )}
                      {(
                        <button
                          className={`model-picker-item ${currentSession.sessionConfig.profileId === null && currentSession.sessionConfig.model === null ? "active" : ""}`}
                          onClick={() => {
                            setSessions(prev => prev.map(s => s.id === currentSessionId ? {
                              ...s,
                              sessionConfig: { ...s.sessionConfig, profileId: null, model: null },
                              updatedAt: Date.now(),
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
                  className={`btn btn-primary btn-icon input-send-btn ${isStreaming ? "stop-active" : ""}`}
                  aria-label={isStreaming
                    ? (lang === "zh" ? "停止当前输出" : "Stop current output")
                    : (lang === "zh" ? "发送消息" : "Send message")}
                  onClick={isStreaming ? handleStopStreaming : handleSendMessage}
                  disabled={isStreaming
                    ? currentRuntime?.status === "stopping"
                    : !sessionStorageReady
                      || isAttachmentLoading
                      || preparingRequestSessionId !== null
                      || (hasActiveRequest && activeRunSessionId !== currentSessionId)
                      || (!prompt.trim() && !attachments.some(isSendableAttachment))}
                  title={isStreaming
                    ? currentRuntime?.status === "stopping"
                      ? (lang === "zh" ? "正在停止…" : "Stopping…")
                      : (lang === "zh" ? "停止当前输出" : "Stop current output")
                    : isAttachmentLoading
                      ? (lang === "zh" ? "请等待附件解析完成" : "Wait for attachments to finish parsing")
                      : preparingRequestSessionId !== null
                        ? (lang === "zh" ? "正在准备请求" : "Preparing request")
                      : hasActiveRequest
                        ? (lang === "zh" ? "另一个会话正在运行" : "Another session is running")
                        : undefined}
                >
                  {isStreaming ? <CircleStop size={14} /> : <Send size={13} />}
                </button>
                </div>
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
            role="separator"
            aria-orientation="vertical"
            aria-label={lang === "zh" ? "调整工作区面板宽度" : "Resize workspace panel"}
            aria-valuemin={200}
            aria-valuemax={600}
            aria-valuenow={rightPanelWidth}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const nextWidth = Math.max(200, Math.min(600, rightPanelWidth + (event.key === "ArrowLeft" ? 12 : -12)));
              setRightPanelWidth(nextWidth);
              try { localStorage.setItem("gx_right_panel_width", String(nextWidth)); } catch { /* ignore */ }
            }}
          />
        )}

        {rightPanelOpen && (
          <button
            type="button"
            className="canvas-backdrop"
            aria-label={lang === "zh" ? "关闭工作区面板" : "Close workspace panel"}
            onClick={() => setRightPanelOpen(false)}
          />
        )}

        {/* RIGHT: Workspace */}
        <section
          className={`canvas-panel ${rightPanelOpen ? "" : "collapsed"}`}
          style={{ width: rightPanelWidth }}
        >
          <div className="canvas-tab-bar" role="tablist" aria-label={lang === "zh" ? "工作区面板" : "Workspace panel"}>
            <button
              role="tab"
              aria-selected={activeTab === "activity"}
              className={`canvas-tab ${activeTab === "activity" ? "active" : ""}`}
              onClick={() => setActiveTab("activity")}
            >
              <Zap size={12} /> {t("activity", lang)}
            </button>
            <button
              role="tab"
              aria-selected={activeTab === "files"}
              className={`canvas-tab ${activeTab === "files" ? "active" : ""}`}
              onClick={() => setActiveTab("files")}
            >
              <FolderOpen size={12} /> {t("files", lang)}
            </button>
            <button
              role="tab"
              aria-selected={activeTab === "preview"}
              className={`canvas-tab ${activeTab === "preview" ? "active" : ""}`}
              onClick={() => setActiveTab("preview")}
            >
              <Eye size={12} /> {t("preview", lang)}
            </button>
            <button
              type="button"
              className="canvas-close-btn"
              title={lang === "zh" ? "关闭工作区面板" : "Close workspace panel"}
              aria-label={lang === "zh" ? "关闭工作区面板" : "Close workspace panel"}
              onClick={() => setRightPanelOpen(false)}
            >
              <X size={14} />
            </button>
          </div>

          <div className="canvas-body">
            <div className={`canvas-content-pane ${activeTab === "activity" ? "active" : ""}`}>
              <div className="activity-panel">
                {/* Tool Calls from current session */}
                <div className="activity-section">
                  <div className="activity-section-header">
                    <Zap size={11} /> {t("activity.toolCalls", lang)}
                  </div>
                  {(() => {
                    const allActions = currentSession.messages
                      .filter(m => m.role === "assistant" && m.actions && m.actions.length > 0)
                      .flatMap(m => m.actions || []);
                    if (allActions.length === 0) {
                      return <div className="activity-empty">{t("activity.empty", lang)}</div>;
                    }
                    return (
                      <div className="activity-list">
                        {allActions.slice(-20).reverse().map((act, idx) => (
                          <div key={idx} className={`activity-item ${act.status}`}>
                            <div className="activity-item-header">
                              <span className="activity-item-name">{act.name}</span>
                              <span className={`activity-item-badge ${act.status}`}>{statusLabel(act.status)}</span>
                            </div>
                            {act.output && (
                              <div className="activity-item-output">
                                {act.output.length > 120 ? act.output.slice(0, 120) + "..." : act.output}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                {/* Search Sources from current session */}
                <div className="activity-section">
                  <div className="activity-section-header">
                    <Globe size={11} /> {t("activity.searchSources", lang)}
                  </div>
                  {(() => {
                    const allSearchStatus = currentSession.messages
                      .filter(m => m.searchStatus && m.searchStatus.length > 0)
                      .flatMap(m => m.searchStatus || []);
                    const resultsWithSources = allSearchStatus.filter(s => s.type === "results" && s.sources && s.sources.length > 0);
                    if (resultsWithSources.length === 0) {
                      return <div className="activity-empty">{lang === "zh" ? "暂无搜索来源" : "No search sources yet"}</div>;
                    }
                    // Deduplicate sources by link
                    const allSources = resultsWithSources.flatMap(ss => ss.sources || []);
                    const seenLinks = new Set<string>();
                    const uniqueSources = allSources.filter(src => {
                      if (!src.link || seenLinks.has(src.link)) return false;
                      seenLinks.add(src.link);
                      return true;
                    });
                    return (
                      <div className="activity-list">
                        {uniqueSources.slice(0, 15).map((src, idx) => (
                          <div key={idx} className="activity-source-item">
                            <div className="activity-source-title">
                              {src.link ? <a href={src.link} target="_blank" rel="noopener noreferrer">{src.title || src.link}</a> : src.title}
                            </div>
                            {src.snippet && <div className="activity-source-snippet">{src.snippet}</div>}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                {/* Recent Logs (collapsed by default) */}
                <details className="activity-section activity-logs-section">
                  <summary className="activity-section-header">
                    <TerminalIcon size={11} /> {t("terminal", lang)}
                  </summary>
                  <div className="console-container">
                    {terminalLogs.slice(-50).map((log, idx) => (
                      <div key={idx} className={`console-line ${log.type}`}>
                        {log.type === "cmd" ? "> " : ""}
                        {log.text}
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            </div>

            <div className={`canvas-content-pane ${activeTab === "files" ? "active" : ""}`}>
              <div className="files-panel">
                <div className="files-header">
                  <span style={{ fontSize: "0.65rem", color: "var(--accent)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {t("files.workspace", lang)}
                  </span>
                  <button className="btn" style={{ padding: "3px 8px", fontSize: "0.72rem" }} onClick={() => { void refreshWorkspace(); }}>
                    <RefreshCw size={11} /> {t("files.refresh", lang)}
                  </button>
                </div>
                <WorkspaceTree
                  root={currentWorkspace.root}
                  lang={lang}
                  loading={currentWorkspace.loading}
                  error={currentWorkspace.treeError}
                  onSelect={(node) => { void selectWorkspaceFile(node); }}
                  onAttach={(node) => { void attachWorkspaceFile(node); }}
                  attachDisabled={isAttachmentLoading || sessionMutationLocked}
                  onRefresh={() => { void refreshWorkspace(); }}
                />
                <WorkspaceChanges
                  lang={lang}
                  branch={currentWorkspace.branch}
                  entries={currentWorkspace.entries}
                  selectedPath={currentWorkspace.selectedPath}
                  diff={currentWorkspace.diff}
                  loading={currentWorkspace.loading}
                  error={currentWorkspace.changesError}
                  checkpointAvailable={Boolean(checkpointBySession[currentSessionId])}
                  actionsDisabled={sessionMutationLocked}
                  onSelect={(entry) => { void selectGitEntry(entry); }}
                  onRefresh={() => { void refreshWorkspace(); }}
                  onRestorePath={(entry) => { void restoreGitEntry(entry); }}
                  onRestoreCheckpoint={() => { void restoreRunCheckpoint(); }}
                  onAcceptCheckpoint={() => { void acceptRunCheckpoint(); }}
                />
                {fileContent !== null && (
                  <div className="file-preview">
                    <div className="file-preview-header">
                      <FileText size={12} />
                      <span title={selectedFile || undefined}>{selectedFile}</span>
                      {selectedFile && modifiedFiles[selectedFile] && (
                        <button className="btn" style={{ padding: "2px 8px", fontSize: "0.68rem", marginLeft: "auto" }} onClick={() => setDiffView(!diffView)}>
                          {diffView ? t("files.current", lang) : t("files.diff", lang)}
                        </button>
                      )}
                    </div>
                    {diffView && selectedFile && modifiedFiles[selectedFile] ? (
                      <DiffView
                        oldContent={modifiedFiles[selectedFile].old}
                        newContent={modifiedFiles[selectedFile].new}
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
        <div className="modal-overlay" onMouseDown={(e) => {
          // Only close if clicking directly on overlay, not if mousedown started inside modal
          if (e.target === e.currentTarget) {
            setSettingsOpen(false);
          }
        }}>
          <div
            className="modal-content settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header settings-modal-header">
              <div className="settings-modal-title">
                <span className="settings-modal-title-icon"><Settings2 size={17} /></span>
                <div>
                  <h3 id="settings-dialog-title">{t("settings.title", lang)}</h3>
                  <span>{currentSettingsTabLabel}</span>
                </div>
              </div>
              <button
                type="button"
                className="settings-close-button"
                onClick={() => setSettingsOpen(false)}
                title={t("settings.close", lang)}
                aria-label={t("settings.close", lang)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="settings-tabs" role="tablist" aria-label={t("settings.title", lang)}>
              {([
                { id: "model" as const, label: t("settings.tab.model", lang), icon: <Zap size={14} /> },
                { id: "chat" as const, label: t("settings.tab.chat", lang), icon: <MessageSquare size={14} /> },
                { id: "agent" as const, label: t("settings.tab.agent", lang), icon: <ShieldAlert size={14} /> },
                { id: "search" as const, label: t("settings.tab.search", lang), icon: <Globe size={14} /> },
                { id: "data" as const, label: t("settings.tab.data", lang), icon: <Server size={14} /> },
              ]).map((tab) => (
                <button
                  key={tab.id}
                  id={`settings-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === tab.id}
                  aria-controls={`settings-panel-${tab.id}`}
                  tabIndex={settingsTab === tab.id ? 0 : -1}
                  autoFocus={settingsTab === tab.id}
                  className={`settings-tab ${settingsTab === tab.id ? "active" : ""}`}
                  onClick={() => setSettingsTab(tab.id)}
                  onKeyDown={handleSettingsTabKeyDown}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            <div ref={settingsBodyRef} className="modal-body settings-modal-body">
              {/* ===== Tab 1: 模型与 API ===== */}
              {settingsTab === "model" && (
              <section
                id="settings-panel-model"
                className="settings-page"
                role="tabpanel"
                aria-labelledby="settings-tab-model"
              >
              {/* API Profiles */}
              <div className="form-group settings-wide">
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

              {/* Request format (wire protocol) — decoupled from the provider
                  preset so a Claude model behind an OpenAI-compatible proxy can
                  still use the OpenAI format, etc. */}
              <div className="form-group">
                <label className="form-label">{t("settings.wireFormat", lang)}</label>
                <select
                  className="input-text"
                  value={config.wire_format || "openai"}
                  onChange={(e) => setConfig((prev) => ({ ...prev, wire_format: e.target.value }))}
                >
                  <option value="openai">{t("settings.wire.openai", lang)}</option>
                  <option value="anthropic">{t("settings.wire.anthropic", lang)}</option>
                  <option value="gemini">{t("settings.wire.gemini", lang)}</option>
                  <option value="ollama">{t("settings.wire.ollama", lang)}</option>
                </select>
                <div className="form-hint">{t("settings.wireFormat.hint", lang)}</div>
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
                <SecretInput
                  value={config.api_key}
                  onChange={(v) => setConfig((prev) => ({ ...prev, api_key: v }))}
                  placeholder="sk-..."
                  revealLabel={t("secret.reveal", lang)}
                  hideLabel={t("secret.hide", lang)}
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
              </section>
              )}

              {/* ===== Tab 2: 聊天体验 ===== */}
              {settingsTab === "chat" && (
              <section
                id="settings-panel-chat"
                className="settings-page"
                role="tabpanel"
                aria-labelledby="settings-tab-chat"
              >
              <div className="form-group settings-wide">
                <label className="form-label">{t("settings.theme", lang)}</label>
                <div className="theme-picker">
                  {THEME_OPTIONS.map((th) => (
                    <button
                      key={th.value}
                      type="button"
                      className={`theme-chip ${config.theme === th.value ? "active" : ""}`}
                      onClick={() => setConfig((prev) => ({ ...prev, theme: th.value }))}
                      title={lang === "zh" ? th.labelZh : th.label}
                    >
                      <span
                        className="theme-chip-swatch"
                        style={{ background: th.swatch.bg, borderColor: th.swatch.border }}
                      >
                        <span className="theme-chip-dot" style={{ background: th.swatch.accent }} />
                      </span>
                      <span className="theme-chip-label">{lang === "zh" ? th.labelZh : th.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group settings-wide">
                <label className="form-label">{t("settings.language", lang)}</label>
                <div className="lang-toggle">
                  {LANGUAGE_OPTIONS.map((option) => (
                    <button
                      key={option.code}
                      className={`lang-btn ${lang === option.code ? "active" : ""}`}
                      onClick={() => setConfig((prev) => ({ ...prev, language: option.code }))}
                    >
                      {option.label}
                    </button>
                  ))}
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

              <div className="form-group">
                <label className="form-label"><Type size={12} /> {t("settings.fontFamily", lang)}</label>
                <select
                  className="input-text"
                  value={config.font_family || "system"}
                  onChange={(e) => setConfig((prev) => ({ ...prev, font_family: e.target.value }))}
                >
                  {FONT_OPTIONS.map((font) => (
                    <option key={font.value} value={font.value}>{font.label}</option>
                  ))}
                </select>
              </div>

              <div className="form-group settings-wide">
                <label className="form-label">{t("settings.advancedReplyInfo", lang)}</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    className={`tool-toggle ${config.show_advanced_reply_info ? "active" : ""}`}
                    onClick={() => setConfig((prev) => ({ ...prev, show_advanced_reply_info: !prev.show_advanced_reply_info }))}
                  >
                    {config.show_advanced_reply_info ? t("settings.on", lang) : t("settings.off", lang)}
                  </button>
                  <span style={{ fontSize: "0.68rem", color: "var(--text-tertiary)" }}>
                    {t("settings.advancedReplyInfoDesc", lang)}
                  </span>
                </div>
              </div>

              <div className="form-group settings-wide">
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
              </section>
              )}

              {/* ===== Tab 3: Agent 与工具 ===== */}
              {settingsTab === "agent" && (
              <section
                id="settings-panel-agent"
                className="settings-page"
                role="tabpanel"
                aria-labelledby="settings-tab-agent"
              >
              <div className="form-group settings-wide">
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

              <div className="form-group settings-wide">
                <label className="form-label">{t("settings.workDir", lang)}</label>
                <input
                  type="text"
                  className="input-text"
                  value={config.default_work_dir}
                  disabled={sessionMutationLocked}
                  onChange={(e) => setConfig((prev) => ({ ...prev, default_work_dir: e.target.value }))}
                  placeholder="C:\Users\..."
                />
              </div>

              <div className="form-group settings-wide">
                <label className="form-label">{t("settings.tools", lang)}</label>
                <div className="tools-grid tool-card-grid">
                  {TOOL_NAMES.map((tool) => (
                    <button
                      key={tool.key}
                      onClick={() => toggleTool(tool.key)}
                      className={`tool-card-toggle ${config.tools_enabled.includes(tool.key) ? "active" : ""}`}
                    >
                      <span className="tool-card-icon">{toolIcon(tool.key, 13)}</span>
                      <span className="tool-card-body">
                        <span className="tool-card-title">{tool.label}</span>
                        <span className="tool-card-desc">{tool.description}</span>
                      </span>
                      <span className={`tool-risk ${tool.risk}`}>{tool.risk}</span>
                    </button>
                  ))}
                </div>
                <div className="tool-suggestion-note">
                  {lang === "zh"
                    ? "可考虑后续新增：Git 专用工具、网页抓取、SQLite/CSV 查询、PDF/Office 解析。现在先把高风险能力收敛在 Shell/Write，并保留审批策略。"
                    : "Good next additions: dedicated Git, web fetch, SQLite/CSV query, and PDF/Office parsing. For now, high-risk actions stay behind Shell/Write and approval policy."}
                </div>
              </div>

              {/* Whitelist Management */}
              <div className="form-group settings-wide">
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

              <div className="form-group settings-wide">
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
                <label className="form-label">{t("settings.maxAgentLoops", lang)}</label>
                <input
                  type="number"
                  className="input-text"
                  min={1}
                  max={20}
                  value={config.max_agent_loops}
                  onChange={(e) => setConfig((prev) => ({ ...prev, max_agent_loops: parseInt(e.target.value) || 10 }))}
                />
              </div>

              <div className="form-group">
                <label className="form-label">{t("settings.maxToolCalls", lang)}</label>
                <input
                  type="number"
                  className="input-text"
                  min={1}
                  max={100}
                  value={config.max_tool_calls_per_request}
                  onChange={(e) => setConfig((prev) => ({ ...prev, max_tool_calls_per_request: parseInt(e.target.value) || 30 }))}
                />
              </div>
              </section>
              )}

              {/* ===== Tab 4: 搜索 ===== */}
              {settingsTab === "search" && (
              <section
                id="settings-panel-search"
                className="settings-page settings-page-search"
                role="tabpanel"
                aria-labelledby="settings-tab-search"
              >
              <div className="settings-section-desc">
                {t("search.settings.desc", lang)}
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

              {config.search_provider === "duckduckgo" && (
                <div className="settings-section-desc" style={{ background: "rgba(245, 158, 11, 0.06)", borderColor: "rgba(245, 158, 11, 0.2)" }}>
                  {t("search.settings.fallbackDesc", lang)}
                </div>
              )}

              {config.search_provider !== "searxng" && (
                <div className="form-group">
                  <label className="form-label">{t("search.apiKey", lang)}</label>
                  <SecretInput
                    value={config.search_api_key}
                    onChange={(v) => setConfig((prev) => ({ ...prev, search_api_key: v }))}
                    placeholder={t("search.apiKeyPlaceholder", lang)}
                    revealLabel={t("secret.reveal", lang)}
                    hideLabel={t("secret.hide", lang)}
                  />
                  {config.search_provider !== "tavily" && (
                    <span style={{ fontSize: "0.66rem", opacity: 0.5, display: "block", marginTop: 2 }}>
                      {lang === "zh" ? "作为备用搜索引擎的 API Key" : "API Key for fallback search provider"}
                    </span>
                  )}
                </div>
              )}

              {config.provider === "ollama" && (
                <div className="settings-section-desc" style={{ background: "rgba(239, 68, 68, 0.06)", borderColor: "rgba(239, 68, 68, 0.2)" }}>
                  {t("search.settings.ollamaNote", lang)}
                </div>
              )}
              </section>
              )}

              {/* ===== Tab 5: 数据与高级 ===== */}
              {settingsTab === "data" && (
              <section
                id="settings-panel-data"
                className="settings-page settings-page-data"
                role="tabpanel"
                aria-labelledby="settings-tab-data"
              >
              <div className="settings-panel">
                <div className="settings-panel-header">
                  <span><Server size={13} /> {t("mcp.title", lang)}</span>
                  <span>{Object.keys(config.mcp_servers).length}</span>
                </div>
                <McpServerManager
                  lang={lang}
                  servers={Object.entries(config.mcp_servers).map(([name, server]) => ({
                    name,
                    command: server.command,
                    args: server.args || [],
                    state: mcpStatusByName[name]?.state || "stopped",
                    toolCount: mcpStatusByName[name]?.toolCount,
                    message: mcpStatusByName[name]?.message,
                  }))}
                  onTest={(name) => { void testMcpServer(name); }}
                  onDelete={(name) => { void deleteMcpServer(name); }}
                />
                <McpAddForm setConfig={setConfig} addLog={addLog} lang={lang} t={t} config={config} />
              </div>

              {/* Ollama Model Fetch */}
              {config.provider === "ollama" && (
                <div className="settings-panel">
                  <div className="settings-panel-header">
                    <span><Zap size={13} /> Ollama</span>
                  </div>
                  <button
                    className="settings-action-card"
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
                    <Search size={14} />
                    <span>{t("mcp.fetchModels", lang)}</span>
                  </button>
                </div>
              )}

              {/* Export / Import / Clear */}
              <div className="settings-panel">
                <div className="settings-panel-header">
                  <span><Save size={13} /> {t("settings.tab.data", lang)}</span>
                </div>
                <div className="settings-action-grid">
                  <button
                    className="settings-action-card"
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
                        addLog(t("settings.exported", lang), "success", true);
                      } catch (e) {
                        addLog(String(e), "error");
                      }
                    }}
                  >
                    <Download size={14} />
                    <span>{t("settings.exportConfig", lang)}</span>
                  </button>
                  <button
                    className="settings-action-card"
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
                          addLog(t("settings.imported", lang), "success", true);
                        } catch (e) {
                          addLog(t("settings.importFailed", lang) + String(e), "error", true);
                        }
                      };
                      input.click();
                    }}
                  >
                    <Upload size={14} />
                    <span>{t("settings.importConfig", lang)}</span>
                  </button>
                  <button
                    className="settings-action-card danger"
                    onClick={async () => {
                      if (sessionMutationLocked || hasAttachmentLoading) {
                        addLog(lang === "zh" ? "请先停止任务并等待附件解析完成。" : "Stop the active task and wait for attachments to finish parsing.", "error", true);
                        return;
                      }
                      if (!window.confirm(t("settings.clearSessionsConfirm", lang))) return;
                      try {
                        const replacement = createDefaultSession();
                        await replaceAllSessions([replacement], replacement.id);
                        notify(t("settings.cleared", lang), "success");
                      } catch (e) {
                        addLog(String(e), "error");
                      }
                    }}
                  >
                    <Trash size={14} />
                    <span>{t("settings.clearSessions", lang)}</span>
                  </button>
                </div>
              </div>
              </section>
              )}
            </div>

            <div className="modal-footer settings-modal-footer">
              <span role="status" style={{ marginRight: "auto", fontSize: "0.72rem", color: configSaveStatus === "error" ? "var(--error)" : "var(--text-secondary)" }}>
                {configSaveStatus === "saving" && (lang === "zh" ? "正在自动保存..." : "Auto-saving...")}
                {configSaveStatus === "saved" && (lang === "zh" ? "已自动保存" : "Saved")}
                {configSaveStatus === "error" && (lang === "zh" ? "自动保存失败" : "Auto-save failed")}
              </span>
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
      {toolStatsDialog && (
        <div className="modal-overlay" onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            setToolStatsDialog(null);
          }
        }}>
          <div className="modal-content stats-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="stats-modal-title">
                <BarChart3 size={15} /> {t("stats.title", lang)}
              </h3>
              <button className="btn" style={{ padding: "3px 8px", fontSize: "0.72rem" }} onClick={() => setToolStatsDialog(null)}>
                {t("settings.close", lang)}
              </button>
            </div>
            <div className="modal-body stats-modal-body">
              <div className="stats-summary">
                <span>{toolStatsDialog.title}</span>
                <strong>{t("stats.total", lang, { count: String(toolStatsTotal) })}</strong>
              </div>
              {toolStatsEntries.length > 0 ? (
                <div className="stats-list">
                  {toolStatsEntries.map(([name, count]) => (
                    <div className="stats-row" key={name}>
                      <div className="stats-row-header">
                        <span className="stats-tool-name">{name}</span>
                        <span className="stats-tool-count">{t("stats.count", lang, { count: String(count) })}</span>
                      </div>
                      <div className="stats-meter">
                        <span style={{ width: `${Math.max(4, Math.round((count / toolStatsMax) * 100))}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="stats-empty">{t("stats.empty", lang)}</div>
              )}
            </div>
          </div>
        </div>
      )}
      <OnboardingWizard
        open={onboardingOpen}
        lang={lang}
        values={onboardingValues}
        profiles={Object.entries(config.profiles).map(([id, profile]) => ({ ...profile, id }))}
        models={models}
        connection={onboardingConnection}
        onChange={updateOnboardingValues}
        onPickWorkspace={pickOnboardingWorkspace}
        onTestConnection={testOnboardingConnection}
        onComplete={completeOnboarding}
        onClose={dismissOnboarding}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          labels={{
            exportAll: t("context.exportAll", lang),
            importSessions: t("context.importSessions", lang),
            toolStats: t("context.toolStats", lang),
            settings: t("settings.title", lang),
            clearAll: t("settings.clearSessions", lang),
          }}
          onClose={closeMenu}
          onExport={handleExportSessions}
          onImport={handleImportSessions}
          onClearAll={handleClearAll}
          onShowStats={handleShowStats}
          onSettings={() => { setSettingsOpen(true); closeMenu(); }}
        />
      )}
    </div>
  );
}

export default App;
