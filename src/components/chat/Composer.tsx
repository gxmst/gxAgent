/**
 * Chat composer: prompt textarea with auto-resize, attachment strip and
 * drag-and-drop, role-presets panel, model picker, thinking-level cycle,
 * search-mode toggle, send/stop button and the usage footer.
 *
 * Extracted verbatim from App.tsx. Session/runtime/approval state comes from
 * the zustand store; App-local state (prompt, attachments, popover open
 * flags — the latter also drive App's global Escape handler) and the request
 * handlers flow in as props. The drag-over highlight is component-local.
 */
import { useLayoutEffect, useState, type ClipboardEvent } from "react";
import {
  Brain,
  ChevronDown,
  CircleStop,
  FileText,
  Globe,
  Loader2,
  Pencil,
  Plus,
  PlusCircle,
  Quote,
  Send,
  Sparkles,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { t } from "../../i18n";
import type { AppConfig, Attachment, ChatSession, ModelInfo, SessionConfig } from "../../types";
import { ROLE_PRESETS, ROLE_CATEGORIES, RolePreset } from "../../rolePresets";
import { countTokens } from "../../utils/helpers";
import { CommandSuggestions } from "../shared/CommandSuggestions";
import { CustomPresetForm } from "../CustomPresetForm";
import { THINKING_LEVELS, isSendableAttachment, newMessageId } from "../../appDefaults";
import { ApprovalCard, messageHasPendingApproval } from "./ApprovalCard";
import { useAppStore } from "../../store/appStore";
import { addLog, notify } from "../../services/agentEvents";
import { sortModels, sortProfileEntries } from "../../utils/modelSorting";

export interface ComposerProps {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  currentSession: ChatSession;
  resolvedCurrentConfig: AppConfig;
  sessionStorageReady: boolean;
  isAttachmentLoading: boolean;
  attachments: Attachment[];
  setAttachments: (next: Attachment[] | ((previous: Attachment[]) => Attachment[])) => void;
  prompt: string;
  setPrompt: (next: string | ((previous: string) => string)) => void;
  chatTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  handleSendMessage: () => Promise<void>;
  handleStopStreaming: () => Promise<void>;
  handleSteeringMessage: () => Promise<void>;
  addFilesAsAttachments: (files: File[]) => Promise<void>;
  pickAndParseAttachments: () => Promise<void>;
  patchSessionConfig: (patch: Partial<SessionConfig>) => void;
  allPresets: RolePreset[];
  customPresets: RolePreset[];
  setCustomPresets: React.Dispatch<React.SetStateAction<RolePreset[]>>;
  rolePresetsOpen: boolean;
  setRolePresetsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  modelPickerOpen: boolean;
  setModelPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  customPresetForm: boolean;
  setCustomPresetForm: React.Dispatch<React.SetStateAction<boolean>>;
  editingCustomPreset: RolePreset | null;
  setEditingCustomPreset: React.Dispatch<React.SetStateAction<RolePreset | null>>;
  setSidebarNav: React.Dispatch<React.SetStateAction<"chat" | "code">>;
  getModelDisplayName: (modelId: string) => string;
  cacheModelDisplayName: (modelId: string, displayName: string) => void;
  modelsForCurrentConfig: ModelInfo[];
}

export function Composer({
  lang,
  config,
  setConfig,
  currentSession,
  resolvedCurrentConfig,
  sessionStorageReady,
  isAttachmentLoading,
  attachments,
  setAttachments,
  prompt,
  setPrompt,
  chatTextareaRef,
  handleSendMessage,
  handleStopStreaming,
  handleSteeringMessage,
  addFilesAsAttachments,
  pickAndParseAttachments,
  patchSessionConfig,
  allPresets,
  customPresets,
  setCustomPresets,
  rolePresetsOpen,
  setRolePresetsOpen,
  modelPickerOpen,
  setModelPickerOpen,
  customPresetForm,
  setCustomPresetForm,
  editingCustomPreset,
  setEditingCustomPreset,
  setSidebarNav,
  getModelDisplayName,
  cacheModelDisplayName,
  modelsForCurrentConfig,
}: ComposerProps) {
  const sessions = useAppStore((s) => s.sessions);
  const setSessions = useAppStore((s) => s.setSessions);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setCurrentSessionId = useAppStore((s) => s.setCurrentSessionId);
  const activeRunSessionId = useAppStore((s) => s.activeRunSessionId);
  const preparingRequestSessionId = useAppStore((s) => s.preparingRequestSessionId);
  const currentRuntime = useAppStore((s) => s.runtimeBySession[s.currentSessionId] || null);
  const pendingApprovals = useAppStore((s) => s.pendingApprovalsBySession[s.currentSessionId] || null);
  const usageStats = useAppStore((s) => s.usageStatsBySession[s.currentSessionId] || null);
  const quoteDraft = useAppStore((s) => s.quoteBySession[s.currentSessionId] || null);
  const setQuoteBySession = useAppStore((s) => s.setQuoteBySession);

  const isStreaming = activeRunSessionId === currentSessionId;
  const hasActiveRequest = activeRunSessionId !== null;
  const hasPendingRequest = hasActiveRequest || preparingRequestSessionId !== null;
  const activeRunSession = activeRunSessionId
    ? sessions.find((session) => session.id === activeRunSessionId) || null
    : null;
  const activeRunRuntime = useAppStore((s) => (
    s.activeRunSessionId ? s.runtimeBySession[s.activeRunSessionId] || null : null
  ));
  const currentMode = currentSession.sessionConfig.mode || "chat";
  const searchMode = currentSession.sessionConfig.searchMode || "auto";
  const webSearchAvailable = config.tools_enabled.includes("web_search");
  const effectiveSearchMode = webSearchAvailable ? searchMode : "off";
  const currentThinkingLevel = resolvedCurrentConfig.thinking_level;
  const pendingApprovalHasInlineAction = currentSession.messages.some(
    (message) => messageHasPendingApproval(message, pendingApprovals),
  );
  const profileEntries = sortProfileEntries(Object.entries(config.profiles), lang);
  const configuredModelIds = new Set(profileEntries.map(([, profile]) => profile.default_model));
  const otherModels = sortModels(
    modelsForCurrentConfig.filter((model) => !configuredModelIds.has(model.id)),
    lang,
  );

  const [dragOver, setDragOver] = useState(false);

  // Keep the input textarea height in sync with its content. This auto-shrinks
  // the box back after sending (prompt → "") and after programmatic sets.
  useLayoutEffect(() => {
    const el = chatTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt]);

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

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
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
        notify(t("ui.another-session-is-running-view", lang), "info");
      } else if (isAttachmentLoading) {
        notify(t("ui.wait-for-attachments-to-finish-2", lang), "info");
      } else {
        handleSendMessage();
      }
    }
  };

  const thinkingLevelLabel = (level: NonNullable<SessionConfig["thinkingLevel"]>) =>
    t(`session.thinking${level.charAt(0).toUpperCase() + level.slice(1)}`, lang);

  // The cycle passes through "inherit" so the quick button can never strand a
  // session on a permanent override (the old cycle skipped null entirely).
  const cycleThinkingLevel = () => {
    const cycle: SessionConfig["thinkingLevel"][] = [null, ...THINKING_LEVELS];
    const index = cycle.indexOf(currentSession.sessionConfig.thinkingLevel);
    patchSessionConfig({ thinkingLevel: cycle[(index + 1) % cycle.length] });
  };

  return (
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
            {t(activeRunRuntime?.status === "stopping" ? "ui.run-status-stopping" : "ui.run-status-running", lang, { title: activeRunSession.title || t("session.untitled", lang) })}
          </span>
        </button>
      )}
      {preparingRequestSessionId !== null && !hasActiveRequest && (
        <div className="attachment-loading-status" role="status">
          <Loader2 size={13} className="spin" />
          {t("ui.validating-and-preparing-request", lang)}
        </div>
      )}
      {isAttachmentLoading && (
        <div className="attachment-loading-status" role="status">
          <Loader2 size={13} className="spin" />
          {t("ui.parsing-attachments", lang)}
        </div>
      )}
      {pendingApprovals && (
        <div className={`approval-dock ${pendingApprovalHasInlineAction ? "has-inline" : ""}`}>
          <ApprovalCard lang={lang} config={config} setConfig={setConfig} className="approval-card-dock" />
        </div>
      )}
      {quoteDraft && (
        <div className="quote-chip" role="note">
          <Quote size={12} className="quote-chip-icon" aria-hidden="true" />
          <span className="quote-chip-text">{quoteDraft.excerpt}</span>
          <button
            type="button"
            className="quote-chip-dismiss"
            aria-label={t("quote.dismiss", lang)}
            onClick={() => setQuoteBySession((previous) => ({ ...previous, [currentSessionId]: null }))}
          >
            <X size={10} />
          </button>
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
              <span className="attachment-name" title={att.warning || (att.truncated ? (t("ui.content-truncated", lang)) : att.path)}>
                {att.name}{att.warning ? " !" : att.truncated ? " …" : ""}
              </span>
              <button
                className="attachment-remove"
                disabled={!sessionStorageReady || isAttachmentLoading || preparingRequestSessionId !== null}
                aria-label={`${t("ui.remove-attachment", lang)}: ${att.name}`}
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
          placeholder={isStreaming && currentMode === "code" ? t("input.steering", lang) : `${t("input.placeholder", lang)} (Shift+Enter ${t("ui.newline", lang)})`}
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
              <span>{t("ui.role-presets", lang)}</span>
              <button className="role-presets-close" onClick={() => { setRolePresetsOpen(false); setCustomPresetForm(false); setEditingCustomPreset(null); }}>
                <X size={12} />
              </button>
            </div>
            {currentSession.sessionConfig.activeRolePresetId && (() => {
              const ap = allPresets.find(p => p.id === currentSession.sessionConfig.activeRolePresetId);
              return ap ? (
                <div className="role-active-indicator">
                  <span>{ap.emoji}</span>
                  <span>{lang === "zh" ? ap.nameZh : ap.name}</span>
                  <button className="role-active-clear" onClick={() => {
                    patchSessionConfig({ activeRolePresetId: null, systemPrompt: null, temperature: null });
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
                        patchSessionConfig({ systemPrompt: role.prompt, temperature: role.temperature, activeRolePresetId: role.id });
                        setRolePresetsOpen(false);
                        addLog(t("ui.applied-role", lang, { name: lang === "zh" ? role.nameZh : role.name }), "info");
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
                          patchSessionConfig({ systemPrompt: role.prompt, temperature: role.temperature, activeRolePresetId: role.id });
                          setRolePresetsOpen(false);
                          addLog(t("ui.applied-role", lang, { name: lang === "zh" ? role.nameZh : role.name }), "info");
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
                ? (t("ui.attachments-are-being-parsed", lang))
                : preparingRequestSessionId !== null
                  ? (t("ui.a-request-is-being-prepared", lang))
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
                  messages: [...s.messages, { id: newMessageId(), role: "context_divider" as const, content: "" }]
                } : s));
              }}
            >
              <Type size={12} />
            </button>
            <button
              className={`input-icon-btn ${effectiveSearchMode !== "off" ? "active" : ""}`}
              disabled={!webSearchAvailable}
              title={!webSearchAvailable ? (t("ui.enable-the-web-search-tool", lang)) : searchMode === "off" ? t("search.modeOff", lang) : searchMode === "auto" ? t("search.modeAuto", lang) : t("search.modeForce", lang)}
              onClick={() => {
                const next = searchMode === "off" ? "auto" : searchMode === "auto" ? "force" : "off";
                patchSessionConfig({ searchMode: next });
              }}
            >
              <Globe size={12} />
              {effectiveSearchMode !== "off" && <span className={`search-active-dot ${effectiveSearchMode === "force" ? "force" : ""}`} />}
            </button>
            {config.provider === "ollama" && searchMode !== "off" && (
              <span className="ollama-search-hint" title={t("ui.ollama-local-models-don-t", lang)}>
                !
              </span>
            )}
            </div>
          </div>
          <div className="chat-input-toolbar-right">
          <div className="input-run-group">
          <button
            type="button"
            className={`input-thinking-btn ${currentThinkingLevel} ${currentSession.sessionConfig.thinkingLevel !== null ? "overridden" : ""}`}
            onClick={cycleThinkingLevel}
            title={currentSession.sessionConfig.thinkingLevel !== null
              ? `${t("session.thinkingLevel", lang)}: ${thinkingLevelLabel(currentThinkingLevel)} (${t("ui.session-override", lang)})`
              : `${t("session.thinkingLevel", lang)}: ${t("ui.inherit-value", lang, { value: thinkingLevelLabel(currentThinkingLevel) })}`}
          >
            <Brain size={12} />
            <span>{thinkingLevelLabel(currentThinkingLevel)}</span>
            {currentSession.sessionConfig.thinkingLevel !== null && <span className="override-dot" aria-hidden="true" />}
          </button>
          <div style={{ position: "relative" }}>
            <button
              className={`input-model-btn ${currentSession.sessionConfig.model !== null || currentSession.sessionConfig.profileId !== null ? "overridden" : ""}`}
              onClick={() => {
                setRolePresetsOpen(false);
                setModelPickerOpen((open) => !open);
              }}
              title={currentSession.sessionConfig.model !== null || currentSession.sessionConfig.profileId !== null
                ? `${t("session.model", lang)}: ${getModelDisplayName(resolvedCurrentConfig.model)} (${t("ui.session-override", lang)})`
                : `${t("session.model", lang)}: ${t("ui.inherit-value", lang, { value: getModelDisplayName(resolvedCurrentConfig.model) })}`}
            >
              <span>{getModelDisplayName(resolvedCurrentConfig.model)}</span>
              {(currentSession.sessionConfig.model !== null || currentSession.sessionConfig.profileId !== null) && <span className="override-dot" aria-hidden="true" />}
              <ChevronDown size={9} />
            </button>
            {modelPickerOpen && (
              <div className="model-picker-dropdown">
                {profileEntries.map(([profileId, p]) => (
                  <button
                    key={profileId}
                    className={`model-picker-item ${currentSession.sessionConfig.profileId === profileId && currentSession.sessionConfig.model === null ? "active" : ""}`}
                    onClick={() => {
                      cacheModelDisplayName(p.default_model, p.name);
                      patchSessionConfig({ profileId, model: null });
                      setModelPickerOpen(false);
                    }}
                  >
                    {p.name}
                    <span className="model-picker-tag">{p.default_model}</span>
                  </button>
                ))}
                {otherModels.length > 0 && (
                  <>
                    <div className="model-picker-divider">{t("ui.other-models", lang)}</div>
                    {otherModels.map((m) => (
                      <button
                        key={m.id}
                        className={`model-picker-item ${currentSession.sessionConfig.model === m.id ? "active" : ""}`}
                        onClick={() => {
                          patchSessionConfig({ model: m.id });
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
                      patchSessionConfig({ profileId: null, model: null });
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
              ? (t("ui.stop-current-output", lang))
              : (t("ui.send-message", lang))}
            onClick={isStreaming ? handleStopStreaming : handleSendMessage}
            disabled={isStreaming
              ? currentRuntime?.status === "stopping"
              : !sessionStorageReady
                || isAttachmentLoading
                || preparingRequestSessionId !== null
                || (hasActiveRequest && activeRunSessionId !== currentSessionId)
                || (!prompt.trim() && !attachments.some(isSendableAttachment) && !quoteDraft)}
            title={isStreaming
              ? currentRuntime?.status === "stopping"
                ? (t("ui.stopping-3", lang))
                : (t("ui.stop-current-output", lang))
              : isAttachmentLoading
                ? (t("ui.wait-for-attachments-to-finish-3", lang))
                : preparingRequestSessionId !== null
                  ? (t("ui.preparing-request", lang))
                : hasActiveRequest
                  ? (t("ui.another-session-is-running", lang))
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
  );
}
