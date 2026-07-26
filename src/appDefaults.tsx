/**
 * Module-scope app defaults, factories, normalizers, and static option
 * tables shared by the App shell. No component state lives here.
 */
import {
  CheckCircle2,
  FileText,
  FolderOpen,
  Globe,
  Pencil,
  Search,
  Settings2,
  Terminal as TerminalIcon,
  Zap,
} from "lucide-react";
import { t } from "./i18n";
import {
  AppConfig,
  ModelInfo,
  Attachment,
  ChatSession,
  ContextSummary,
  Message,
  SearchStatus,
  SessionConfig,
  ToolAction,
} from "./types";
import type { DirectoryNode } from "./components/workspace/WorkspaceTree";
import type { GitStatusEntry } from "./components/workspace/WorkspaceChanges";

// Stable message identity: React keys and context-boundary bookkeeping both
// need messages to survive reordering/insertion without index drift.
export function newMessageId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type ToastNotice = {
  id: number;
  text: string;
  type: "info" | "success" | "error" | "cmd";
  actionLabel?: string;
  onAction?: () => void;
};

export type AgentEventPayload<T extends Record<string, unknown> = Record<string, unknown>> =
  | string
  | (T & {
      requestId?: string;
      content?: string;
      status?: string;
    });

export type ToolStatsDialog = {
  title: string;
  stats: Record<string, number>;
};

export type SessionRuntime = {
  requestId: string;
  status: "running" | "stopping";
};

export type RunCheckpoint = {
  reference: string;
  commit: string;
  createdAt: number;
  label: string;
  workDir: string;
};

