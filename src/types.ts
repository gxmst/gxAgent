export interface ApiProfile {
  name: string;
  base_url: string;
  api_key: string;
  default_model: string;
}

export interface AppConfig {
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  top_p: number;
  max_tokens: number | null;
  system_prompt: string;
  streaming: boolean;
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
  command_timeout: number;
  preview_sandbox: boolean;
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
}

export interface Message {
  role: "user" | "assistant" | "system" | "context_divider";
  content: string;
  attachments?: Attachment[];
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
}

export interface SessionConfig {
  mode: "chat" | "code";
  systemPrompt: string;
  model: string;
  contextLimit: number;
  temperature: number;
  topP: number;
  maxTokens: number | null;
  streaming: boolean;
  thinkingLevel: "low" | "medium" | "high";
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
