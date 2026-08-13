/**
 * Chat message list: renders the conversation as either a plain list (short
 * sessions, keeps native Ctrl+F) or a virtualized list (long sessions), plus
 * the empty-session welcome screen and the "new messages" jump button.
 *
 * Extracted verbatim from App.tsx. Session/runtime/approval state comes from
 * the zustand store; App-local editing state and handlers flow in as props.
 * Scroll anchoring (virtuosoRef / isAtBottom) lives here because nothing else
 * in App reads it.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  ArrowDown,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  GitBranch,
  Loader2,
  Pencil,
  Quote,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import CaturtleLogo from "../../assets/logo.png";
import { t } from "../../i18n";
import type { AppConfig, Attachment, ChatSession, Message, ModelInfo, ToolAction } from "../../types";
import {
  CHAT_VIRTUOSO_COMPONENTS,
  LANGUAGE_OPTIONS,
  ThinkingBubble,
  estimateTextTokens,
  modelContextLimitForConfig,
} from "../../appDefaults";
import { MarkdownContent } from "../markdown/MarkdownContent";
import { TaskProgress } from "../shared/TaskProgress";
import { ToolResult } from "./ToolResult";
import { ApprovalCard, messageHasPendingApproval } from "./ApprovalCard";
import { quoteExcerpt, splitLeadingQuote } from "../../utils/quote";
import { useAppStore } from "../../store/appStore";
import { runtime } from "../../services/agentRuntime";

export interface ChatMessageListProps {
  lang: string;
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  currentSession: ChatSession;
  sessionMutationLocked: boolean;
  editingMessageIdx: number | null;
  setEditingMessageIdx: (value: number | null) => void;
  editText: string;
  setEditText: (value: string) => void;
  expandedActions: Record<string, boolean>;
  toggleActionExpanded: (id: string) => void;
  statusLabel: (status: ToolAction["status"]) => string;
  formatTokenCount: (value: number) => string;
  getModelDisplayName: (modelId: string) => string;
  handleRetry: (msgIdx: number) => Promise<void>;
  handleEditBranch: (msgIdx: number) => Promise<void>;
  handleBranchFromMessage: (msgIdx: number) => void;
  attachments: Attachment[];
  resolvedCurrentConfig: AppConfig;
  models: ModelInfo[];
  modelCatalogSourceKey: string | null;
  setPrompt: (next: string | ((previous: string) => string)) => void;
  chatTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function ChatMessageList({
  lang,
  config,
  setConfig,
  currentSession,
  sessionMutationLocked,
  editingMessageIdx,
  setEditingMessageIdx,
  editText,
  setEditText,
  expandedActions,
  toggleActionExpanded,
  statusLabel,
  formatTokenCount,
  getModelDisplayName,
  handleRetry,
  handleEditBranch,
  handleBranchFromMessage,
  attachments,
  resolvedCurrentConfig,
  models,
  modelCatalogSourceKey,
  setPrompt,
  chatTextareaRef,
}: ChatMessageListProps) {
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setSessions = useAppStore((s) => s.setSessions);
  const setQuoteBySession = useAppStore((s) => s.setQuoteBySession);
  const activeRunSessionId = useAppStore((s) => s.activeRunSessionId);
  const currentRuntime = useAppStore((s) => s.runtimeBySession[s.currentSessionId] || null);
  const pendingApprovals = useAppStore((s) => s.pendingApprovalsBySession[s.currentSessionId] || null);
  const isStreaming = activeRunSessionId === currentSessionId;
  const activeAssistantMessageId = isStreaming && runtime.activeRequestSessionId === currentSessionId
    ? runtime.assistantMessageIdByRequest[runtime.activeRequestId]
    : undefined;
  const isStreamingMessage = (message: Message, index: number) => (
    isStreaming
    && message.role === "assistant"
    && (activeAssistantMessageId ? message.id === activeAssistantMessageId : index === currentSession.messages.length - 1)
  );

  const chatEndRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

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
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, [currentSessionId]);

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

  const formatDuration = (ms?: number) => {
    if (ms == null) return "";
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
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

  /** Set the per-session quote draft from a message. Quotes the user's text
   *  selection when it lives inside this message's bubble; otherwise the
   *  first ~200 chars of the message content. */
  const handleQuote = (msg: Message, event: React.MouseEvent<HTMLButtonElement>) => {
    const container = event.currentTarget.closest(".chat-bubble-container");
    const selection = window.getSelection();
    const selectionText = selection && !selection.isCollapsed
      && container && selection.anchorNode && container.contains(selection.anchorNode)
      ? selection.toString()
      : "";
    const content = msg.variants ? (msg.variants[msg.currentVariantIndex || 0] || msg.content) : msg.content;
    const excerpt = quoteExcerpt(content, selectionText);
    if (!excerpt) return;
    setQuoteBySession((previous) => ({
      ...previous,
      [currentSessionId]: { messageId: msg.id ?? "", excerpt },
    }));
    requestAnimationFrame(() => chatTextareaRef.current?.focus());
  };

  const currentLocale = LANGUAGE_OPTIONS.find((l) => l.code === lang)?.locale || "en-US";
  const activeModelId = resolvedCurrentConfig.model;
  const currentInputAttachmentTokens = attachments.reduce((sum, att) => {
    if (att.type === "image" && att.data) return sum + 1100;
    return sum + estimateTextTokens(att.data || "");
  }, 0);
  // Context token count shown in each message's meta line. Deliberately EXCLUDES
  // the live `prompt` so the message list can be memoized without depending on
  // every keystroke — the counter is an approximation and this meta line is
  // hidden by default (show_advanced_reply_info). The live input's contribution
  // is added back where a keystroke-accurate figure is actually needed.
  // Memoized: walking the entire history with regex-based estimation on every
  // render is measurable during streaming (a render per frame).
  const currentContextTokensBase = useMemo(() =>
    estimateTextTokens(resolvedCurrentConfig.system_prompt) +
    (resolvedCurrentConfig.role_prompt ? estimateTextTokens(resolvedCurrentConfig.role_prompt) + 24 : 0) +
    estimateMessagesTokens(currentSession.messages) +
    currentInputAttachmentTokens,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [resolvedCurrentConfig.system_prompt, resolvedCurrentConfig.role_prompt, currentSession.messages, currentInputAttachmentTokens]);
  const currentModelLimit = modelContextLimitForConfig(
    activeModelId,
    models,
    modelCatalogSourceKey,
    resolvedCurrentConfig,
  );

  // Render a single message row. Kept as a closure (not a separate component)
  // so all the surrounding handlers/state stay in scope with zero prop
  // threading — this same function feeds both the plain list (short sessions)
  // and the virtualized list (long sessions).
  const renderMessage = (msg: Message, mIdx: number) => (
    msg.role === "context_divider" ? (
      <div key={msg.id ?? mIdx} className="context-divider">
        <div className="context-divider-line" />
        <span className="context-divider-label">{
          currentSession.contextSummary?.dividerId === msg.id
            ? (t("ui.compacted-to-summary-model-sees", lang))
            : (t("ui.context-ignored-above", lang))
        }</span>
        <div className="context-divider-line" />
        <button
          className="context-divider-remove"
          disabled={sessionMutationLocked}
          aria-label={t("ui.remove-context-divider", lang)}
          onClick={() => {
            setSessions(prev => prev.map(s => s.id === currentSessionId ? {
              ...s,
              messages: s.messages.filter((_, i) => i !== mIdx),
              // Removing the summary's own boundary discards the summary too:
              // the full history becomes visible to the model again.
              ...(s.contextSummary?.dividerId === msg.id ? { contextSummary: undefined } : {}),
            } : s));
          }}
        >
          <X size={10} />
        </button>
      </div>
    ) : (
    <div
      key={msg.id ?? mIdx}
       className={`chat-bubble-container ${msg.role} ${isStreamingMessage(msg, mIdx) ? "is-streaming" : ""}`}
       aria-busy={isStreamingMessage(msg, mIdx) ? true : undefined}
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
              {t("ui.create-branch", lang)}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditingMessageIdx(null)}>{t("ui.cancel", lang)}</button>
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
                {isStreamingMessage(msg, mIdx) && !msg.content && (
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
                {msg.actions && msg.actions.length > 0 && <div className="agent-action-timeline">
                <div className="agent-action-timeline-label">{t("ui.tool-activity-count", lang, { count: String(msg.actions.length) })}</div>
                {msg.actions.map((act, aIdx) => (
                  <Fragment key={`${act.id}-${aIdx}`}>
                    {act.name === "todo_write" && (
                      <TaskProgress
                        argumentsJson={act.arguments}
                        title={t("ui.task-progress", lang)}
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
                        <div style={{ fontSize: "var(--font-caption)", color: "var(--accent)", fontWeight: 700, marginBottom: 3 }}>
                          {t("action.arguments", lang)}:
                        </div>
                        <pre className="tool-arguments">
                          <code>{act.arguments}</code>
                        </pre>
                        {act.output && (
                          <>
                            <div style={{ fontSize: "var(--font-caption)", color: "var(--success)", fontWeight: 700, marginTop: 6, marginBottom: 3 }}>
                              {t("action.output", lang)}:
                            </div>
                            <ToolResult action={act} />
                          </>
                        )}
                      </div>
                    )}
                    </div>
                  </Fragment>
                ))}
                </div>}

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
                                {ss.resultCount ?? sources.length} {t("ui.results", lang)}
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
                  {isStreamingMessage(msg, mIdx) && (
                    <span className="typing-cursor" />
                  )}
                </div>

                {/* Inline approval card */}
                {pendingApprovals &&
                  msg.actions?.some((a) =>
                    pendingApprovals.tool_calls.some((tc) => tc.id === a.id)
                  ) && <ApprovalCard lang={lang} config={config} setConfig={setConfig} />}
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
                          <span title={att.warning || (att.truncated ? (t("ui.content-truncated", lang)) : att.path)}>
                            {att.name}{att.warning ? " !" : att.truncated ? " …" : ""}
                          </span>
                        </div>
                      )
                    ))}
                  </div>
                )}
                {msg.content && (() => {
                  // User bubbles are plain text, so a quote-reply prefix
                  // (markdown blockquote) is split off and styled as a quote
                  // instead of showing raw "> " markers.
                  const { quote, rest } = splitLeadingQuote(msg.content);
                  return (
                    <>
                      {quote !== null && <blockquote className="user-message-quote">{quote}</blockquote>}
                      {rest && <div className="user-message-text">{rest}</div>}
                    </>
                  );
                })()}
              </>
            )}
          </div>
          {isStreamingMessage(msg, mIdx) ? (
            <div
              className={`message-footer streaming-answer-status ${messageHasPendingApproval(msg, pendingApprovals) ? "awaiting-approval" : currentRuntime?.status === "stopping" ? "stopping" : ""}`}
              role="status"
              aria-live="polite"
            >
              {messageHasPendingApproval(msg, pendingApprovals) ? (
                <><ShieldAlert size={11} /> <span>{t("ui.awaiting-approval", lang)}</span></>
              ) : currentRuntime?.status === "stopping" ? (
                <><Loader2 size={11} className="animate-spin" /> <span>{t("ui.stopping", lang)}</span></>
              ) : (
                <>
                  <span>{t("ui.answering", lang)}</span>
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
                      <span>{getModelDisplayName(msg.model || runtime.activeRequestModel || currentSession.sessionConfig.model || config.model)}</span>
                      <span className="bubble-meta-sep">·</span>
                      <span>{t("usage.prompt", lang)} {formatTokenCount(msg.usage?.promptTokens || msg.contextTokens || 0)} / {t("usage.completion", lang)} {formatTokenCount(msg.usage?.completionTokens || estimateTextTokens(msg.content))}</span>
                      <span className="bubble-meta-sep">·</span>
                      <span>{t("usage.context", lang)} {formatTokenCount(currentContextTokensBase)} / {formatTokenCount(currentModelLimit)}</span>
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
                title={t("msg.quote", lang)}
                onClick={(event) => handleQuote(msg, event)}
              >
                <Quote size={12} />
              </button>
              <button
                className="bubble-action-btn"
                title={t("ui.branch-from-message", lang)}
                disabled={sessionMutationLocked}
                onClick={() => handleBranchFromMessage(mIdx)}
              >
                <GitBranch size={12} />
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

  return (
    <div className="chat-messages-outer">
      {currentSession.messages.length === 0 ? (
        <div className="chat-messages" ref={chatContainerRef}
          style={currentSession.sessionConfig.backgroundImage ? { backgroundImage: `url(${currentSession.sessionConfig.backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
          <div className="preview-placeholder">
            <div className="welcome-icon" style={{ display: "flex", justifyContent: "center" }}>
              <img src={CaturtleLogo} alt="gxAgent" width="80" height="80" style={{ opacity: 0.95 }} />
            </div>
            <h2 className="welcome-title">{t("welcome.title", lang)}</h2>
            <p className="welcome-desc">{t("welcome.desc", lang)}</p>
            <div className="welcome-prompts">
              {["welcome.prompt1", "welcome.prompt2", "welcome.prompt3", "welcome.prompt4"].map((key) => {
                const text = t(key, lang);
                return (
                  <button type="button" className="welcome-prompt" key={key} onClick={() => {
                    setPrompt(text);
                    requestAnimationFrame(() => chatTextareaRef.current?.focus());
                  }}>
                    {text}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : useVirtualized ? (
        <Virtuoso
          ref={virtuosoRef}
          className="chat-messages chat-messages-virtual"
          style={currentSession.sessionConfig.backgroundImage ? { backgroundImage: `url(${currentSession.sessionConfig.backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
          data={currentSession.messages}
          followOutput={(atBottom: boolean) => (atBottom ? "auto" : false)}
          atBottomStateChange={(atBottom: boolean) => {
            isAtBottomRef.current = atBottom;
            setIsAtBottom(atBottom);
          }}
          itemContent={(mIdx: number, msg: Message) => renderMessage(msg, mIdx)}
          computeItemKey={(_mIdx: number, msg: Message) => msg.id ?? _mIdx}
          context={{
            showThinking: isStreaming &&
              currentSession.messages[currentSession.messages.length - 1]?.role !== "assistant",
            lang,
          }}
          components={CHAT_VIRTUOSO_COMPONENTS}
        />
      ) : (
        <div className="chat-messages" ref={chatContainerRef} onScroll={() => {
          const el = chatContainerRef.current;
          if (!el) return;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          isAtBottomRef.current = atBottom;
          setIsAtBottom(atBottom);
        }} style={currentSession.sessionConfig.backgroundImage ? { backgroundImage: `url(${currentSession.sessionConfig.backgroundImage})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
          {plainMessageRows}

          {isStreaming &&
            currentSession.messages[currentSession.messages.length - 1]?.role !== "assistant" && (
              <ThinkingBubble lang={lang} />
            )}

          <div ref={chatEndRef} />
        </div>
      )}
      {currentSession.messages.length > 0 && !isAtBottom && (
        <button type="button" className="new-message-button" onClick={() => {
          isAtBottomRef.current = true;
          setIsAtBottom(true);
          if (virtuosoRef.current) {
            virtuosoRef.current.scrollToIndex({
              index: currentSession.messages.length - 1,
              align: "end",
              behavior: "smooth",
            });
          } else {
            chatContainerRef.current?.scrollTo({ top: chatContainerRef.current.scrollHeight, behavior: "smooth" });
          }
        }}>
          <ArrowDown size={14} />
          <span>{t("ui.new-messages", lang)}</span>
        </button>
      )}
    </div>
  );
}
