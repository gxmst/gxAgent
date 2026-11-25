/**
 * Left sidebar: primary action button, quick skill/tool links, session search,
 * grouped project/chat list with compact single-line rows, context menu,
 * and minimal Settings footer.
 */
import { useState, type RefObject } from "react";
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import { t } from "../../i18n";
import { DropdownMenu } from "radix-ui";
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
import type { SearchSnippet } from "../../utils/sessionSearch";
import { PositionedContextMenu } from "../shared/PositionedContextMenu";
import { ConnectionStatus } from "../shared/ConnectionStatus";
import { formatCompactRelativeTime, groupProjectSessions, taskState, taskStateLabel } from "../../utils/workbench";
import type { SettingsTab } from "../settings/settingsNavigation";

type SidebarContextMenu = { sessionId: string; x: number; y: number } | null;

export interface SidebarProps {
  lang: string;
  config: AppConfig;
  sessions: ChatSession[];
  visibleSessions: ChatSession[];
  archivedSessions: ChatSession[];
  /** Per-session snippet around the first full-text hit while a search query
   *  is active; null means the title matched (no snippet needed). */
  searchSnippets: Record<string, SearchSnippet | null>;
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
  createNewSession: () => void;
  createProjectTask: (workDir: string) => void;
  setCurrentSessionId: (id: string) => void;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  deleteSession: (id: string, e: React.MouseEvent) => void;
  setSessionArchived: (id: string, archived: boolean) => void;
  moveSessionInList: (sessionId: string, direction: "up" | "down") => void;
  setToolStatsDialog: React.Dispatch<React.SetStateAction<ToolStatsDialog | null>>;
  setSettingsTab: (tab: SettingsTab) => void;
  setSettingsOpen: (open: boolean) => void;
  setSessionSettingsOpen: (open: boolean) => void;
}

