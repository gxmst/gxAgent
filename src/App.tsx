import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
// Order matters: tokens first, a11y last (it clamps/overrides earlier rules).
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/enhancements.css";
import "./styles/themes.css";
import "./styles/shell.css";
import "./styles/chat.css";
import "./styles/overlays.css";
import "./styles/a11y.css";
import { ROLE_PRESETS, RolePreset } from "./rolePresets";
import { useGlobalHotkeys } from "./components/shared/CommandSuggestions";
import { exportAllSessions, importSessions, getToolStats } from "./utils/sessionHelpers";
import { ContextMenu, useContextMenu } from "./components/shared/ContextMenu";
import { useSessionStorage } from "./hooks/useSessionStorage";
import { resolveRequestConfig } from "./utils/requestConfig";
import { compareSidebarSessions, moveSessionInSidebar } from "./utils/sessionOrder";
import { SettingsModal } from "./components/settings/SettingsModal";
import { SessionSettingsPanel } from "./components/settings/SessionSettingsPanel";
import { Sidebar } from "./components/sidebar/Sidebar";
import { WorkspacePanel } from "./components/workspace/WorkspacePanel";
import { ConfirmDialog, type ConfirmationOptions } from "./components/shared/ConfirmDialog";
import { t } from "./i18n";
import { ChatMessageList } from "./components/chat/ChatMessageList";
import { Composer } from "./components/chat/Composer";
import { ChatHeader } from "./components/chat/ChatHeader";
import { ToastStack } from "./components/shared/ToastStack";
import { ToolStatsModal } from "./components/shared/ToolStatsModal";
import { useAttachments } from "./hooks/useAttachments";
import { useWorkspaceActions } from "./hooks/useWorkspaceActions";
import { useOnboarding } from "./hooks/useOnboarding";
import { useConfigActions } from "./hooks/useConfigActions";
import { useAgentRequest } from "./hooks/useAgentRequest";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";

const SETTINGS_TAB_ORDER = ["model", "chat", "agent", "search", "data"] as const;
type SettingsTab = (typeof SETTINGS_TAB_ORDER)[number];


// ==========================================
// Types
// ==========================================

import {
  AppConfig,
  ProviderPreset,
  ModelInfo,
  ToolAction,
  ChatSession,
  SessionConfig,
} from "./types";

import {
  createEmptyWorkspaceState,
  omitSessionKey,
  DEFAULT_CONFIG,
  createDefaultSession,
  createSession,
  normalizeSessions,
  FONT_OPTIONS,
  themeMode,
  modelCatalogForConfig,
  modelCatalogKey,
  type ToolStatsDialog,
  type RunCheckpoint,
} from "./appDefaults";

import { useAppStore } from "./store/appStore";
import { runtime, uiCallbacks } from "./services/agentRuntime";
import {
  addLog,
  notify,
  refreshWorkspace,
  discardStreamBuffer,
} from "./services/agentEvents";


