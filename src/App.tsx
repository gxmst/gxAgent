import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
// Order matters: tokens first, responsive overrides last.
import "./styles/tokens.css";
import "./styles/tailwind.css";
import "./styles/enhancements.css";
import "./styles/themes.css";
import "./styles/shell.css";
import "./styles/chat.css";
import "./styles/overlays.css";
import "./styles/responsive.css";
import "./styles/feedback.css";
import "./styles/onboarding.css";
import "./styles/workspace.css";
import "./styles/integrations.css";
import "./styles/workbench.css";
import "./styles/learning.css";
import "./styles/settings.css";

import { ROLE_PRESETS } from "./rolePresets";
import { exportAllSessions, importSessions, getToolStats } from "./utils/sessionHelpers";
import { ContextMenu, useContextMenu } from "./components/shared/ContextMenu";
import { resolveRequestConfig } from "./utils/requestConfig";
import { compareSidebarSessions, moveSessionInSidebar } from "./utils/sessionOrder";
import { searchSessions, type SearchSnippet } from "./utils/sessionSearch";
import { sortModels, sortProfileEntries } from "./utils/modelSorting";
import { SettingsModal } from "./components/settings/SettingsModal";
import { SessionSettingsPanel } from "./components/settings/SessionSettingsPanel";
import { Sidebar } from "./components/sidebar/Sidebar";
import { WorkspacePanel } from "./components/workspace/WorkspacePanel";
import { WindowTitleBar } from "./components/workspace/WindowTitleBar";
import { EMPTY_FILE_VIEW, useWorkspaceViewStore } from "./store/workspaceViewStore";
import { ConfirmDialog } from "./components/shared/ConfirmDialog";
import { t } from "./i18n";
import { ChatMessageList } from "./components/chat/ChatMessageList";
import { Composer } from "./components/chat/Composer";
import { ChatHeader } from "./components/chat/ChatHeader";
import { ToastStack } from "./components/shared/ToastStack";
import { ToolStatsModal } from "./components/shared/ToolStatsModal";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { SETTINGS_TAB_ORDER, settingsTabLabel } from "./components/settings/settingsNavigation";

import { useAttachments } from "./hooks/useAttachments";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { useOnboarding } from "./hooks/useOnboarding";
import { useConfigActions } from "./hooks/useConfigActions";
import { useAgentRequest } from "./hooks/useAgentRequest";
import { useSessionLifecycle } from "./hooks/useSessionLifecycle";
import { useConfirmation } from "./hooks/useConfirmation";
import { useConfigSync } from "./hooks/useConfigSync";
import { useSessionPersistence } from "./hooks/useSessionPersistence";
import { useWorkbenchLayout } from "./hooks/useWorkbenchLayout";
import { useWorkbenchHotkeys } from "./hooks/useWorkbenchHotkeys";

import { connectionModels } from "./utils/connections";
import { ChatSession, SessionConfig, ToolAction } from "./types";
import {
  createEmptyWorkspaceState,
  createDefaultSession,
  normalizeSessions,
  modelCatalogForConfig,
} from "./appDefaults";
import { useAppStore } from "./store/appStore";
import { useUIStore } from "./store/uiStore";
import { runtime, uiCallbacks } from "./services/agentRuntime";
import { addLog, notify, refreshWorkspace } from "./services/agentEvents";