export function Sidebar(props: SidebarProps) {
  const {
    lang, config, sessions, visibleSessions, archivedSessions, searchSnippets,
    currentSessionId, tabbableSessionId, sidebarNav, sidebarWidth, sessionSearch,
    setSessionSearch, debouncedSearch, sessionStorageReady, historyListRef,
    runtimeBySession, pendingApprovalsBySession, contextMenu, setContextMenu,
    allPresets: ALL_PRESETS, addLog, getModelDisplayName,
    createNewSession, createProjectTask, setCurrentSessionId, setSessions, deleteSession,
    setSessionArchived, moveSessionInList, setToolStatsDialog, setSettingsTab,
    setSettingsOpen, setSessionSettingsOpen,
  } = props;
  const zh = lang === "zh";

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const projects = groupProjectSessions(visibleSessions.filter((session) => session.sessionConfig.mode === "code"), config.default_work_dir);
  const chats = visibleSessions.filter((session) => session.sessionConfig.mode !== "code");
  const archivedTabbableSessionId = archivedOpen
    ? archivedSessions.find((session) => session.id === currentSessionId)?.id
      ?? archivedSessions[0]?.id
      ?? null
    : null;
  const isConnectionConfigured = Boolean(
    config.base_url && config.model && (config.provider === "ollama" || Boolean(config.api_key)),
  );

  return (
    <aside className="sidebar" style={{ width: sidebarWidth }}>
      <nav className="sidebar-shortcuts" aria-label={zh ? "工作入口" : "Workspace actions"}>
        <button
          type="button"
          className="sidebar-new-btn"
          disabled={!sessionStorageReady}
          onClick={createNewSession}
        >
          <Plus size={16} />
          <span>{sidebarNav === "code" ? (zh ? "新建任务" : "New task") : t("session.new", lang)}</span>
        </button>
        <div className="sidebar-nav-links">
          <button
            type="button"
            className="sidebar-nav-link"
            onClick={() => { setSettingsTab("skills"); setSettingsOpen(true); }}
          >
            <Sparkles size={14} />
            <span>{zh ? "技能与知识库" : "Skills & Knowledge"}</span>
          </button>
          <button
            type="button"
            className="sidebar-nav-link"
            onClick={() => { setSettingsTab("tools"); setSettingsOpen(true); }}
          >
            <Wrench size={14} />
            <span>{zh ? "工具与 MCP" : "Tools & MCP"}</span>
            <small>{config.tools_enabled.length}</small>
          </button>
        </div>
      </nav>

      {/* Session Search */}
      <div className="sidebar-search-wrap">
        <div className="session-search-box">
          <Search size={13} className="session-search-icon" />
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
              type="button"
              className="session-search-clear"
              aria-label={t("ui.clear-session-search", lang)}
              onClick={() => setSessionSearch("")}
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Session List */}
      <div ref={historyListRef} className="history-list" aria-label={t("ui.conversation-list", lang)}>
        {(() => {
          const renderSessionRow = (s: ChatSession, group: "visible" | "archived") => {
            const activePreset = ALL_PRESETS.find((p) => p.id === s.sessionConfig.activeRolePresetId);
            const runtime = runtimeBySession[s.id];
            const awaitingApproval = Boolean(pendingApprovalsBySession[s.id]);
            const searchActive = Boolean(debouncedSearch.trim());
            const snippet = searchActive ? searchSnippets[s.id] : null;
            const groupTabbableSessionId = group === "archived"
              ? archivedTabbableSessionId
              : tabbableSessionId;
            const lastTimestamp = s.messages[s.messages.length - 1]?.timestamp || s.updatedAt;
            const compactTime = formatCompactRelativeTime(lastTimestamp, lang);
            const state = taskState(s, runtime, awaitingApproval);
            const openSession = () => {
              setCurrentSessionId(s.id);
            };
            return (
              <div
                key={s.id}
                className={`history-item ${s.id === currentSessionId ? "active" : ""} ${s.pinned ? "pinned" : ""}`}
                role="button"
                data-session-id={s.id}
                tabIndex={s.id === groupTabbableSessionId ? 0 : -1}
                aria-current={s.id === currentSessionId ? "true" : undefined}
                title={`${s.title || t("session.new", lang)} · ${taskStateLabel(state, lang)}`}
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
                <div className="history-item-main">
                  {runtime ? (
                    <span className="history-status-dot running" aria-hidden="true" />
                  ) : awaitingApproval ? (
                    <span className="history-status-dot approval" aria-hidden="true" />
                  ) : s.pinned ? (
                    <Pin size={11} className="history-pin-icon" aria-hidden="true" />
                  ) : activePreset && s.sessionConfig.mode === "chat" ? (
                    <span className="history-preset-icon" title={`${t("role.activePreset", lang)}: ${zh ? activePreset.nameZh : activePreset.name}`}>
                      {activePreset.emoji}
                    </span>
                  ) : null}
                  <div className="history-item-text">
                    <span className="history-title-row">
                      <span className="truncate">{s.title || t("session.new", lang)}</span>
                      {searchActive && s.archived && (
                        <span className="history-archived-tag">{t("ui.archived-tag", lang)}</span>
                      )}
                    </span>
                    {snippet && (
                      <span className="history-search-snippet">
                        {snippet.before}<mark>{snippet.hit}</mark>{snippet.after}
                      </span>
                    )}
                  </div>
                </div>
                <div className="history-item-trail">
                  {compactTime && <span className="history-time">{compactTime}</span>}
                  <button
                    type="button"
                    className="history-more"
                    aria-label={zh ? `任务选项：${s.title || "未命名"}` : `Options: ${s.title || "Untitled"}`}
                    title={zh ? "更多选项" : "More options"}
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setContextMenu({ sessionId: s.id, x: rect.right, y: rect.bottom });
                    }}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
              </div>
            );
          };

          return (
            <>
              <div className="sidebar-section-heading">
                <span>{zh ? "项目" : "Projects"}</span>
                <button
                  type="button"
                  className="panel-toggle-btn"
                  disabled={!sessionStorageReady}
                  onClick={() => createProjectTask("")}
                  title={zh ? "打开项目" : "Open project"}
                  aria-label={zh ? "打开项目" : "Open project"}
                >
                  <FolderPlus size={14} />
                </button>
              </div>
              {projects.map((project) => {
                const expanded = Boolean(debouncedSearch.trim()) || !collapsedProjects.has(project.id);
                return (
                  <section className="project-group" key={project.id}>
                    <div className="project-heading">
                      <button
                        type="button"
                        className="project-toggle"
                        aria-expanded={expanded}
                        title={project.workDir}
                        onClick={() => setCollapsedProjects((previous) => {
                          const next = new Set(previous);
                          if (next.has(project.id)) next.delete(project.id);
                          else next.add(project.id);
                          return next;
                        })}
                      >
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        <FolderOpen size={14} />
                        <span>{project.name || (zh ? "未关联项目" : "No project")}</span>
                      </button>
                      <button
                        type="button"
                        className="panel-toggle-btn project-add-btn"
                        disabled={!sessionStorageReady}
                        title={zh ? "新建任务" : "New task"}
                        aria-label={zh ? `在 ${project.name || "项目"} 中新建任务` : `New task in ${project.name || "project"}`}
                        onClick={() => createProjectTask(project.workDir)}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    {expanded && (
                      <div className="project-tasks">
                        {project.sessions.map((session) => renderSessionRow(session, "visible"))}
                      </div>
                    )}
                  </section>
                );
              })}
              {chats.length > 0 && (
                <>
                  <div className="sidebar-section-heading">
                    <span>{zh ? "聊天" : "Chats"}</span>
                  </div>
                  <div className="chat-history-list">
                    {chats.map((session) => renderSessionRow(session, "visible"))}
                  </div>
                </>
              )}
              {visibleSessions.length === 0 && !debouncedSearch.trim() && (
                <div className="search-empty-hint">{zh ? "暂无会话" : "No conversations"}</div>
              )}
              {visibleSessions.length === 0 && debouncedSearch.trim() && (
                <div className="search-empty-hint">
                  <Search size={16} aria-hidden="true" />
                  <span>{t("ui.no-matching-sessions", lang)}</span>
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
                      {archivedSessions.map((session) => renderSessionRow(session, "archived"))}
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
          onClose={() => setContextMenu(null)}
        >
          {(() => {
            const targetSession = sessions.find((s) => s.id === contextMenu.sessionId);
            const hasPreset = targetSession?.sessionConfig.activeRolePresetId;
            return (
              <>
                <DropdownMenu.Item asChild>
                  <button className="context-menu-item" onClick={() => {
                    setSessionSettingsOpen(true);
                    setCurrentSessionId(contextMenu.sessionId);
                    setContextMenu(null);
                  }}>
                    <Pencil size={12} /> {t("context.editPreset", lang)}
                  </button>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <button className="context-menu-item" onClick={() => {
                    setSessions((prev) => prev.map((s) => (s.id === contextMenu.sessionId ? {
                      ...s,
                      pinned: !s.pinned,
                    } : s)));
                    setContextMenu(null);
                  }}>
                    <Pin size={12} /> {targetSession?.pinned ? t("context.unpin", lang) : t("context.pin", lang)}
                  </button>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <button className="context-menu-item" onClick={() => {
                    setSessionArchived(contextMenu.sessionId, !targetSession?.archived);
                    setContextMenu(null);
                  }}>
                    {targetSession?.archived
                      ? <><ArchiveRestore size={12} /> {t("context.unarchive", lang)}</>
                      : <><Archive size={12} /> {t("context.archive", lang)}</>}
                  </button>
                </DropdownMenu.Item>
                {hasPreset && (
                  <DropdownMenu.Item asChild>
                    <button className="context-menu-item" onClick={() => {
                      setSessions((prev) => prev.map((s) => (s.id === contextMenu.sessionId ? {
                        ...s,
                        sessionConfig: { ...s.sessionConfig, activeRolePresetId: null, systemPrompt: null, temperature: null },
                        updatedAt: Date.now(),
                      } : s)));
                      setContextMenu(null);
                    }}>
                      <X size={12} /> {t("context.clearPreset", lang)}
                    </button>
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item asChild>
                  <button className="context-menu-item" onClick={() => {
                    const s = sessions.find((item) => item.id === contextMenu.sessionId);
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
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <button className="context-menu-item" onClick={() => {
                    const s = sessions.find((item) => item.id === contextMenu.sessionId);
                    if (!s) return;
                    setToolStatsDialog({
                      title: s.title || t("session.untitled", lang),
                      stats: getToolStats([s]),
                    });
                    setContextMenu(null);
                  }}>
                    <BarChart3 size={12} /> {t("context.toolStats", lang)}
                  </button>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="context-menu-divider" />
                <DropdownMenu.Item asChild>
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
                            setSessions((prev) => [...prev, importedSession]);
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
                            setSessions((prev) => [...prev, importedSession]);
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
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <button className="context-menu-item" onClick={() => {
                    const s = sessions.find((item) => item.id === contextMenu.sessionId);
                    if (!s) return;
                    const newTitle = window.prompt(t("ui.rename-session", lang), s.title);
                    if (newTitle !== null && newTitle.trim()) {
                      setSessions((prev) => prev.map((sess) => (sess.id === contextMenu.sessionId ? { ...sess, title: newTitle.trim() } : sess)));
                    }
                    setContextMenu(null);
                  }}>
                    <Pencil size={12} /> {t("context.rename", lang)}
                  </button>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <button className="context-menu-item" onClick={() => {
                    moveSessionInList(contextMenu.sessionId, "up");
                    setContextMenu(null);
                  }}>
                    <ChevronLeft size={12} style={{ transform: "rotate(90deg)" }} /> {t("context.moveUp", lang)}
                  </button>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <button className="context-menu-item" onClick={() => {
                    moveSessionInList(contextMenu.sessionId, "down");
                    setContextMenu(null);
                  }}>
                    <ChevronRight size={12} style={{ transform: "rotate(90deg)" }} /> {t("context.moveDown", lang)}
                  </button>
                </DropdownMenu.Item>
                {sessions.length > 1 && (
                  <DropdownMenu.Item asChild>
                    <button className="context-menu-item context-menu-item-danger" onClick={() => {
                      void deleteSession(contextMenu.sessionId, { stopPropagation: () => {} } as React.MouseEvent);
                      setContextMenu(null);
                    }}>
                      <Trash2 size={12} /> {t("context.delete", lang)}
                    </button>
                  </DropdownMenu.Item>
                )}
              </>
            );
          })()}
        </PositionedContextMenu>
      )}

      {/* Minimal Sidebar Footer */}
      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-settings-btn"
          onClick={() => { setSettingsTab("model"); setSettingsOpen(true); }}
          aria-label={zh ? "设置" : "Settings"}
          title={zh ? "设置" : "Settings"}
        >
          <Settings size={15} />
          <span>{zh ? "设置" : "Settings"}</span>
        </button>
        <ConnectionStatus
          compact
          state={isConnectionConfigured ? "configured" : "unconfigured"}
          label={t("ui.model-configuration", lang)}
          detail={config.base_url
            ? `${getModelDisplayName(config.model) || config.model} · ${config.base_url}`
            : t("ui.not-configured", lang)}
          onClick={() => { setSettingsTab("model"); setSettingsOpen(true); }}
        />
      </div>
    </aside>
  );
}