export type WorkspaceViewState = {
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

export const createEmptyWorkspaceState = (): WorkspaceViewState => ({
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

export const resolveWorkspacePath = (workDir: string, path: string) => {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")) return path;
  const separator = workDir.includes("\\") ? "\\" : "/";
  return `${workDir.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
};

export const comparableWorkspacePath = (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
};

// Rough token estimate: ~4 ASCII chars per token, 1 token per non-ASCII char.
export const estimateTextTokens = (text: string) => {
  const value = text || "";
  const nonAscii = (value.match(/[^\x00-\x7f]/g) || []).length;
  return Math.ceil((value.length - nonAscii) / 4 + nonAscii);
};

export const isSendableAttachment = (attachment: Attachment) => (
  attachment.type === "image" ? Boolean(attachment.data) : Boolean(attachment.data.trim())
);

export const MAX_ATTACHMENT_TEXT_PER_FILE = 50_000;
export const MAX_ATTACHMENT_TEXT_TOTAL = 100_000;
export const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_COUNT = 8;
export const MAX_IMAGE_ATTACHMENT_TOTAL_BYTES = 40 * 1024 * 1024;

export const estimateImageAttachmentBytes = (attachment: Attachment) => {
  if (attachment.originalSize && attachment.originalSize > 0) return attachment.originalSize;
  const payload = attachment.data.includes(",")
    ? attachment.data.slice(attachment.data.indexOf(",") + 1)
    : attachment.data;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
};

export const fitAttachmentBudget = (existing: Attachment[], candidates: Attachment[]) => {
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

export const omitSessionKey = <T,>(record: Record<string, T>, sessionId: string) => {
  const next = { ...record };
  delete next[sessionId];
  return next;
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
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
  trustAllOperations: false,
};

export const THINKING_LEVELS: NonNullable<SessionConfig["thinkingLevel"]>[] = ["low", "medium", "high"];

export const DEFAULT_CONFIG: AppConfig = {
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
  context_limit: 128000,
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
  max_agent_loops: 30,
  max_tool_calls_per_request: 120,
  preview_sandbox: true,
  tools_migration_version: 3,
};

export function createDefaultSession(): ChatSession {
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

export function createSession(mode: SessionConfig["mode"], title = "", messages: Message[] = []): ChatSession {
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

export function normalizeSessionConfig(raw: unknown): SessionConfig {
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
    // v1/v2 stored a message-count limit. Convert plausible legacy values to
    // the old effective token budget (roughly 400 tokens per message).
    contextLimit: input.contextLimit === null || input.contextLimit === undefined
      ? null
      : Math.min(1_000_000, Math.max(1000, (nullableNumber(input.contextLimit) ?? 0) <= 500
        ? (nullableNumber(input.contextLimit) ?? 50) * 400
        : nullableNumber(input.contextLimit) ?? 128000)),
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
    trustAllOperations: input.trustAllOperations === true,
  };
}

export const TOOL_ACTION_STATUSES = new Set<ToolAction["status"]>([
  "drafting", "executing", "done", "error", "blocked", "pending_approval",
]);

export function normalizeMessage(raw: unknown): Message | null {
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
    id: typeof input.id === "string" && input.id ? input.id : newMessageId(),
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

export function normalizeContextSummary(raw: unknown, messages: Message[]): ContextSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Partial<ContextSummary>;
  if (typeof input.summary !== "string" || !input.summary.trim()) return undefined;
  if (typeof input.dividerId !== "string" || !input.dividerId) return undefined;
  // A summary is only meaningful while its divider still exists in the session.
  if (!messages.some((message) => message.id === input.dividerId)) return undefined;
  return {
    summary: input.summary,
    dividerId: input.dividerId,
    createdAt: typeof input.createdAt === "number" && Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
  };
}

export function normalizeSessions(raw: unknown): ChatSession[] {
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
      const compactBackup = Array.isArray(item.compactBackup)
        ? item.compactBackup.map(normalizeMessage).filter((message): message is Message => Boolean(message))
        : undefined;
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
        // Optional flags default to absent so legacy sessions stay untouched.
        pinned: item.pinned === true ? true : undefined,
        archived: item.archived === true ? true : undefined,
        messages,
        sessionConfig: normalizeSessionConfig(item.sessionConfig),
        sidebarOrder,
        createdAt,
        updatedAt,
        compactBackup,
        compactBackupContextSummary: normalizeContextSummary(item.compactBackupContextSummary, compactBackup || []),
        contextSummary: normalizeContextSummary(item.contextSummary, messages),
      };
    });

  return normalized.length > 0 ? normalized : [createDefaultSession()];
}

export function readLocalSessions(): ChatSession[] {
  try {
    const saved = localStorage.getItem("gx_sessions");
    if (saved) return normalizeSessions(JSON.parse(saved));
  } catch { /* ignore corrupt data */ }
  return [createDefaultSession()];
}

export const TOOL_NAMES: { key: string; label: string; shortLabel: string; description: string; risk: "low" | "medium" | "high" }[] = [
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

export const toolIcon = (key: string, size = 11) => {
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

export const LANGUAGE_OPTIONS = [
  { code: "zh", label: "中文", locale: "zh-CN" },
  { code: "en", label: "English", locale: "en-US" },
  { code: "ja", label: "日本語", locale: "ja-JP" },
  { code: "ko", label: "한국어", locale: "ko-KR" },
  { code: "es", label: "Español", locale: "es-ES" },
];

export const FONT_OPTIONS = [
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
export const THEME_OPTIONS: {
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

export const themeMode = (theme: string): "light" | "dark" =>
  THEME_OPTIONS.find((t) => t.value === theme)?.mode ?? "light";

// "Assistant is thinking" placeholder bubble, shared by the plain and
// virtualized message lists.
export const ThinkingBubble = ({ lang }: { lang: string }) => (
  <div className="chat-bubble-container assistant is-streaming" aria-busy="true">
    <div className="chat-bubble" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div className="loading-indicator">
        <span className="loading-dot" />
        <span className="loading-dot" />
        <span className="loading-dot" />
      </div>
      <span style={{ fontSize: "var(--font-small)", color: "var(--accent)" }}>{t("thinking", lang)}</span>
    </div>
  </div>
);

// Module-level Virtuoso components: an inline `Footer: () => …` closure is a
// new component type on every render, which makes Virtuoso unmount and
// remount the footer each frame while streaming. State flows in via the
// `context` prop instead.
export type ChatListContext = { showThinking: boolean; lang: string };
export const ChatListFooter = ({ context }: { context?: ChatListContext }) =>
  context?.showThinking ? <ThinkingBubble lang={context.lang} /> : null;
export const CHAT_VIRTUOSO_COMPONENTS = { Footer: ChatListFooter };

export const CONTEXT_BUDGET_OPTIONS = [128_000, 256_000, 500_000, 1_000_000] as const;
export const MAX_CONTEXT_BUDGET = 1_000_000;

type ModelCatalogConnection = Pick<AppConfig, "wire_format" | "base_url">;

export const modelCatalogKey = (connection: ModelCatalogConnection) => {
  const wireFormat = (connection.wire_format || "openai").trim().toLowerCase();
  const baseUrl = connection.base_url.trim().replace(/\/+$/, "");
  return `${wireFormat}\n${baseUrl}`;
};

export const modelCatalogForConfig = (
  models: ModelInfo[],
  sourceKey: string | null,
  connection: ModelCatalogConnection,
) => sourceKey === modelCatalogKey(connection) ? models : [];

/** Best-effort model context window. The provider's own model list is the
 *  authority when it reports one (context_length); the name-based table is
 *  only the fallback for lists that don't. */
export const modelContextLimit = (modelId: string, models?: ModelInfo[]) => {
  const reported = models?.find((m) => m.id === modelId)?.context_length;
  if (typeof reported === "number" && reported >= 1_000) return reported;
  const id = modelId.toLowerCase();
  if (id.includes("gpt-4o") || id.includes("gpt-4.1") || id.includes("gpt-5")) return 128000;
  if (id.includes("claude")) return 200000;
  if (id.includes("gemini")) return 1000000;
  if (id.includes("deepseek")) return 64000;
  if (id.includes("qwen")) return 128000;
  if (id.includes("llama")) return 128000;
  return 128000;
};

export const modelContextLimitForConfig = (
  modelId: string,
  models: ModelInfo[],
  sourceKey: string | null,
  connection: ModelCatalogConnection,
) => modelContextLimit(modelId, modelCatalogForConfig(models, sourceKey, connection));

export const formatContextBudget = (value: number) => value >= 1_000_000 ? "1M" : (Math.round(value / 1000) + "K");
