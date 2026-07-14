export interface ApiProfile {
  name: string;
  base_url: string;
  api_key: string;
  default_model: string;
  wire_format: string;
  provider: string;
}

export interface AppConfig {
  provider: string;
  wire_format: string;
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  top_p: number;
  max_tokens: number | null;
  system_prompt: string;
  /** Request-only compatibility copy of an active role preset. Never persisted. */
  role_prompt?: string | null;
  streaming: boolean;
  thinking_level: "low" | "medium" | "high";
  context_limit: number;
  tools_enabled: string[];
  approval_policy: string;
  trusted_patterns: TrustedPattern[];
  default_work_dir: string;
  persist_trust: boolean;
  theme: string;
  language: string;
  profiles: Record<string, ApiProfile>;
  active_profile: string | null;
  mcp_servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  search_provider: string;
  search_api_key: string;
  font_size: number;
  font_family: string;
  show_advanced_reply_info: boolean;
  command_timeout: number;
  max_agent_loops: number;
  max_tool_calls_per_request: number;
  preview_sandbox: boolean;
  tools_migration_version: number;
}

export interface TrustedPattern {
  tool_name: string;
  pattern: string;
  created_at: number;
}

export interface ProviderPreset {
  name: string;
  provider: string;
  base_url: string;
  default_model: string;
  needs_api_key: boolean;
  wire_format: string;
}

export interface ModelInfo {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface ToolAction {
  id: string;
  name: string;
  arguments: string;
  status: "drafting" | "executing" | "done" | "error" | "blocked" | "pending_approval";
  output?: string;
  approval_level?: string;
}

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
}

export interface SearchStatus {
  type: "searching" | "results" | "error";
  query: string;
  results?: string;
  sources?: SearchResult[];
  resultCount?: number;
  message?: string;
  duration?: number;
  provider?: string;
}

export interface Attachment {
  name: string;
  type: "image" | "text";
  data: string;
  mimeType?: string;
  path?: string;
  warning?: string;
  truncated?: boolean;
  originalSize?: number;
}

export interface Message {
  role: "user" | "assistant" | "system" | "context_divider";
  content: string;
  attachments?: Attachment[];
  model?: string;
  contextTokens?: number;
  usage?: UsageStats;
  actions?: ToolAction[];
  reasoningContent?: string;
  variants?: string[];
  currentVariantIndex?: number;
  timestamp?: number;
  searchStatus?: SearchStatus[];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  sessionConfig: SessionConfig;
  pinned?: boolean;
  sidebarOrder: number;
  createdAt: number;
  updatedAt: number;
  compactBackup?: Message[];
}

export interface SessionConfig {
  schemaVersion: 2;
  mode: "chat" | "code";
  profileId: string | null;
  workDir: string | null;
  systemPrompt: string | null;
  model: string | null;
  contextLimit: number | null;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null | "inherit";
  streaming: boolean | null;
  thinkingLevel: "low" | "medium" | "high" | null;
  backgroundImage: string;
  activeRolePresetId: string | null;
  searchMode: "off" | "auto" | "force";
}

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  ttftMs: number;
  responseTimeMs: number;
  loopCount: number;
}

export interface PendingApproval {
  request_id: string;
  tool_calls: {
    id: string;
    name: string;
    arguments: string;
    approval_level: string;
  }[];
}
