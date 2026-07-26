/**
 * Left sidebar: mode pills, session search + list with per-session context
 * menu (rename/pin/export/import/move/delete), tool stats entry, and the
 * global-connection profile card.
 *
 * Extracted verbatim from App.tsx; state stays in App and flows in
 * through props.
 */
import { useState, type RefObject } from "react";
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Download,
  MessageSquare,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { t } from "../../i18n";
import type { AppConfig, ChatSession, Message, SessionConfig } from "../../types";
import type { RolePreset } from "../../rolePresets";
import {
  createSession,
  newMessageId,
  normalizeMessage,
  normalizeSessionConfig,
  type SessionRuntime,
  type ToolStatsDialog,
} from "../../appDefaults";
import { getToolStats } from "../../utils/sessionHelpers";
import { PositionedContextMenu } from "../shared/PositionedContextMenu";
import { ConnectionStatus } from "../shared/ConnectionStatus";

type SidebarContextMenu = { sessionId: string; x: number; y: number } | null;

export interface SidebarProps {
  lang: string;
  config: AppConfig;
  sessions: ChatSession[];
  visibleSessions: ChatSession[];
  archivedSessions: ChatSession[];
  currentSessionId: string;
  tabbableSessionId: string | null;
  sidebarNav: SessionConfig["mode"];
  sidebarWidth: number;
  sessionSearch: string;
  setSessionSearch: React.Dispatch<React.SetStateAction<string>>;
  debouncedSearch: string;
  sessionStorageReady: boolean;
  historyListRef: RefObject<HTMLDivElement | null>;
  runtimeBySession: Record<string, SessionRuntime | null>;
  pendingApprovalsBySession: Record<string, unknown>;
  contextMenu: SidebarContextMenu;
  setContextMenu: React.Dispatch<React.SetStateAction<SidebarContextMenu>>;
  allPresets: RolePreset[];
  addLog: (text: string, type?: "info" | "success" | "error" | "cmd", showToast?: boolean, sessionId?: string) => void;
  getModelDisplayName: (modelId: string) => string;
  switchSidebarMode: (mode: SessionConfig["mode"]) => void;
  createNewSession: () => void;
  setCurrentSessionId: (id: string) => void;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  deleteSession: (id: string, e: React.MouseEvent) => void;
  setSessionArchived: (id: string, archived: boolean) => void;
  moveSessionInList: (sessionId: string, direction: "up" | "down") => void;
  setToolStatsDialog: React.Dispatch<React.SetStateAction<ToolStatsDialog | null>>;
  setSettingsTab: (tab: "model" | "chat" | "agent" | "search" | "data") => void;
  setSettingsOpen: (open: boolean) => void;
  setSessionSettingsOpen: (open: boolean) => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    lang, config, sessions, visibleSessions, archivedSessions, currentSessionId,
    tabbableSessionId, sidebarNav, sidebarWidth, sessionSearch,
    setSessionSearch, debouncedSearch, sessionStorageReady, historyListRef,
    runtimeBySession, pendingApprovalsBySession, contextMenu, setContextMenu,
    allPresets: ALL_PRESETS, addLog, getModelDisplayName, switchSidebarMode,
    createNewSession, setCurrentSessionId, setSessions, deleteSession,
    setSessionArchived, moveSessionInList, setToolStatsDialog, setSettingsTab,
    setSettingsOpen, setSessionSettingsOpen,
  } = props;

  const [archivedOpen, setArchivedOpen] = useState(false);

  return (
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
        placeholder={t("ui.search-sessions", lang)}
        value={sessionSearch}
        onChange={(e) => setSessionSearch(e.target.value)}
        aria-label={t("ui.search-sessions-2", lang)}
      />
      {sessionSearch && (
        <button
          className="session-search-clear"
          aria-label={t("ui.clear-session-search", lang)}
          onClick={() => setSessionSearch("")}
        >
          <X size={10} />
        </button>
      )}
    </div>
  </div>

  {/* Session List */}
  <div ref={historyListRef} className="history-list" aria-label={t("ui.conversation-list", lang)}>
    {(() => {
      const renderSessionRow = (s: ChatSession) => {
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
            <span className="truncate" style={{ fontSize: "var(--font-small)", display: "block" }}>
              {s.title || t("session.new", lang)}
            </span>
            <span className="history-meta">
              {s.messages.filter(m => m.role !== "context_divider").length}{t("ui.msgs", lang)}
              {runtime && <> · {runtime.status === "stopping" ? (t("ui.stopping-2", lang)) : (t("ui.running", lang))}</>}
              {awaitingApproval && <> · {t("ui.approval", lang)}</>}
              {s.messages.length > 0 && s.messages[s.messages.length - 1].timestamp && (
                <> · {new Date(s.messages[s.messages.length - 1].timestamp!).toLocaleTimeString(t("ui.en-us", lang), { hour: "2-digit", minute: "2-digit" })}</>
              )}
            </span>
          </div>
        </div>
        <span className="history-mode-tag" title={s.sessionConfig.mode === "code" ? t("mode.code", lang) : t("mode.chat", lang)}>
          {s.pinned ? <Pin size={10} /> : s.sessionConfig.mode === "code" ? <TerminalIcon size={10} /> : <MessageSquare size={10} />}
        </span>
      </div>
        );
      };

      return (
        <>
          {visibleSessions.map(renderSessionRow)}
          {visibleSessions.length === 0 && debouncedSearch.trim() && (
            <div className="search-empty-hint">
              {t("ui.no-matching-sessions", lang)}
            </div>
          )}
          {archivedSessions.length > 0 && (
            <div className="archived-section">
              <button
                type="button"
                className={`archived-section-toggle ${archivedOpen ? "open" : ""}`}
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
              >
                <Archive size={11} />
                <span>{t("ui.archived-count", lang, { count: String(archivedSessions.length) })}</span>
                <ChevronRight size={11} className="archived-section-chevron" aria-hidden="true" />
              </button>
              {archivedOpen && (
                <div className="archived-section-list">
                  {archivedSessions.map(renderSessionRow)}
                </div>
              )}
            </div>
          )}
        </>
      );
    })()}
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
            <button className="context-menu-item" onClick={() => {
              setSessionArchived(contextMenu.sessionId, !targetSession?.archived);
              setContextMenu(null);
            }}>
              {targetSession?.archived
                ? <><ArchiveRestore size={12} /> {t("context.unarchive", lang)}</>
                : <><Archive size={12} /> {t("context.archive", lang)}</>}
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
                      const importedMessages = imported.messages
                        .map(normalizeMessage)
                        .filter((message: Message | null): message is Message => Boolean(message));
                      const importedSession = createSession(
                        normalizeSessionConfig(imported.sessionConfig).mode,
                        imported.title || input.files![0].name,
                        importedMessages,
                      );
                      importedSession.sessionConfig = normalizeSessionConfig(imported.sessionConfig);
                      setSessions(prev => [...prev, importedSession]);
                      setCurrentSessionId(importedSession.id);
                    }
                  } else {
                    const sections = text.split(/\n\n---\n\n/);
                    const msgs: Message[] = [];
                    for (const section of sections) {
                      const lines = section.trim();
                      if (lines.startsWith("## User")) {
                        msgs.push({ id: newMessageId(), role: "user", content: lines.replace(/^## User\n\n/, ""), timestamp: Date.now() });
                      } else if (lines.startsWith("## Assistant")) {
                        msgs.push({ id: newMessageId(), role: "assistant", content: lines.replace(/^## Assistant\n\n/, ""), timestamp: Date.now() });
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
                  addLog(`${t("ui.import-failed", lang)}: ${e}`, "error");
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
              const newTitle = window.prompt(t("ui.rename-session", lang), s.title);
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
      title={t("ui.manage-agent-and-tools", lang)}
    >
      <span className="sidebar-tools-summary-icon"><Zap size={13} /></span>
      <span>{t("ui.enabled-tools", lang)}</span>
      <strong>{config.tools_enabled.length}</strong>
      <ChevronRight size={12} aria-hidden="true" />
    </button>
    {/* Profile Card */}
    {/* Shows the GLOBAL default connection (what settings edits), never the
        per-session override — that lives on the composer's model button. */}
    <div className="sidebar-profile-card" title={t("ui.global-default-model", lang)}>
      <div className="sidebar-profile-avatar">
        {config.model ? getModelDisplayName(config.model).charAt(0).toUpperCase() : "G"}
      </div>
      <div className="sidebar-profile-info">
        <span className="sidebar-profile-name">{getModelDisplayName(config.model) || "gxAgent"}</span>
        <span className="sidebar-profile-meta">
          {config.base_url.replace(/^https?:\/\//, "").split("/")[0]}
        </span>
      </div>
      <ConnectionStatus
        compact
        state={config.base_url && config.model && (config.provider === "ollama" || Boolean(config.api_key)) ? "configured" : "unconfigured"}
        label={t("ui.model-configuration", lang)}
        detail={config.base_url
          ? `${t("ui.configured", lang)}: ${config.base_url}`
          : (t("ui.not-configured", lang))}
        onClick={() => { setSettingsTab("model"); setSettingsOpen(true); }}
      />
      <button className="panel-toggle-btn" onClick={() => setSettingsOpen(true)} title={t("settings.title", lang)}>
        <Settings size={13} />
      </button>
    </div>
  </div>
</aside>
  );
}