function App() {
  const {
    config,
    setConfig,
    configReady,
    configSaveStatus,
    setConfigSaveStatus,
    lastSavedConfigRef,
    presets,
    models,
    setModels,
    modelCatalogSourceKey,
    setModelCatalogSourceKey,
    setModelsLoading,
  } = useConfigSync();

  const lang = config.language || "zh";
  const sessions = useAppStore((s) => s.sessions);
  const setSessions = useAppStore((s) => s.setSessions);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setCurrentSessionId = useAppStore((s) => s.setCurrentSessionId);
  const activeRunSessionId = useAppStore((s) => s.activeRunSessionId);
  const preparingRequestSessionId = useAppStore((s) => s.preparingRequestSessionId);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const mcpStatusByName = useAppStore((s) => s.mcpStatusByName);
  const runtimeBySession = useAppStore((s) => s.runtimeBySession);
  const workspaceBySession = useAppStore((s) => s.workspaceBySession);
  const setPreviewBySession = useAppStore((s) => s.setPreviewBySession);
  const setModifiedFilesBySession = useAppStore((s) => s.setModifiedFilesBySession);
  const setTerminalLogsBySession = useAppStore((s) => s.setTerminalLogsBySession);

  const hasActiveRequest = activeRunSessionId !== null;
  const hasPendingRequest = hasActiveRequest || preparingRequestSessionId !== null;

  const navigationOpen = useUIStore((s) => s.navigationOpen);
  const setNavigationOpen = useUIStore((s) => s.setNavigationOpen);
  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useUIStore((s) => s.setRightPanelOpen);
  const mobilePane = useUIStore((s) => s.mobilePane);
  const setMobilePane = useUIStore((s) => s.setMobilePane);
  const sidebarNav = useUIStore((s) => s.sidebarNav);
  const setSidebarNav = useUIStore((s) => s.setSidebarNav);
  const settingsTab = useUIStore((s) => s.settingsTab);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  const sessionSettingsOpen = useUIStore((s) => s.sessionSettingsOpen);
  const setSessionSettingsOpen = useUIStore((s) => s.setSessionSettingsOpen);
  const toolStatsDialog = useUIStore((s) => s.toolStatsDialog);
  const setToolStatsDialog = useUIStore((s) => s.setToolStatsDialog);
  const selectedRunBySession = useUIStore((s) => s.selectedRunBySession);
  const setExpandedActions = useUIStore((s) => s.setExpandedActions);
  const setEditingMessageIdxBySession = useUIStore((s) => s.setEditingMessageIdxBySession);
  const editTextBySession = useUIStore((s) => s.editTextBySession);
  const setEditTextBySession = useUIStore((s) => s.setEditTextBySession);
  const draftsBySession = useUIStore((s) => s.draftsBySession);
  const setDraftsBySession = useUIStore((s) => s.setDraftsBySession);
  const setPromptForSession = useUIStore((s) => s.setPromptForSession);
  const customPresets = useUIStore((s) => s.customPresets);
  const setCustomPresets = useUIStore((s) => s.setCustomPresets);

  const prompt = draftsBySession[currentSessionId] || "";
  const setPrompt = useCallback(
    (next: string | ((previous: string) => string)) => setPromptForSession(currentSessionId, next),
    [currentSessionId, setPromptForSession],
  );
  const editText = editTextBySession[currentSessionId] || "";
  const setEditingMessageIdx = useCallback(
    (value: number | null) => setEditingMessageIdxBySession((previous) => ({ ...previous, [currentSessionId]: value })),
    [currentSessionId, setEditingMessageIdxBySession],
  );

  const { menu, handleContextMenu, closeMenu } = useContextMenu();
  const { confirmation, requestConfirmation, settleConfirmation } = useConfirmation();
  const {
    saveSession,
    saveSessions,
    deleteStoredSession,
    sessionStorageReady,
    sessionSaveStatus,
    setSessionLoadAttempt,
    sessionPersistenceEpochRef,
    lastPersistedSessionsRef,
    sessionObjCacheRef,
    sessionJsonCacheRef,
    persistLatestRef,
  } = useSessionPersistence(lang, hasActiveRequest);
  const sessionMutationLocked = !sessionStorageReady || hasPendingRequest;

  const {
    layout,
    draggingSidebar,
    draggingRight,
    handleSidebarDrag,
    handleRightDrag,
    nudgeSidebarWidth,
    nudgeRightPanelWidth,
  } = useWorkbenchLayout();
  const { maxSidebarWidth, maxReviewWidth } = layout;

  const [customGlobalContextBudget, setCustomGlobalContextBudget] = useState(false);
  const [customSessionContextBudget, setCustomSessionContextBudget] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const historyListRef = useRef<HTMLDivElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const sessionSettingsPanelRef = useRef<HTMLDivElement>(null);
  const sessionSettingsToggleRef = useRef<HTMLButtonElement>(null);
  const requestStartingRef = useRef(false);

  const closeSessionSettings = useCallback((restoreFocus = false) => {
    setSessionSettingsOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => sessionSettingsToggleRef.current?.focus());
    }
  }, [setSessionSettingsOpen]);

  useEffect(() => {
    runtime.isStreaming = hasActiveRequest;
  }, [hasActiveRequest]);

  useLayoutEffect(() => {
    if (settingsOpen && settingsBodyRef.current) {
      settingsBodyRef.current.scrollTop = 0;
    }
  }, [settingsOpen, settingsTab]);

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId) || sessions[0] || createDefaultSession(),
    [sessions, currentSessionId],
  );
  const currentMode = currentSession.sessionConfig.mode || "chat";

  const { visibleSessions, archivedSessions, searchSnippets } = useMemo(() => {
    const query = debouncedSearch.trim();
    if (!query) {
      return {
        visibleSessions: sessions.filter((session) => !session.archived).sort(compareSidebarSessions),
        archivedSessions: sessions.filter((session) => session.archived).sort(compareSidebarSessions),
        searchSnippets: {} as Record<string, SearchSnippet | null>,
      };
    }
    const matches = searchSessions(sessions, query);
    return {
      visibleSessions: matches.map((match) => match.session).sort(compareSidebarSessions),
      archivedSessions: [] as ChatSession[],
      searchSnippets: Object.fromEntries(matches.map((match) => [match.session.id, match.snippet])),
    };
  }, [debouncedSearch, sessions]);
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

  const {
    attachments,
    setAttachments,
    attachmentsBySession,
    setAttachmentsBySession,
    attachmentLoadingBySession,
    setAttachmentLoadingBySession,
    isAttachmentLoading,
    hasAttachmentLoading,
    reportAttachmentFit,
    addFilesAsAttachments,
    pickAndParseAttachments,
  } = useAttachments({ sessionStorageReady, lang });

  const searchMode = currentSession.sessionConfig.searchMode || "auto";
  const webSearchAvailable = config.tools_enabled.includes("web_search");
  const effectiveSearchMode = webSearchAvailable ? searchMode : "off";
  const resolvedCurrentConfig = useMemo(
    () => resolveRequestConfig(config, currentSession.sessionConfig, effectiveSearchMode),
    [config, currentSession.sessionConfig, effectiveSearchMode],
  );
  const modelsForCurrentConfig = connectionModels(
    resolvedCurrentConfig.model,
    config.profiles[resolvedCurrentConfig.active_profile || ""]?.models,
    modelCatalogForConfig(models, modelCatalogSourceKey, resolvedCurrentConfig),
  );
  const effectiveWorkDir = resolvedCurrentConfig.default_work_dir;
  const currentWorkspace = workspaceBySession[currentSessionId] || createEmptyWorkspaceState();

  useEffect(() => { runtime.effectiveWorkDir = effectiveWorkDir; }, [effectiveWorkDir]);
  useEffect(() => { runtime.lang = lang; }, [lang]);
  useEffect(() => {
    uiCallbacks.focusComposer = () => chatTextareaRef.current?.focus();
    return () => { uiCallbacks.focusComposer = () => {}; };
  }, []);

  useEffect(() => {
    setRightPanelOpen(false);
    setMobilePane("conversation");
    setSidebarNav(currentMode);
  }, [currentMode, setMobilePane, setRightPanelOpen, setSidebarNav]);

  useEffect(() => {
    setMobilePane("conversation");
    if (window.innerWidth <= 800) setNavigationOpen(false);
    closeSessionSettings();
  }, [currentSessionId, closeSessionSettings, setMobilePane, setNavigationOpen]);

  useEffect(() => {
    const sessionId = useAppStore.getState().currentSessionId;
    setTerminalLogsBySession((previous) => ({
      ...previous,
      [sessionId]: [
        { text: t("log.init", lang), type: "info" },
        { text: t("log.backend", lang), type: "info" },
      ],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(sessionSearch), 200);
    return () => clearTimeout(timer);
  }, [sessionSearch]);

  const ALL_PRESETS = useMemo(() => [...ROLE_PRESETS, ...customPresets], [customPresets]);
  const activeRolePresetFingerprint = useMemo(
    () => sessions.map((session) => `${session.id}:${session.sessionConfig.activeRolePresetId || ""}`).join("\u0000"),
    [sessions],
  );

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
            sessionConfig: { ...session.sessionConfig, activeRolePresetId: null },
          };
        }
        if (session.sessionConfig.systemPrompt === preset.prompt && session.sessionConfig.temperature === preset.temperature) {
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
  }, [ALL_PRESETS, activeRolePresetFingerprint, setSessions]);

  useEffect(() => {
    const previousWorkspace = workspaceBySession[currentSessionId];
    if (previousWorkspace && previousWorkspace.workDir !== effectiveWorkDir) {
      setModifiedFilesBySession((previous) => ({ ...previous, [currentSessionId]: {} }));
      setPreviewBySession((previous) => ({ ...previous, [currentSessionId]: "" }));
    }
    const views = useWorkspaceViewStore.getState();
    if (views.files[currentSessionId]?.workDir !== effectiveWorkDir) {
      runtime.fileRequestSequence[currentSessionId] = (runtime.fileRequestSequence[currentSessionId] || 0) + 1;
      views.setFile(currentSessionId, { ...EMPTY_FILE_VIEW, workDir: effectiveWorkDir });
    }
    if (currentMode === "code" || rightPanelOpen) void refreshWorkspace(currentSessionId, effectiveWorkDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, effectiveWorkDir]);

  const workspaceActions = useWorkspaceActions({
    lang,
    effectiveWorkDir,
    sessionMutationLocked,
    requestConfirmation,
    attachmentsBySession,
    setAttachmentsBySession,
    attachmentLoadingBySession,
    setAttachmentLoadingBySession,
    reportAttachmentFit,
  });

  const {
    fetchModelList,
    getModelDisplayName,
    testMcpServer,
    deleteMcpServer,
    saveConfig,
    toggleTool,
    removeTrustedPattern,
  } = useConfigActions({
    lang,
    config,
    setConfig,
    setModels,
    setModelCatalogSourceKey,
    setModelsLoading,
    setConfigSaveStatus,
    lastSavedConfigRef,
  });

  useEffect(() => {
    if (!configReady || !config.base_url) return;
    void fetchModelList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configReady]);

  const {
    formatTokenCount,
    undoCompact,
    handleSendMessage,
    handleStopStreaming,
    handleSteeringMessage,
    handleRetry,
    handleEditBranch,
    handleBranchFromMessage,
  } = useAgentRequest({
    lang,
    config,
    sessionStorageReady,
    sessionMutationLocked,
    requestStartingRef,
    models,
    modelCatalogSourceKey,
    resolvedCurrentConfig,
    currentSession,
    prompt,
    setPrompt,
    attachments,
    isAttachmentLoading,
    setDraftsBySession,
    setAttachmentsBySession,
    setSidebarNav,
    editText,
    setEditingMessageIdx,
  });

  const {
    createNewSessionInMode,
    createNewSession,
    switchSessionMode,
    replaceAllSessions,
    deleteSession,
    setSessionArchived,
  } = useSessionLifecycle({
    lang,
    sessionStorageReady,
    sidebarNav,
    setSidebarNav,
    requestStartingRef,
    sessionPersistenceEpochRef,
    lastPersistedSessionsRef,
    sessionObjCacheRef,
    sessionJsonCacheRef,
    saveSession,
    saveSessions,
    deleteStoredSession,
    setDraftsBySession,
    setAttachmentsBySession,
    attachmentLoadingBySession,
    setAttachmentLoadingBySession,
    setEditingMessageIdxBySession,
    setEditTextBySession,
    setExpandedActions,
  });

  useWorkbenchHotkeys({
    confirmation,
    settleConfirmation,
    contextMenu,
    closeSessionContextMenu: () => setContextMenu(null),
    navigationOverlay: layout.navigationOverlay,
    closeSessionSettings,
    createNewSession,
    switchSessionMode,
  });

  const patchSessionConfig = (patch: Partial<SessionConfig>) => {
    setSessions((previous) => previous.map((session) => (
      session.id === currentSessionId
        ? { ...session, sessionConfig: { ...session.sessionConfig, ...patch }, updatedAt: Date.now() }
        : session
    )));
  };

  const {
    onboardingOpen,
    onboardingConnection,
    onboardingValues,
    updateOnboardingValues,
    pickOnboardingWorkspace,
    testOnboardingConnection,
    completeOnboarding,
    dismissOnboarding,
  } = useOnboarding({
    lang,
    config,
    setConfig,
    configReady,
    lastSavedConfigRef,
    currentSession,
    resolvedCurrentConfig,
    effectiveWorkDir,
    setModels,
    setModelCatalogSourceKey,
    patchSessionConfig,
    setSidebarNav,
  });

  const modelsForOnboarding = sortModels(modelCatalogForConfig(models, modelCatalogSourceKey, {
    wire_format: onboardingValues.wireFormat,
    base_url: onboardingValues.baseUrl,
    api_key: onboardingValues.apiKey,
  }), lang);

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

  const handleExportSessions = () => {
    exportAllSessions(sessions);
    notify(t("session.exportedAll", lang), "success");
    closeMenu();
  };

  const handleImportSessions = () => {
    if (sessionMutationLocked || hasAttachmentLoading) {
      notify(t("ui.stop-the-active-task-and", lang), "error");
      closeMenu();
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const imported = await importSessions(file);
        const normalized = normalizeSessions(imported);
        await replaceAllSessions(normalized, currentSessionId);
        notify(t("session.importedCount", lang, { count: String(normalized.length) }), "success");
      } catch {
        notify(t("session.importFailed", lang), "error");
      }
    };
    input.click();
    closeMenu();
  };

  const handleClearAll = async () => {
    if (sessionMutationLocked || hasAttachmentLoading) {
      notify(t("ui.stop-the-active-task-and-2", lang), "error");
      closeMenu();
      return;
    }
    if (await requestConfirmation({
      title: t("ui.clear-all-title", lang),
      message: t("settings.clearSessionsConfirm", lang),
      confirmLabel: t("settings.clearSessions", lang),
      cancelLabel: t("ui.cancel", lang),
      danger: true,
    })) {
      try {
        const replacement = createDefaultSession();
        await replaceAllSessions([replacement], replacement.id);
        notify(t("settings.cleared", lang), "success");
      } catch (error) {
        notify(`${t("ui.clear-failed", lang)}: ${error}`, "error");
      }
    }
    closeMenu();
  };

  const handleShowStats = () => {
    setToolStatsDialog({ title: t("stats.allSessions", lang), stats: getToolStats(sessions) });
    closeMenu();
  };

  const moveSessionInList = (sessionId: string, direction: "up" | "down") => {
    setSessions((previous) => moveSessionInSidebar(previous, sessionId, direction));
  };

  const currentSettingsTabLabel = settingsTabLabel(settingsTab, lang);

  const handleSettingsTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = SETTINGS_TAB_ORDER.indexOf(settingsTab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? SETTINGS_TAB_ORDER.length - 1
        : (currentIndex + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + SETTINGS_TAB_ORDER.length)
          % SETTINGS_TAB_ORDER.length;
    const nextTab = SETTINGS_TAB_ORDER[nextIndex];
    setSettingsTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`settings-tab-${nextTab}`)?.focus());
  };

  return (
    <div
      className={`app-container workbench mode-${currentMode} ${navigationOpen ? "navigation-open" : "navigation-closed"} ${layout.navigationOverlay ? "navigation-overlay" : "navigation-inline"} mobile-pane-${mobilePane} ${rightPanelOpen ? "review-open" : "review-closed"}`}
      onContextMenu={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("chat-panel") || (e.target as HTMLElement).classList.contains("chat-messages")) {
          handleContextMenu(e);
        }
      }}
    >
      <ToastStack />
      <WindowTitleBar
        lang={lang}
        config={config}
        setConfig={setConfig}
        navigationOpen={navigationOpen}
        onToggleNavigation={() => setNavigationOpen((open) => !open)}
      />

      <div className="workbench-body">
        {navigationOpen && layout.navigationOverlay && (
          <button type="button" className="navigation-backdrop" aria-label={lang === "zh" ? "关闭侧栏" : "Close sidebar"} onClick={() => setNavigationOpen(false)} />
        )}
        <div id="workbench-navigation" className="workbench-navigation" style={{ "--sidebar-width": `${layout.sidebarWidth}px` } as React.CSSProperties}>
          <Sidebar
            lang={lang}
            config={config}
            visibleSessions={visibleSessions}
            archivedSessions={archivedSessions}
            searchSnippets={searchSnippets}
            tabbableSessionId={tabbableSessionId}
            sidebarWidth={layout.sidebarWidth}
            sessionSearch={sessionSearch}
            setSessionSearch={setSessionSearch}
            debouncedSearch={debouncedSearch}
            sessionStorageReady={sessionStorageReady}
            historyListRef={historyListRef}
            contextMenu={contextMenu}
            setContextMenu={setContextMenu}
            allPresets={ALL_PRESETS}
            addLog={addLog}
            getModelDisplayName={getModelDisplayName}
            createNewSession={createNewSession}
            createProjectTask={(workDir) => { void createNewSessionInMode("code", workDir); }}
            onSelectSession={(id) => { setCurrentSessionId(id); if (layout.navigationOverlay) setNavigationOpen(false); }}
            deleteSession={deleteSession}
            setSessionArchived={setSessionArchived}
            moveSessionInList={moveSessionInList}
          />
        </div>

        <div
          className={`resize-divider sidebar-divider ${draggingSidebar ? "dragging" : ""}`}
          onMouseDown={handleSidebarDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("ui.resize-conversation-sidebar", lang)}
          aria-valuemin={180}
          aria-valuemax={maxSidebarWidth}
          aria-valuenow={layout.sidebarWidth}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            nudgeSidebarWidth(event.key === "ArrowRight" ? 12 : -12);
          }}
        />

        <div className="workspace-container">
          <div className="mobile-workspace-tabs" role="group" aria-label={lang === "zh" ? "工作区视图" : "Workspace view"}>
            <button aria-pressed={mobilePane === "conversation"} onClick={() => setMobilePane("conversation")}>
              {lang === "zh" ? (currentMode === "code" ? "任务" : "对话") : "Conversation"}
            </button>
            <button aria-pressed={mobilePane === "review"} onClick={() => { setRightPanelOpen(true); setMobilePane("review"); }}>
              {lang === "zh" ? (currentMode === "code" ? "审查" : "资料") : "Workspace"}
            </button>
          </div>

          <section className="chat-panel">
            <ChatHeader
              key={currentSessionId}
              lang={lang}
              currentSession={currentSession}
              onModeChange={switchSessionMode}
              disabled={sessionMutationLocked}
              sessionSaveStatus={sessionSaveStatus}
              sessionSettingsToggleRef={sessionSettingsToggleRef}
            />
            {!sessionStorageReady && (
              <div className={`session-load-state ${sessionSaveStatus === "error" ? "error" : ""}`} role="status">
                <span>
                  {sessionSaveStatus === "error"
                    ? (lang === "zh" ? "会话读取失败，保存已暂停。" : "Session loading failed. Saving is paused.")
                    : (lang === "zh" ? "正在读取会话…" : "Loading conversations...")}
                </span>
                {sessionSaveStatus === "error" && (
                  <button className="btn" onClick={() => setSessionLoadAttempt((attempt) => attempt + 1)}>
                    {lang === "zh" ? "重试" : "Retry"}
                  </button>
                )}
              </div>
            )}

            {sessionSettingsOpen && (
              <SessionSettingsPanel
                lang={lang}
                config={config}
                currentSession={currentSession}
                currentSessionId={currentSessionId}
                resolvedCurrentConfig={resolvedCurrentConfig}
                models={modelsForCurrentConfig}
                runtimeBySession={runtimeBySession}
                sessionMutationLocked={sessionMutationLocked}
                customSessionContextBudget={customSessionContextBudget}
                setCustomSessionContextBudget={setCustomSessionContextBudget}
                sessionSettingsPanelRef={sessionSettingsPanelRef}
                closeSessionSettings={closeSessionSettings}
                patchSessionConfig={patchSessionConfig}
                setSessions={setSessions}
                undoCompact={undoCompact}
                requestConfirmation={requestConfirmation}
                customPresets={customPresets}
                setCustomPresets={setCustomPresets}
              />
            )}

            <ChatMessageList
              lang={lang}
              config={config}
              setConfig={setConfig}
              currentSession={currentSession}
              sessionMutationLocked={sessionMutationLocked}
              statusLabel={statusLabel}
              formatTokenCount={formatTokenCount}
              getModelDisplayName={getModelDisplayName}
              handleRetry={handleRetry}
              handleEditBranch={handleEditBranch}
              handleBranchFromMessage={handleBranchFromMessage}
              attachments={attachments}
              resolvedCurrentConfig={resolvedCurrentConfig}
              models={models}
              modelCatalogSourceKey={modelCatalogSourceKey}
              chatTextareaRef={chatTextareaRef}
            />

            <Composer
              lang={lang}
              config={config}
              setConfig={setConfig}
              currentSession={currentSession}
              resolvedCurrentConfig={resolvedCurrentConfig}
              sessionStorageReady={sessionStorageReady}
              isAttachmentLoading={isAttachmentLoading}
              attachments={attachments}
              setAttachments={setAttachments}
              prompt={prompt}
              setPrompt={setPrompt}
              chatTextareaRef={chatTextareaRef}
              handleSendMessage={handleSendMessage}
              handleStopStreaming={handleStopStreaming}
              handleSteeringMessage={handleSteeringMessage}
              addFilesAsAttachments={addFilesAsAttachments}
              pickAndParseAttachments={pickAndParseAttachments}
              patchSessionConfig={patchSessionConfig}
              getModelDisplayName={getModelDisplayName}
              modelsForCurrentConfig={modelsForCurrentConfig}
              onSettings={() => setSessionSettingsOpen(true)}
              effectiveWorkDir={effectiveWorkDir}
              branch={currentWorkspace.branch}
            />
          </section>

          {rightPanelOpen && (
            <div
              className={`resize-divider review-divider ${draggingRight ? "dragging" : ""}`}
              onMouseDown={handleRightDrag}
              role="separator"
              aria-orientation="vertical"
              aria-label={t("ui.resize-workspace-panel", lang)}
              aria-valuemin={320}
              aria-valuemax={maxReviewWidth}
              aria-valuenow={layout.reviewWidth}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                nudgeRightPanelWidth(event.key === "ArrowLeft" ? 12 : -12);
              }}
            />
          )}

          <WorkspacePanel
            key={`${currentSessionId}:${effectiveWorkDir}`}
            lang={lang}
            config={config}
            session={currentSession}
            open={rightPanelOpen}
            width={layout.reviewWidth}
            onClose={() => { setRightPanelOpen(false); setMobilePane("conversation"); }}
            workspace={currentWorkspace}
            onRefresh={() => { void refreshWorkspace(currentSessionId, effectiveWorkDir); }}
            actions={workspaceActions}
            attachmentsLoading={isAttachmentLoading}
            disabled={sessionMutationLocked}
            selectedRunId={selectedRunBySession[currentSessionId]}
          />
        </div>
      </div>

      {settingsOpen && (
        <SettingsModal
          lang={lang}
          config={config}
          setConfig={setConfig}
          settingsTab={settingsTab}
          setSettingsTab={setSettingsTab}
          setSettingsOpen={setSettingsOpen}
          settingsBodyRef={settingsBodyRef}
          handleSettingsTabKeyDown={handleSettingsTabKeyDown}
          currentSettingsTabLabel={currentSettingsTabLabel}
          saveConfig={saveConfig}
          configSaveStatus={configSaveStatus}
          addLog={addLog}
          notify={notify}
          customGlobalContextBudget={customGlobalContextBudget}
          setCustomGlobalContextBudget={setCustomGlobalContextBudget}
          toggleTool={toggleTool}
          removeTrustedPattern={removeTrustedPattern}
          mcpStatusByName={mcpStatusByName}
          testMcpServer={testMcpServer}
          deleteMcpServer={deleteMcpServer}
          presets={presets}
          sessionMutationLocked={sessionMutationLocked}
          createSessionSnapshot={async () => {
            if (sessionMutationLocked || !persistLatestRef.current) throw new Error(lang === "zh" ? "会话存储尚未就绪" : "Task storage is not ready");
            await persistLatestRef.current(true);
            await invoke("create_session_backup");
          }}
          hasAttachmentLoading={hasAttachmentLoading}
          replaceAllSessions={replaceAllSessions}
          requestConfirmation={requestConfirmation}
        />
      )}
      {confirmation && (
        <ConfirmDialog
          {...confirmation}
          onCancel={() => settleConfirmation(false)}
          onConfirm={() => settleConfirmation(true)}
        />
      )}
      {toolStatsDialog && (
        <ToolStatsModal
          lang={lang}
          toolStatsDialog={toolStatsDialog}
          setToolStatsDialog={setToolStatsDialog}
        />
      )}
      <OnboardingWizard
        open={onboardingOpen}
        lang={lang}
        values={onboardingValues}
        profiles={sortProfileEntries(Object.entries(config.profiles), lang).map(([id, profile]) => ({ ...profile, id }))}
        models={modelsForOnboarding}
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
