/**
 * The full settings dialog: five tabs (model/chat/agent/search/data),
 * API profiles, whitelist and MCP management, import/export.
 *
 * Extracted verbatim from App.tsx; all state still lives in App and comes
 * in through props, so behavior is unchanged. Splitting the tabs into
 * their own components (and giving them local state) is the follow-up.
 */
import type { KeyboardEvent, RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Download,
  Globe,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings2,
  ShieldAlert,
  Timer,
  Trash,
  Trash2,
  Type,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { t } from "../../i18n";
import type { AppConfig, ChatSession, ModelInfo, ProviderPreset } from "../../types";
import {
  CONTEXT_BUDGET_OPTIONS,
  FONT_OPTIONS,
  LANGUAGE_OPTIONS,
  MAX_CONTEXT_BUDGET,
  THEME_OPTIONS,
  TOOL_NAMES,
  createDefaultSession,
  formatContextBudget,
  toolIcon,
} from "../../appDefaults";
import { SecretInput } from "../shared/SecretInput";
import { McpAddForm } from "../mcp/McpAddForm";
import { McpServerManager, type McpServerView } from "../mcp/McpServerManager";

type SettingsTab = "model" | "chat" | "agent" | "search" | "data";

export interface SettingsModalProps {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  models: ModelInfo[];
  setModels: React.Dispatch<React.SetStateAction<ModelInfo[]>>;
  modelsLoading: boolean;
  settingsTab: SettingsTab;
  setSettingsTab: React.Dispatch<React.SetStateAction<SettingsTab>>;
  setSettingsOpen: (open: boolean) => void;
  settingsBodyRef: RefObject<HTMLDivElement | null>;
  handleSettingsTabKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  currentSettingsTabLabel: string;
  newProfileName: string;
  setNewProfileName: React.Dispatch<React.SetStateAction<string>>;
  handleSaveProfile: () => void;
  handleActivateProfile: (name: string) => void;
  handleClearActiveProfile: () => void;
  handleDeleteProfile: (name: string) => void;
  fetchModelList: () => void;
  saveConfig: () => Promise<void>;
  configSaveStatus: "idle" | "saving" | "saved" | "error";
  addLog: (text: string, type?: "info" | "success" | "error" | "cmd", showToast?: boolean, sessionId?: string) => void;
  notify: (text: string, type?: "info" | "success" | "error" | "cmd") => void;
  customGlobalContextBudget: boolean;
  setCustomGlobalContextBudget: React.Dispatch<React.SetStateAction<boolean>>;
  toggleTool: (tool: string) => void;
  removeTrustedPattern: (toolName: string, pattern: string) => void;
  mcpStatusByName: Record<string, Pick<McpServerView, "state" | "toolCount" | "message">>;
  testMcpServer: (name: string) => void;
  deleteMcpServer: (name: string) => void;
  presets: ProviderPreset[];
  applyPreset: (preset: ProviderPreset) => void;
  sessionMutationLocked: boolean;
  hasAttachmentLoading: boolean;
  replaceAllSessions: (sessions: ChatSession[], currentId: string) => void;
}

export function SettingsModal(props: SettingsModalProps) {
  const {
    lang, config, setConfig, models, setModels, modelsLoading,
    settingsTab, setSettingsTab, setSettingsOpen, settingsBodyRef,
    handleSettingsTabKeyDown, currentSettingsTabLabel,
    newProfileName, setNewProfileName, handleSaveProfile,
    handleActivateProfile, handleClearActiveProfile, handleDeleteProfile,
    fetchModelList, saveConfig, configSaveStatus, addLog, notify,
    customGlobalContextBudget, setCustomGlobalContextBudget,
    toggleTool, removeTrustedPattern, mcpStatusByName, testMcpServer,
    deleteMcpServer, presets, applyPreset, sessionMutationLocked,
    hasAttachmentLoading, replaceAllSessions,
  } = props;

  return (
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
                      <button className="btn" style={{ padding: "2px 8px", fontSize: "var(--font-caption)" }} onClick={() => handleActivateProfile(p.name)}>
                        {t("profile.activate", lang)}
                      </button>
                    ) : (
                      <span className="profile-active-badge">{t("profile.active", lang)}</span>
                    )}
                    <button className="btn" style={{ padding: "2px 6px", fontSize: "var(--font-caption)", color: "var(--error)" }} onClick={() => handleDeleteProfile(p.name)}>
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
              <button className="btn" style={{ padding: "3px 8px", fontSize: "var(--font-caption)", marginTop: 4 }} onClick={handleClearActiveProfile}>
                {t("profile.clearActive", lang)}
              </button>
            )}
            <div className="profile-add" style={{ marginTop: 6 }}>
              <input
                type="text"
                className="input-text"
                style={{ fontSize: "var(--font-caption)" }}
                placeholder={t("profile.newName", lang)}
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
              />
              <button className="btn" style={{ padding: "3px 8px", fontSize: "var(--font-caption)" }} onClick={handleSaveProfile} disabled={!newProfileName.trim()}>
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
                  <optgroup label={t("ui.available-models-2", lang)}>
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
                title={t("ui.fetch-model-list", lang)}
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
              <span style={{ fontSize: "var(--font-caption)", color: "var(--text-tertiary)" }}>
                {t("settings.advancedReplyInfoDesc", lang)}
              </span>
            </div>
          </div>

          <div className="form-group settings-wide">
            <label className="form-label">{t("settings.systemPrompt", lang)}</label>
            <textarea
              className="input-text"
              style={{ height: "64px", resize: "none", fontSize: "var(--font-small)" }}
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
            <select className="input-text" value={customGlobalContextBudget ? "custom" : CONTEXT_BUDGET_OPTIONS.includes(config.context_limit as typeof CONTEXT_BUDGET_OPTIONS[number]) ? String(config.context_limit) : "custom"} onChange={(event) => {
              setCustomGlobalContextBudget(event.target.value === "custom");
              if (event.target.value !== "custom") setConfig((prev) => ({ ...prev, context_limit: Number(event.target.value) }));
            }}>
              {CONTEXT_BUDGET_OPTIONS.map((value) => <option key={value} value={value}>{formatContextBudget(value)}</option>)}
              <option value="custom">{t("ui.custom", lang)}</option>
            </select>
            {(customGlobalContextBudget || !CONTEXT_BUDGET_OPTIONS.includes(config.context_limit as typeof CONTEXT_BUDGET_OPTIONS[number])) && <input type="number" className="input-text" min={1000} max={MAX_CONTEXT_BUDGET} step={1000} value={config.context_limit} onChange={(event) => setConfig((prev) => ({ ...prev, context_limit: Math.min(MAX_CONTEXT_BUDGET, Math.max(1000, Number(event.target.value) || 1000)) }))} />}
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
              {t("ui.tool-suggestion-note", lang)}
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
              <span style={{ fontSize: "var(--font-caption)", opacity: 0.6 }}>
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
              max={100}
              value={config.max_agent_loops}
              onChange={(e) => setConfig((prev) => ({ ...prev, max_agent_loops: parseInt(e.target.value) || 30 }))}
            />
          </div>

          <div className="form-group">
            <label className="form-label">{t("settings.maxToolCalls", lang)}</label>
            <input
              type="number"
              className="input-text"
              min={1}
              max={500}
              value={config.max_tool_calls_per_request}
              onChange={(e) => setConfig((prev) => ({ ...prev, max_tool_calls_per_request: parseInt(e.target.value) || 120 }))}
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
              <span className="settings-recommend-tag">{t("ui.recommended-official-api", lang)}</span>
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
                <span style={{ fontSize: "var(--font-caption)", opacity: 0.5, display: "block", marginTop: 2 }}>
                  {t("ui.api-key-for-fallback-search", lang)}
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
                    addLog(t("ui.stop-the-active-task-and-3", lang), "error", true);
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
          <span role="status" style={{ marginRight: "auto", fontSize: "var(--font-caption)", color: configSaveStatus === "error" ? "var(--error)" : "var(--text-secondary)" }}>
            {configSaveStatus === "saving" && (t("ui.auto-saving", lang))}
            {configSaveStatus === "saved" && (t("ui.saved", lang))}
            {configSaveStatus === "error" && (t("ui.auto-save-failed", lang))}
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
  );
}