function App() {
  // ==========================================
  // Config & State
  // ==========================================

  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [configReady, setConfigReady] = useState(false);
  const [configSaveStatus, setConfigSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const lastSavedConfigRef = useRef("");
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setCurrentSessionId = useAppStore((s) => s.setCurrentSessionId);

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

  // Global hotkeys
  useGlobalHotkeys(() => createNewSession());

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

  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelCatalogSourceKey, setModelCatalogSourceKey] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [customGlobalContextBudget, setCustomGlobalContextBudget] = useState(false);
  const [customSessionContextBudget, setCustomSessionContextBudget] = useState<Record<string, boolean>>({});
  const mcpStatusByName = useAppStore((s) => s.mcpStatusByName);

  const activeRunSessionId = useAppStore((s) => s.activeRunSessionId);
  const setActiveRunSessionId = useAppStore((s) => s.setActiveRunSessionId);
  const preparingRequestSessionId = useAppStore((s) => s.preparingRequestSessionId);
  const setPreparingRequestSessionId = useAppStore((s) => s.setPreparingRequestSessionId);
  const runtimeBySession = useAppStore((s) => s.runtimeBySession);
  const setRuntimeBySession = useAppStore((s) => s.setRuntimeBySession);
  const checkpointBySession = useAppStore((s) => s.checkpointBySession);
  const setCheckpointBySession = useAppStore((s) => s.setCheckpointBySession);
  const hasActiveRequest = activeRunSessionId !== null;
  const hasPendingRequest = hasActiveRequest || preparingRequestSessionId !== null;
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("model");
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const previewBySession = useAppStore((s) => s.previewBySession);
  const setPreviewBySession = useAppStore((s) => s.setPreviewBySession);
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
  const modifiedFilesBySession = useAppStore((s) => s.modifiedFilesBySession);
  const setModifiedFilesBySession = useAppStore((s) => s.setModifiedFilesBySession);
  const modifiedFiles = modifiedFilesBySession[currentSessionId] || {};
  const [diffView, setDiffView] = useState(false);
  const [rolePresetsOpen, setRolePresetsOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
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
  const fileContent = useAppStore((s) => s.fileContent);
  const setFileContent = useAppStore((s) => s.setFileContent);
  const selectedFile = useAppStore((s) => s.selectedFile);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);
  const workspaceBySession = useAppStore((s) => s.workspaceBySession);
  const setWorkspaceBySession = useAppStore((s) => s.setWorkspaceBySession);
  const terminalLogsBySession = useAppStore((s) => s.terminalLogsBySession);
  const setTerminalLogsBySession = useAppStore((s) => s.setTerminalLogsBySession);
  const terminalLogs = terminalLogsBySession[currentSessionId] || [];
  const previewConsoleLogsBySession = useAppStore((s) => s.previewConsoleLogsBySession);
  const setPreviewConsoleLogsBySession = useAppStore((s) => s.setPreviewConsoleLogsBySession);
  const previewConsoleLogs = previewConsoleLogsBySession[currentSessionId] || [];
  const setPreviewConsoleLogs = useCallback((next: { text: string; type: "log" | "error" | "warn" | "info" }[] | ((previous: { text: string; type: "log" | "error" | "warn" | "info" }[]) => { text: string; type: "log" | "error" | "warn" | "info" }[])) => {
    setPreviewConsoleLogsBySession((previous) => {
      const current = previous[currentSessionId] || [];
      const value = typeof next === "function" ? next(current) : next;
      return { ...previous, [currentSessionId]: value };
    });
  }, [currentSessionId]);
  const [confirmation, setConfirmation] = useState<ConfirmationOptions | null>(null);
  const confirmationResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const settleConfirmation = useCallback((confirmed: boolean) => {
    confirmationResolverRef.current?.(confirmed);
    confirmationResolverRef.current = null;
    setConfirmation(null);
    const returnFocus = confirmationReturnFocusRef.current;
    confirmationReturnFocusRef.current = null;
    requestAnimationFrame(() => returnFocus?.focus());
  }, []);
  const requestConfirmation = useCallback((options: ConfirmationOptions) => {
    confirmationResolverRef.current?.(false);
    confirmationReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setConfirmation(options);
    return new Promise<boolean>((resolve) => {
      confirmationResolverRef.current = resolve;
    });
  }, []);
  const {
    saveSession,
    saveSessions,
    loadSessions,
    deleteSession: deleteStoredSession,
  } = useSessionStorage();

  const sessions = useAppStore((s) => s.sessions);
  const setSessions = useAppStore((s) => s.setSessions);
  const [sessionStorageReady, setSessionStorageReady] = useState(false);
  const sessionMutationLocked = !sessionStorageReady || hasPendingRequest;
  const [sessionSaveStatus, setSessionSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [expandedActions, setExpandedActions] = useState<Record<string, boolean>>({});
  const pendingApprovalsBySession = useAppStore((s) => s.pendingApprovalsBySession);
  const setPendingApprovalsBySession = useAppStore((s) => s.setPendingApprovalsBySession);
  const setApprovalSubmittingBySession = useAppStore((s) => s.setApprovalSubmittingBySession);
  const setUsageStatsBySession = useAppStore((s) => s.setUsageStatsBySession);
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

  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const historyListRef = useRef<HTMLDivElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const sessionSettingsPanelRef = useRef<HTMLDivElement>(null);
  const sessionSettingsToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarNavRef = useRef(sidebarNav);
  const lastSessionByModeRef = useRef<Partial<Record<SessionConfig["mode"], string>>>({});
  const requestStartingRef = useRef(false);
  const switchSidebarModeRef = useRef<(mode: SessionConfig["mode"]) => void>(() => {});
  // Same latest-value pattern as switchSidebarModeRef: the window keydown
  // effect's dependency array only tracks modal state, so calling
  // createNewSession directly there captures a stale sidebarNav/session list.
  const createNewSessionRef = useRef<() => void>(() => {});
  const lastPersistedSessionsRef = useRef<Record<string, string>>({});
  // Incremental persistence caches: last-seen object identity and its JSON.
  // Identity mismatch marks a session dirty; only dirty sessions re-serialize.
  const sessionObjCacheRef = useRef<Record<string, ChatSession>>({});
  const sessionJsonCacheRef = useRef<Record<string, string>>({});
  // Set when the localStorage mirror write was skipped mid-stream, so the
  // next idle persist refreshes it even if nothing else changed.
  const mirrorPendingRef = useRef(false);
  const sessionPersistenceEpochRef = useRef(0);
  const closeSessionSettings = useCallback((restoreFocus = false) => {
    setSessionSettingsOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => sessionSettingsToggleRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    sidebarNavRef.current = sidebarNav;
  }, [sidebarNav]);

  // Keep the module-level runtime mirror in sync with the reactive state so
  // the once-registered event handlers always see current values.
  useEffect(() => {
    runtime.isStreaming = hasActiveRequest;
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
  const modelsForCurrentConfig = modelCatalogForConfig(models, modelCatalogSourceKey, resolvedCurrentConfig);
  const modelsForGlobalConfig = modelCatalogForConfig(models, modelCatalogSourceKey, config);
  const effectiveWorkDir = resolvedCurrentConfig.default_work_dir;
  const currentWorkspace = workspaceBySession[currentSessionId] || createEmptyWorkspaceState();

  useEffect(() => {
    runtime.effectiveWorkDir = effectiveWorkDir;
  }, [effectiveWorkDir]);

  useEffect(() => {
    runtime.lang = lang;
  }, [lang]);

  // The listeners' focus-composer callback needs the textarea ref, which only
  // exists inside React. Register it once.
  useEffect(() => {
    uiCallbacks.focusComposer = () => chatTextareaRef.current?.focus();
    return () => {
      uiCallbacks.focusComposer = () => {};
    };
  }, []);

  useEffect(() => {
    setRightPanelOpen(currentMode === "code");
    setSidebarNav(currentMode);
  }, [currentMode]);

  // ==========================================
  // Theme
  // ==========================================

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirmation) {
        e.preventDefault();
        settleConfirmation(false);
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        switchSidebarModeRef.current(sidebarNavRef.current === "chat" ? "code" : "chat");
        return;
      }
      if (ctrl && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        createNewSessionRef.current();
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
  }, [confirmation, contextMenu, modelPickerOpen, rightPanelOpen, rolePresetsOpen, sessionSettingsOpen, settingsOpen, settleConfirmation, toolStatsDialog]);

  useEffect(() => () => {
    confirmationResolverRef.current?.(false);
    confirmationResolverRef.current = null;
  }, []);

  useEffect(() => {
    const theme = config.theme || "light";
    const mode = themeMode(theme);
    document.documentElement.setAttribute("data-theme", theme);
    // data-mode drives the light/dark component tweaks so any dark-family theme
    // inherits them without duplicating every override per theme.
    document.documentElement.setAttribute("data-mode", mode);
    // Mirror for the pre-paint inline script in index.html: the real config
    // lives in Rust and loads asynchronously, so without this mirror dark
    // themes flash a white frame on every cold start.
    try {
      localStorage.setItem("gx_theme", theme);
      localStorage.setItem("gx_theme_mode", mode);
    } catch { /* ignore */ }
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
        const sessionId = useAppStore.getState().currentSessionId;
        setPreviewConsoleLogsBySession((previous) => {
          const next = [...(previous[sessionId] || []), { text, type: logType }];
          return { ...previous, [sessionId]: next.length > 200 ? next.slice(-200) : next };
        });
      }
    };
    window.addEventListener("message", handleIframeMessage);
    return () => window.removeEventListener("message", handleIframeMessage);
  }, []);

  // ==========================================
  // Init logs with language
  // ==========================================

  useEffect(() => {
    const sessionId = useAppStore.getState().currentSessionId;
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

  // Populate the model picker on startup so the user does not have to open
  // Settings and press the refresh button first.
  useEffect(() => {
    if (!configReady || !config.base_url) return;
    void fetchModelList();
  }, [configReady]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const loadedSessions = await loadSessions();
      if (cancelled) return;
      if (loadedSessions !== null) {
        const storedSessions = normalizeSessions(loadedSessions);
        const rawById = Object.fromEntries(loadedSessions
          .filter((session): session is ChatSession => Boolean(session && typeof session === "object" && typeof session.id === "string"))
          .map((session) => [session.id, JSON.stringify(session)]));
        lastPersistedSessionsRef.current = rawById;
        sessionJsonCacheRef.current = Object.fromEntries(
          storedSessions.map((session) => [session.id, JSON.stringify(session)]),
        );
        // Keep migrated sessions dirty so backfilled stable message ids and
        // token-budget conversions are written to the authoritative backend.
        sessionObjCacheRef.current = Object.fromEntries(storedSessions
          .filter((session) => rawById[session.id] === JSON.stringify(session))
          .map((session) => [session.id, session]));
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

      // Incremental change detection: session objects are immutable-per-change
      // (setSessions only replaces the sessions it touches), so an identity
      // check finds the dirty ones for free. Only those get re-serialized —
      // stringifying the whole store on every change was a main-thread stall
      // that grew linearly with total history size.
      const dirty = sessions.filter((session) => sessionObjCacheRef.current[session.id] !== session);
      if (dirty.length === 0 && !mirrorPendingRef.current) return;
      for (const session of dirty) {
        sessionJsonCacheRef.current[session.id] = JSON.stringify(session);
        sessionObjCacheRef.current[session.id] = session;
      }

      // localStorage mirror (startup cache only; the backend is authoritative).
      // Assembled from the per-session cache and skipped entirely while a
      // request is streaming — the post-stream persist writes it once.
      if (hasActiveRequest) {
        if (dirty.length > 0) mirrorPendingRef.current = true;
      } else {
        mirrorPendingRef.current = false;
        try {
          const parts = sessions.map((session) =>
            sessionJsonCacheRef.current[session.id]
            ?? (sessionJsonCacheRef.current[session.id] = JSON.stringify(session)));
          const data = `[${parts.join(",")}]`;
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
      }

      // Scan all sessions (cached strings, so this is cheap) rather than just
      // the dirty ones, so a previously failed save retries on the next
      // persist instead of waiting for that session to change again.
      const changed = sessions
        .map((session) => ({
          session,
          serialized: sessionJsonCacheRef.current[session.id]
            ?? (sessionJsonCacheRef.current[session.id] = JSON.stringify(session)),
        }))
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
    const previousWorkspace = workspaceBySession[currentSessionId];
    if (previousWorkspace && previousWorkspace.workDir !== effectiveWorkDir) {
      setModifiedFilesBySession((previous) => ({ ...previous, [currentSessionId]: {} }));
      setPreviewBySession((previous) => ({ ...previous, [currentSessionId]: "" }));
    }
    runtime.fileRequestSequence[currentSessionId] = (runtime.fileRequestSequence[currentSessionId] || 0) + 1;
    setFileContent(null);
    setSelectedFile(null);
    void refreshWorkspace(currentSessionId, effectiveWorkDir);
  }, [currentSessionId, effectiveWorkDir]);

  // ==========================================
  // Helpers
  // ==========================================

  const {
    selectWorkspaceFile,
    attachWorkspaceFile,
    selectGitEntry,
    restoreGitEntry,
    restoreRunCheckpoint,
    acceptRunCheckpoint,
  } = useWorkspaceActions({
    lang,
    effectiveWorkDir,
    sessionMutationLocked,
    requestConfirmation,
    setDiffView,
    attachmentsBySession,
    setAttachmentsBySession,
    attachmentLoadingBySession,
    setAttachmentLoadingBySession,
    reportAttachmentFit,
  });

  const {
    fetchModelList,
    applyPreset,
    handleSaveProfile,
    getModelDisplayName,
    cacheModelDisplayName,
    handleActivateProfile,
    handleDeleteProfile,
    handleClearActiveProfile,
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
    newProfileName,
    setNewProfileName,
    setConfigSaveStatus,
    lastSavedConfigRef,
  });

  const {
    formatTokenCount,
    undoCompact,
    handleSendMessage,
    handleStopStreaming,
    handleSteeringMessage,
    handleRetry,
    handleEditBranch,
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

  const createNewSessionInMode = async (mode: SessionConfig["mode"]) => {
    if (!sessionStorageReady) return null;
    let workDir: string | null = null;
    if (mode === "code") {
      try {
        workDir = await invoke<string | null>("pick_workspace_directory");
      } catch (error) {
        notify((t("ui.could-not-open-the-folder-2", lang)) + error, "error");
        return null;
      }
      if (!workDir) return null;
    }
    const session = createSession(mode);
    if (workDir) session.sessionConfig.workDir = workDir;
    setSessions((previous) => [...previous, session]);
    setSidebarNav(mode);
    setCurrentSessionId(session.id);
    return session;
  };

  const createNewSession = () => {
    void createNewSessionInMode(sidebarNav);
  };
  createNewSessionRef.current = createNewSession;

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
      void createNewSessionInMode(mode);
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
    runtime.isStreaming = false;
    requestStartingRef.current = false;
    runtime.activeRequestId = "";
    runtime.activeRequestSessionId = "";
    setFileContent(null);
    setSelectedFile(null);
    setDiffView(false);
    setActiveTab("activity");
    runtime.requestSessionById = {};
    runtime.workspaceRequestSequence = {};
    runtime.fileRequestSequence = {};
    runtime.streamedToolOutputKeys.clear();
    discardStreamBuffer();
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
    delete runtime.workspaceRequestSequence[sessionId];
    delete runtime.fileRequestSequence[sessionId];
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
    sessionJsonCacheRef.current = { ...lastPersistedSessionsRef.current };
    sessionObjCacheRef.current = Object.fromEntries(
      nextSessions.map((session) => [session.id, session]),
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
      notify(t("ui.wait-for-attachments-to-finish", lang), "error");
      return;
    }
    if (runtimeBySession[id]) {
      notify(t("ui.stop-the-running-task-before", lang), "error");
      return;
    }
    const target = sessions.find(s => s.id === id);
    if (!target) return;
    const originalIndex = sessions.findIndex((session) => session.id === id);
    const wasCurrentSession = currentSessionId === id;
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
      sessionPersistenceEpochRef.current += 1;
      await deleteStoredSession(id);
      try { localStorage.setItem("gx_sessions", JSON.stringify(remaining)); } catch { /* backend is authoritative */ }
      setSessions(remaining);
      delete lastPersistedSessionsRef.current[id];
      delete sessionObjCacheRef.current[id];
      delete sessionJsonCacheRef.current[id];
    } catch (error) {
      addLog(`${t("ui.delete-failed", lang)}: ${error}`, "error", true);
      return;
    }
    if (wasCurrentSession) {
      setCurrentSessionId(fallbackSession.id);
      setSidebarNav(fallbackSession.sessionConfig.mode || "chat");
    }
    let restored = false;
    const finalizeTimer = window.setTimeout(() => {
      if (restored) return;
      dropSessionUiState(id);
      delete runtime.pendingTitleBySession[id];
      void consumeSessionCheckpoints([id]);
    }, 5200);
    const undoDelete = async () => {
      if (restored) return;
      restored = true;
      window.clearTimeout(finalizeTimer);
      try {
        await saveSession(target);
        const serialized = JSON.stringify(target);
        lastPersistedSessionsRef.current[id] = serialized;
        sessionJsonCacheRef.current[id] = serialized;
        setSessions((previous) => {
          if (previous.some((session) => session.id === id)) return previous;
          const next = [...previous];
          next.splice(Math.min(originalIndex, next.length), 0, target);
          return next;
        });
        if (wasCurrentSession) {
          setCurrentSessionId(id);
          setSidebarNav(target.sessionConfig.mode || "chat");
        }
        notify(t("ui.session-restored", lang), "success");
      } catch (error) {
        restored = false;
        dropSessionUiState(id);
        delete runtime.pendingTitleBySession[id];
        void consumeSessionCheckpoints([id]);
        addLog(`${t("ui.restore-session-failed", lang)}: ${error}`, "error", true);
      }
    };
    notify(
      t("ui.deleted-session", lang, { title: target.title || t("session.untitled", lang) }),
      "success",
      {
        actionLabel: t("ui.undo", lang),
        onAction: () => { void undoDelete(); },
        duration: 5000,
      },
    );
  };

  const toggleActionExpanded = (id: string) => {
    setExpandedActions((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  /** The one canonical way to write session-level overrides. Every quick
   *  control and settings field goes through here so "override vs inherit"
   *  semantics stay identical everywhere; null always means inherit. */
  const patchSessionConfig = (patch: Partial<SessionConfig>) => {
    setSessions((previous) => previous.map((session) => (
      session.id === currentSessionId
        ? {
            ...session,
            sessionConfig: { ...session.sessionConfig, ...patch },
            updatedAt: Date.now(),
          }
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
  const modelsForOnboarding = modelCatalogForConfig(models, modelCatalogSourceKey, {
    wire_format: onboardingValues.wireFormat,
    base_url: onboardingValues.baseUrl,
  });

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
      notify(t("ui.stop-the-active-task-and", lang), "error");
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
    setToolStatsDialog({
      title: t("stats.allSessions", lang),
      stats: getToolStats(sessions),
    });
    closeMenu();
  };

  const moveSessionInList = (sessionId: string, direction: "up" | "down") => {
    setSessions((previous) => moveSessionInSidebar(previous, sessionId, direction));
  };

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
      <ToastStack />

      {/* ====== Sidebar ====== */}
      <Sidebar
        lang={lang}
        config={config}
        sessions={sessions}
        visibleSessions={visibleSessions}
        currentSessionId={currentSessionId}
        tabbableSessionId={tabbableSessionId}
        sidebarNav={sidebarNav}
        sidebarWidth={sidebarWidth}
        sessionSearch={sessionSearch}
        setSessionSearch={setSessionSearch}
        debouncedSearch={debouncedSearch}
        sessionStorageReady={sessionStorageReady}
        historyListRef={historyListRef}
        runtimeBySession={runtimeBySession}
        pendingApprovalsBySession={pendingApprovalsBySession}
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        allPresets={ALL_PRESETS}
        addLog={addLog}
        getModelDisplayName={getModelDisplayName}
        switchSidebarMode={switchSidebarMode}
        createNewSession={createNewSession}
        setCurrentSessionId={setCurrentSessionId}
        setSessions={setSessions}
        deleteSession={deleteSession}
        moveSessionInList={moveSessionInList}
        setToolStatsDialog={setToolStatsDialog}
        setSettingsTab={setSettingsTab}
        setSettingsOpen={setSettingsOpen}
        setSessionSettingsOpen={setSessionSettingsOpen}
      />

      {/* Sidebar resize handle */}
      <div
        className={`resize-divider ${draggingSidebar ? "dragging" : ""}`}
        onMouseDown={handleSidebarDrag}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("ui.resize-conversation-sidebar", lang)}
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
          <ChatHeader
            lang={lang}
            config={config}
            setConfig={setConfig}
            currentSession={currentSession}
            effectiveWorkDir={effectiveWorkDir}
            sessionSaveStatus={sessionSaveStatus}
            sessionSettingsOpen={sessionSettingsOpen}
            setSessionSettingsOpen={setSessionSettingsOpen}
            sessionSettingsToggleRef={sessionSettingsToggleRef}
            rightPanelOpen={rightPanelOpen}
            setRightPanelOpen={setRightPanelOpen}
          />

          {/* Session Settings Panel */}
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
            />
          )}

          <ChatMessageList
            lang={lang}
            config={config}
            setConfig={setConfig}
            currentSession={currentSession}
            sessionMutationLocked={sessionMutationLocked}
            editingMessageIdx={editingMessageIdx}
            setEditingMessageIdx={setEditingMessageIdx}
            editText={editText}
            setEditText={setEditText}
            expandedActions={expandedActions}
            toggleActionExpanded={toggleActionExpanded}
            statusLabel={statusLabel}
            formatTokenCount={formatTokenCount}
            getModelDisplayName={getModelDisplayName}
            handleRetry={handleRetry}
            handleEditBranch={handleEditBranch}
            attachments={attachments}
            resolvedCurrentConfig={resolvedCurrentConfig}
            models={models}
            modelCatalogSourceKey={modelCatalogSourceKey}
            setPrompt={setPrompt}
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
            allPresets={ALL_PRESETS}
            customPresets={customPresets}
            setCustomPresets={setCustomPresets}
            rolePresetsOpen={rolePresetsOpen}
            setRolePresetsOpen={setRolePresetsOpen}
            modelPickerOpen={modelPickerOpen}
            setModelPickerOpen={setModelPickerOpen}
            customPresetForm={customPresetForm}
            setCustomPresetForm={setCustomPresetForm}
            editingCustomPreset={editingCustomPreset}
            setEditingCustomPreset={setEditingCustomPreset}
            setSidebarNav={setSidebarNav}
            getModelDisplayName={getModelDisplayName}
            cacheModelDisplayName={cacheModelDisplayName}
            modelsForCurrentConfig={modelsForCurrentConfig}
          />
        </section>

        {/* Right panel resize handle */}
        {rightPanelOpen && (
          <div
            className={`resize-divider ${draggingRight ? "dragging" : ""}`}
            onMouseDown={handleRightDrag}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("ui.resize-workspace-panel", lang)}
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
            aria-label={t("ui.close-workspace-panel", lang)}
            onClick={() => setRightPanelOpen(false)}
          />
        )}

        {/* RIGHT: Workspace */}
        <WorkspacePanel
          lang={lang}
          config={config}
          currentSession={currentSession}
          currentSessionId={currentSessionId}
          rightPanelOpen={rightPanelOpen}
          rightPanelWidth={rightPanelWidth}
          setRightPanelOpen={setRightPanelOpen}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          terminalLogs={terminalLogs}
          statusLabel={statusLabel}
          currentWorkspace={currentWorkspace}
          refreshWorkspace={refreshWorkspace}
          selectWorkspaceFile={selectWorkspaceFile}
          attachWorkspaceFile={attachWorkspaceFile}
          isAttachmentLoading={isAttachmentLoading}
          selectGitEntry={selectGitEntry}
          restoreGitEntry={restoreGitEntry}
          checkpointBySession={checkpointBySession}
          acceptRunCheckpoint={acceptRunCheckpoint}
          restoreRunCheckpoint={restoreRunCheckpoint}
          sessionMutationLocked={sessionMutationLocked}
          selectedFile={selectedFile}
          fileContent={fileContent}
          modifiedFiles={modifiedFiles}
          diffView={diffView}
          setDiffView={setDiffView}
          previewSrc={previewSrc}
          setPreviewSrc={setPreviewSrc}
          previewDevice={previewDevice}
          setPreviewDevice={setPreviewDevice}
          previewConsoleLogs={previewConsoleLogs}
          setPreviewConsoleLogs={setPreviewConsoleLogs}
        />
      </div>

      {/* ====== Settings Modal ====== */}
      {settingsOpen && (
        <SettingsModal
          lang={lang}
          config={config}
          setConfig={setConfig}
          models={modelsForGlobalConfig}
          setModels={(list) => {
            setModels(list);
            setModelCatalogSourceKey(modelCatalogKey(config));
          }}
          modelsLoading={modelsLoading}
          settingsTab={settingsTab}
          setSettingsTab={setSettingsTab}
          setSettingsOpen={setSettingsOpen}
          settingsBodyRef={settingsBodyRef}
          handleSettingsTabKeyDown={handleSettingsTabKeyDown}
          currentSettingsTabLabel={currentSettingsTabLabel}
          newProfileName={newProfileName}
          setNewProfileName={setNewProfileName}
          handleSaveProfile={handleSaveProfile}
          handleActivateProfile={handleActivateProfile}
          handleClearActiveProfile={handleClearActiveProfile}
          handleDeleteProfile={handleDeleteProfile}
          fetchModelList={fetchModelList}
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
          applyPreset={applyPreset}
          sessionMutationLocked={sessionMutationLocked}
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
        profiles={Object.entries(config.profiles).map(([id, profile]) => ({ ...profile, id }))}
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
