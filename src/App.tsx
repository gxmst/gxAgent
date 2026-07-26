import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BarChart3,
} from "lucide-react";
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
import { parseCommand, sessionToMarkdown } from "./utils/helpers";
import { useGlobalHotkeys } from "./components/shared/CommandSuggestions";
import { exportAllSessions, importSessions, getToolStats } from "./utils/sessionHelpers";
import { ContextMenu, useContextMenu } from "./components/shared/ContextMenu";
import { useSessionStorage } from "./hooks/useSessionStorage";
import { resolveRequestConfig } from "./utils/requestConfig";
import { compareSidebarSessions, moveSessionInSidebar } from "./utils/sessionOrder";
import type { DirectoryNode } from "./components/workspace/WorkspaceTree";
import type { GitStatusEntry } from "./components/workspace/WorkspaceChanges";
import { SettingsModal } from "./components/settings/SettingsModal";
import { SessionSettingsPanel } from "./components/settings/SessionSettingsPanel";
import { Sidebar } from "./components/sidebar/Sidebar";
import { WorkspacePanel } from "./components/workspace/WorkspacePanel";
import { ConfirmDialog, type ConfirmationOptions } from "./components/shared/ConfirmDialog";
import { t } from "./i18n";
import { fallbackSessionTitle } from "./utils/sessionTitle";
import { ChatMessageList } from "./components/chat/ChatMessageList";
import { Composer } from "./components/chat/Composer";
import { ChatHeader } from "./components/chat/ChatHeader";
import {
  OnboardingWizard,
  type ConnectionCheck,
  type OnboardingValues,
} from "./components/onboarding/OnboardingWizard";

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
  Message,
  Attachment,
  ContextSummary
} from "./types";

import {
  newMessageId,
  createEmptyWorkspaceState,
  resolveWorkspacePath,
  estimateTextTokens,
  isSendableAttachment,
  MAX_ATTACHMENT_TEXT_PER_FILE,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_COUNT,
  MAX_IMAGE_ATTACHMENT_TOTAL_BYTES,
  estimateImageAttachmentBytes,
  fitAttachmentBudget,
  omitSessionKey,
  DEFAULT_CONFIG,
  createDefaultSession,
  createSession,
  normalizeSessions,
  TOOL_NAMES,
  FONT_OPTIONS,
  themeMode,
  modelCatalogForConfig,
  modelCatalogKey,
  modelContextLimitForConfig,
  type ToolStatsDialog,
  type RunCheckpoint,
} from "./appDefaults";

import { useAppStore } from "./store/appStore";
import { runtime, uiCallbacks } from "./services/agentRuntime";
import {
  addLog,
  notify,
  finishStreamingLocally,
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
  const onboardingInitializedRef = useRef(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingConnection, setOnboardingConnection] = useState<ConnectionCheck>({ state: "idle" });
  const [onboardingValues, setOnboardingValues] = useState<OnboardingValues>({
    mode: "chat",
    profileId: null,
    provider: DEFAULT_CONFIG.provider,
    wireFormat: DEFAULT_CONFIG.wire_format,
    baseUrl: DEFAULT_CONFIG.base_url,
    apiKey: DEFAULT_CONFIG.api_key,
    model: DEFAULT_CONFIG.model,
    workDir: DEFAULT_CONFIG.default_work_dir,
  });
  const onboardingValuesRef = useRef(onboardingValues);
  const onboardingTestSequenceRef = useRef(0);
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

  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, Attachment[]>>({});
  const attachments = attachmentsBySession[currentSessionId] || [];
  const [attachmentLoadingBySession, setAttachmentLoadingBySession] = useState<Record<string, boolean>>({});
  const isAttachmentLoading = Boolean(attachmentLoadingBySession[currentSessionId]);
  const hasAttachmentLoading = Object.values(attachmentLoadingBySession).some(Boolean);
  const setAttachments = useCallback((next: Attachment[] | ((previous: Attachment[]) => Attachment[])) => {
    setAttachmentsBySession((previous) => {
      const current = previous[currentSessionId] || [];
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
  const setMcpStatusByName = useAppStore((s) => s.setMcpStatusByName);

  const activeRunSessionId = useAppStore((s) => s.activeRunSessionId);
  const setActiveRunSessionId = useAppStore((s) => s.setActiveRunSessionId);
  const preparingRequestSessionId = useAppStore((s) => s.preparingRequestSessionId);
  const setPreparingRequestSessionId = useAppStore((s) => s.setPreparingRequestSessionId);
  const runtimeBySession = useAppStore((s) => s.runtimeBySession);
  const setRuntimeBySession = useAppStore((s) => s.setRuntimeBySession);
  const checkpointBySession = useAppStore((s) => s.checkpointBySession);
  const setCheckpointBySession = useAppStore((s) => s.setCheckpointBySession);
  const isStreaming = activeRunSessionId === currentSessionId;
  const hasActiveRequest = activeRunSessionId !== null;
  const hasPendingRequest = hasActiveRequest || preparingRequestSessionId !== null;
  const currentRuntime = runtimeBySession[currentSessionId] || null;
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
  const toasts = useAppStore((s) => s.toasts);
  const setToasts = useAppStore((s) => s.setToasts);
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
  const searchMode = currentSession.sessionConfig.searchMode || "auto";
  const webSearchAvailable = config.tools_enabled.includes("web_search");
  const effectiveSearchMode = webSearchAvailable ? searchMode : "off";
  const resolvedCurrentConfig = useMemo(
    () => resolveRequestConfig(config, currentSession.sessionConfig, effectiveSearchMode),
    [config, currentSession.sessionConfig, effectiveSearchMode],
  );
  const modelsForCurrentConfig = modelCatalogForConfig(models, modelCatalogSourceKey, resolvedCurrentConfig);
  const modelsForGlobalConfig = modelCatalogForConfig(models, modelCatalogSourceKey, config);
  const modelsForOnboarding = modelCatalogForConfig(models, modelCatalogSourceKey, {
    wire_format: onboardingValues.wireFormat,
    base_url: onboardingValues.baseUrl,
  });
  const effectiveWorkDir = resolvedCurrentConfig.default_work_dir;
  const currentWorkspace = workspaceBySession[currentSessionId] || createEmptyWorkspaceState();

  useEffect(() => {
    if (!configReady || onboardingInitializedRef.current) return;
    onboardingInitializedRef.current = true;

    const initialOnboardingValues: OnboardingValues = {
      mode: currentMode,
      profileId: currentSession.sessionConfig.profileId,
      provider: resolvedCurrentConfig.provider,
      wireFormat: resolvedCurrentConfig.wire_format,
      baseUrl: resolvedCurrentConfig.base_url,
      apiKey: resolvedCurrentConfig.api_key,
      model: resolvedCurrentConfig.model,
      workDir: effectiveWorkDir,
    };
    onboardingValuesRef.current = initialOnboardingValues;
    setOnboardingValues(initialOnboardingValues);

    let onboardingHandled = false;
    try {
      onboardingHandled = localStorage.getItem("gx_onboarding_v1") === "complete"
        || sessionStorage.getItem("gx_onboarding_v1_dismissed") === "true";
    } catch { /* ignore unavailable local storage */ }

    const customConnection = config.base_url !== DEFAULT_CONFIG.base_url
      || config.model !== DEFAULT_CONFIG.model;
    const existingSetup = Object.keys(config.profiles).length > 0
      || config.provider === "ollama"
      || Boolean(config.api_key.trim())
      || customConnection;

    if (existingSetup && !onboardingHandled) {
      try { localStorage.setItem("gx_onboarding_v1", "complete"); } catch { /* ignore */ }
    }
    setOnboardingOpen(!existingSetup && !onboardingHandled);
  }, [configReady, config, currentMode, currentSession.sessionConfig.profileId, effectiveWorkDir, resolvedCurrentConfig]);

  const createRequestId = () => `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

  const formatTokenCount = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);

  const imageExtensionFromMime = (mimeType: string) => {
    const subtype = mimeType.split("/")[1]?.split(";")[0]?.toLowerCase();
    if (!subtype) return "png";
    return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/g, "") || "png";
  };

  const pastedImageName = (mimeType: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `pasted-image-${stamp}.${imageExtensionFromMime(mimeType)}`;
  };

  const readFileAsAttachment = async (file: File): Promise<Attachment> => {
    const name = file.name || (file.type.startsWith("image/") ? pastedImageName(file.type || "image/png") : "pasted-file.txt");
    if (file.type.startsWith("image/")) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error(t("ui.image-too-large", lang, { name }));
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => resolve(String(ev.target?.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
        reader.readAsDataURL(file);
      });
      return { name, type: "image", data, mimeType: file.type || "image/png", originalSize: file.size };
    }

    const extension = name.split(".").pop()?.toLowerCase() || "";
    const nativeDocuments = ["pdf", "docx", "xlsx", "pptx"];
    if (nativeDocuments.includes(extension)) {
      throw new Error(t("ui.binary-document", lang, { name }));
    }
    if (["doc", "xls", "ppt", "zip", "7z"].includes(extension)) {
      throw new Error(t("ui.unsupported-format", lang, { name }));
    }

    const textSlice = file.slice(0, MAX_ATTACHMENT_TEXT_PER_FILE * 4);
    const text = await textSlice.text();
    const data = text.substring(0, MAX_ATTACHMENT_TEXT_PER_FILE);
    return {
      name,
      type: "text",
      data,
      mimeType: file.type || "text/plain",
      truncated: file.size > textSlice.size || data.length < text.length,
      originalSize: file.size,
    };
  };

  const reportAttachmentFit = (
    fitted: ReturnType<typeof fitAttachmentBudget>,
    sessionId: string,
    warnedNames: Set<string> = new Set(),
  ) => {
    const unexplainedInvalid = fitted.invalid.filter((name) => !warnedNames.has(name));
    if (unexplainedInvalid.length > 0) {
      addLog(t("ui.nothing-sendable-not-added", lang, { names: unexplainedInvalid.join(lang === "zh" ? "、" : ", ") }), "error", true, sessionId);
    }
    if (fitted.overBudget.length > 0) {
      addLog(t("ui.attachment-limits-exceeded", lang, { names: fitted.overBudget.join(lang === "zh" ? "、" : ", ") }), "error", true, sessionId);
    }
  };

  const addFilesAsAttachments = async (files: File[], targetSessionId = currentSessionId) => {
    if (!sessionStorageReady || files.length === 0 || attachmentLoadingBySession[targetSessionId]) return;
    setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: true }));
    try {
      const existingAttachments = attachmentsBySession[targetSessionId] || [];
      let plannedImageCount = existingAttachments.filter((attachment) => attachment.type === "image" && isSendableAttachment(attachment)).length;
      let plannedImageBytes = existingAttachments
        .filter((attachment) => attachment.type === "image" && isSendableAttachment(attachment))
        .reduce((sum, attachment) => sum + estimateImageAttachmentBytes(attachment), 0);
      const preRejectedImages: string[] = [];
      const filesToRead = files.filter((file) => {
        if (!file.type.startsWith("image/")) return true;
        if (file.size > MAX_IMAGE_ATTACHMENT_BYTES
          || plannedImageCount >= MAX_IMAGE_ATTACHMENT_COUNT
          || plannedImageBytes + file.size > MAX_IMAGE_ATTACHMENT_TOTAL_BYTES) {
          preRejectedImages.push(file.name || pastedImageName(file.type || "image/png"));
          return false;
        }
        plannedImageCount += 1;
        plannedImageBytes += file.size;
        return true;
      });
      const results = await Promise.allSettled(filesToRead.map(readFileAsAttachment));
      const next = results
        .filter((result): result is PromiseFulfilledResult<Attachment> => result.status === "fulfilled")
        .map((result) => result.value);
      const fitted = fitAttachmentBudget(existingAttachments, next);
      fitted.overBudget.push(...preRejectedImages);
      if (fitted.accepted.length > 0) {
        setAttachmentsBySession((previous) => ({
          ...previous,
          [targetSessionId]: [...(previous[targetSessionId] || []), ...fitted.accepted],
        }));
      }
      reportAttachmentFit(fitted, targetSessionId);
      for (const result of results) {
        if (result.status === "rejected") {
          addLog(`${t("ui.failed-to-attach-file", lang)}: ${result.reason}`, "error", true, targetSessionId);
        }
      }
    } finally {
      setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: false }));
    }
  };

  const pickAndParseAttachments = async () => {
    type ParsedFile = {
      name: string;
      path: string;
      kind: string;
      content: string;
      mimeType: string;
      truncated: boolean;
      warning?: string | null;
    };
    const targetSessionId = currentSessionId;
    if (!sessionStorageReady || attachmentLoadingBySession[targetSessionId]) return;
    setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: true }));
    try {
      const parsed = await invoke<ParsedFile[]>("pick_and_parse_files");
      const next: Attachment[] = parsed.map((file) => {
        if (file.kind === "image") {
          return {
            name: file.name,
            path: file.path,
            type: "image",
            data: file.content ? `data:${file.mimeType};base64,${file.content}` : "",
            mimeType: file.mimeType,
            originalSize: Math.max(0, Math.floor(file.content.length * 3 / 4)),
            warning: file.warning || undefined,
          };
        }
        const data = file.content.slice(0, MAX_ATTACHMENT_TEXT_PER_FILE);
        const emptyWarning = !file.warning && !data.trim()
          ? (t("ui.no-sendable-text-was-extracted", lang))
          : undefined;
        return {
          name: file.name,
          path: file.path,
          type: "text",
          data,
          mimeType: file.mimeType,
          originalSize: file.content.length,
          truncated: file.truncated || data.length < file.content.length,
          warning: file.warning || emptyWarning,
        };
      });
      const fitted = fitAttachmentBudget(attachmentsBySession[targetSessionId] || [], next);
      if (fitted.accepted.length > 0) {
        setAttachmentsBySession((previous) => ({
          ...previous,
          [targetSessionId]: [...(previous[targetSessionId] || []), ...fitted.accepted],
        }));
      }
      const warnedNames = new Set(next.filter((file) => file.warning).map((file) => file.name));
      for (const file of next) {
        if (file.warning) addLog(`${file.name}: ${file.warning}`, "error", true, targetSessionId);
        else if (file.truncated) addLog(`${file.name}: ${t("ui.content-was-truncated", lang)}`, "info", true, targetSessionId);
      }
      reportAttachmentFit(fitted, targetSessionId, warnedNames);
    } catch (error) {
      addLog(`${t("ui.failed-to-attach-files", lang)}: ${error}`, "error", true, targetSessionId);
    } finally {
      setAttachmentLoadingBySession((previous) => ({ ...previous, [targetSessionId]: false }));
    }
  };

  const imageAttachmentsForApi = (list: Attachment[]) =>
    list.filter((att) => att.type === "image" && att.data);

  const buildPromptWithAttachments = (message: string, list: Attachment[]) => {
    const usable = list.filter(isSendableAttachment);
    if (usable.length === 0) return message;
    const parts = usable.map((att) => {
      if (att.type === "image") {
        return `[Attached Image: ${att.name}]`;
      }
      const longestFence = Math.max(2, ...(att.data.match(/`+/g) || []).map((run) => run.length));
      const fence = "`".repeat(longestFence + 1);
      return `[Attached File: ${att.name}]\n${fence}\n${att.data}\n${fence}`;
    });
    const trimmed = message.trim();
    return trimmed ? `${parts.join("\n\n")}\n\n${trimmed}` : parts.join("\n\n");
  };

  const serializeMessageForApi = (message: Message) => {
    if (!["user", "assistant", "system"].includes(message.role)) return null;
    const imgs = imageAttachmentsForApi(message.attachments || []);
    const rawContent = message.variants
      ? (message.variants[message.currentVariantIndex || 0] || message.content)
      : message.content;
    const content = message.role === "user"
      ? buildPromptWithAttachments(rawContent, message.attachments || [])
      : rawContent;
    if (message.role === "assistant" && !content.trim()) return null;
    return {
      role: message.role,
      content,
      ...(message.role === "user" && imgs.length > 0 ? { attachments: imgs } : {}),
    };
  };

  const selectWorkspaceFile = async (node: DirectoryNode) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    const sequence = (runtime.fileRequestSequence[sessionId] || 0) + 1;
    runtime.fileRequestSequence[sessionId] = sequence;
    setSelectedFile(node.path);
    setFileContent(null);
    try {
      const content = await invoke<string>("read_file_content", { path: node.path, workDir });
      if (useAppStore.getState().currentSessionId !== sessionId
        || runtime.effectiveWorkDir !== workDir
        || runtime.fileRequestSequence[sessionId] !== sequence) return;
      setSelectedFile(node.path);
      setFileContent(content);
    } catch (error) {
      addLog(`Failed to read file: ${error}`, "error", true, sessionId);
    }
  };

  const attachWorkspaceFile = async (node: DirectoryNode) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    if (attachmentLoadingBySession[sessionId] || sessionMutationLocked) {
      notify(t("ui.wait-for-attachment-processing-or", lang), "info");
      return;
    }
    setAttachmentLoadingBySession((previous) => ({ ...previous, [sessionId]: true }));
    try {
      const content = await invoke<string>("read_file_content", { path: node.path, workDir });
      const data = content.slice(0, MAX_ATTACHMENT_TEXT_PER_FILE);
      const fitted = fitAttachmentBudget(attachmentsBySession[sessionId] || [], [{
        name: node.name,
        path: node.path,
        type: "text",
        data,
        mimeType: "text/plain",
        truncated: data.length < content.length,
        originalSize: content.length,
      }]);
      if (fitted.accepted.length > 0) {
        setAttachmentsBySession((previous) => ({
          ...previous,
          [sessionId]: [...(previous[sessionId] || []), ...fitted.accepted],
        }));
      }
      reportAttachmentFit(fitted, sessionId);
    } catch (error) {
      addLog(`Failed to attach file: ${error}`, "error", true, sessionId);
    } finally {
      setAttachmentLoadingBySession((previous) => ({ ...previous, [sessionId]: false }));
    }
  };

  const selectGitEntry = async (entry: GitStatusEntry) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    setWorkspaceBySession((previous) => ({
      ...previous,
      [sessionId]: { ...(previous[sessionId] || currentWorkspace), selectedPath: entry.path, diff: "" },
    }));
    try {
      const hasStaged = Boolean(entry.indexStatus.trim() && entry.indexStatus !== "?");
      const hasWorktree = Boolean(entry.worktreeStatus.trim()) || entry.worktreeStatus === "?";
      const [stagedResult, worktreeResult] = await Promise.all([
        hasStaged
          ? invoke<string>("get_git_diff", { workDir, path: entry.path, staged: true })
          : Promise.resolve(""),
        hasWorktree
          ? invoke<string>("get_git_diff", { workDir, path: entry.path, staged: false })
          : Promise.resolve(""),
      ]);
      const sections = [
        stagedResult ? `${t("ui.staged", lang)}\n${stagedResult}` : "",
        worktreeResult ? `${t("ui.worktree", lang)}\n${worktreeResult}` : "",
      ].filter(Boolean);
      const diff = sections.join("\n\n") || (t("ui.no-textual-diff-to-display", lang));
      setWorkspaceBySession((previous) => {
        if (previous[sessionId]?.workDir !== workDir
          || previous[sessionId]?.selectedPath !== entry.path) return previous;
        return {
          ...previous,
          [sessionId]: { ...previous[sessionId], diff },
        };
      });
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const restoreGitEntry = async (entry: GitStatusEntry) => {
    const sessionId = currentSessionId;
    const workDir = effectiveWorkDir;
    const repositoryRoot = currentWorkspace.repositoryRoot || workDir;
    if (sessionMutationLocked) {
      notify(t("ui.files-cannot-be-restored-while", lang), "error");
      return;
    }
    if (!await requestConfirmation({
      title: t("ui.restore-file-title", lang),
      message: t("ui.confirm-restore-file", lang, { path: entry.path }),
      confirmLabel: t("ui.restore", lang),
      cancelLabel: t("ui.cancel", lang),
      danger: true,
    })) return;
    try {
      if (entry.indexStatus.trim() && entry.indexStatus !== "?") {
        await invoke("restore_git_path", { workDir, path: entry.path, staged: true });
      }
      await invoke("restore_git_path", { workDir, path: entry.path, staged: false });
      if (entry.originalPath && entry.originalPath !== entry.path) {
        await invoke("restore_git_path", { workDir, path: entry.originalPath, staged: false });
      }
      if (useAppStore.getState().currentSessionId === sessionId && runtime.effectiveWorkDir === workDir) {
        runtime.fileRequestSequence[sessionId] = (runtime.fileRequestSequence[sessionId] || 0) + 1;
        setFileContent(null);
        setSelectedFile(null);
        setDiffView(false);
      }
      const restoredKeys = new Set([
        resolveWorkspacePath(repositoryRoot, entry.path),
        ...(entry.originalPath ? [resolveWorkspacePath(repositoryRoot, entry.originalPath)] : []),
      ]);
      setModifiedFilesBySession((previous) => {
        const nextFiles = { ...(previous[sessionId] || {}) };
        for (const key of restoredKeys) delete nextFiles[key];
        return { ...previous, [sessionId]: nextFiles };
      });
      if (/\.(html?|svg)$/i.test(entry.path)) {
        setPreviewBySession((previous) => ({ ...previous, [sessionId]: "" }));
      }
      if (useAppStore.getState().currentSessionId === sessionId && runtime.effectiveWorkDir === workDir) {
        await refreshWorkspace(sessionId, workDir);
      }
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const restoreRunCheckpoint = async () => {
    const sessionId = currentSessionId;
    const checkpoint = checkpointBySession[sessionId];
    if (!checkpoint) return;
    if (sessionMutationLocked) {
      notify(t("ui.stop-the-current-task-before", lang), "error");
      return;
    }
    if (!await requestConfirmation({
      title: t("ui.restore-checkpoint-title", lang),
      message: t("ui.confirm-restore-checkpoint", lang, { dir: checkpoint.workDir }),
      confirmLabel: t("ui.restore", lang),
      cancelLabel: t("ui.cancel", lang),
      danger: true,
    })) return;
    try {
      await invoke("restore_git_checkpoint", { workDir: checkpoint.workDir, commit: checkpoint.commit });
      if (useAppStore.getState().currentSessionId === sessionId && runtime.effectiveWorkDir === checkpoint.workDir) {
        runtime.fileRequestSequence[sessionId] = (runtime.fileRequestSequence[sessionId] || 0) + 1;
        setFileContent(null);
        setSelectedFile(null);
        setDiffView(false);
      }
      setModifiedFilesBySession((previous) => ({ ...previous, [sessionId]: {} }));
      setPreviewBySession((previous) => ({ ...previous, [sessionId]: "" }));
      if (runtime.effectiveWorkDir === checkpoint.workDir) {
        await refreshWorkspace(sessionId, checkpoint.workDir);
      }
      await invoke("delete_git_checkpoint", { workDir: checkpoint.workDir, reference: checkpoint.reference });
      setCheckpointBySession((previous) => ({ ...previous, [sessionId]: null }));
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const acceptRunCheckpoint = async () => {
    const sessionId = currentSessionId;
    const checkpoint = checkpointBySession[sessionId];
    if (!checkpoint) return;
    if (sessionMutationLocked) {
      notify(t("ui.run-changes-can-be-kept", lang), "error");
      return;
    }
    try {
      await invoke("delete_git_checkpoint", { workDir: checkpoint.workDir, reference: checkpoint.reference });
      setCheckpointBySession((previous) => ({ ...previous, [sessionId]: null }));
      notify(t("ui.run-changes-kept", lang), "success");
    } catch (error) {
      addLog(String(error), "error", true, sessionId);
    }
  };

  const updateOnboardingValues = (patch: Partial<OnboardingValues>) => {
    const next = { ...onboardingValuesRef.current, ...patch };
    onboardingValuesRef.current = next;
    setOnboardingValues(next);
    onboardingTestSequenceRef.current += 1;
    const connectionChanged = ["profileId", "provider", "wireFormat", "baseUrl", "apiKey", "model"]
      .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
    if (connectionChanged || onboardingConnection.state === "testing") {
      setOnboardingConnection({ state: "idle" });
    }
  };

  const pickOnboardingWorkspace = async () => {
    try {
      const selected = await invoke<string | null>("pick_workspace_directory");
      if (selected) updateOnboardingValues({ workDir: selected });
    } catch (error) {
      notify(`${t("ui.could-not-open-the-folder", lang)}: ${error}`, "error");
    }
  };

  const testOnboardingConnection = async () => {
    const sequence = onboardingTestSequenceRef.current + 1;
    onboardingTestSequenceRef.current = sequence;
    const snapshot = onboardingValuesRef.current;
    setOnboardingConnection({ state: "testing" });
    try {
      const list = snapshot.wireFormat === "ollama"
        ? await invoke<ModelInfo[]>("fetch_ollama_models", { baseUrl: snapshot.baseUrl })
        : await invoke<ModelInfo[]>("fetch_models", {
            wireFormat: snapshot.wireFormat,
            baseUrl: snapshot.baseUrl,
            apiKey: snapshot.apiKey,
          });
      if (onboardingTestSequenceRef.current !== sequence || onboardingValuesRef.current !== snapshot) return;
      setModels(list);
      setModelCatalogSourceKey(modelCatalogKey({
        wire_format: snapshot.wireFormat,
        base_url: snapshot.baseUrl,
      }));
      const selectedModelExists = list.length === 0
        || list.some((model) => model.id === snapshot.model);
      if (!selectedModelExists) {
        setOnboardingConnection({
          state: "error",
          message: t("ui.model-not-in-list", lang, { model: snapshot.model }),
        });
        return;
      }
      setOnboardingConnection({
        state: "success",
        message: list.length > 0
          ? t("ui.endpoint-found-models", lang, { count: String(list.length) })
          : (t("ui.endpoint-ready-the-model-list", lang)),
      });
    } catch (error) {
      if (onboardingTestSequenceRef.current !== sequence || onboardingValuesRef.current !== snapshot) return;
      setOnboardingConnection({ state: "error", message: String(error) });
    }
  };

  const completeOnboarding = async () => {
    if (onboardingConnection.state !== "success") return;
    try {
      if (onboardingValues.mode === "code") {
        await invoke("validate_workspace", { path: onboardingValues.workDir, create: false });
      }

      const nextConfig: AppConfig = {
        ...config,
        provider: onboardingValues.provider,
        wire_format: onboardingValues.wireFormat,
        base_url: onboardingValues.baseUrl.trim(),
        api_key: onboardingValues.apiKey.trim(),
        model: onboardingValues.model.trim(),
        active_profile: onboardingValues.profileId,
        default_work_dir: onboardingValues.mode === "code"
          ? onboardingValues.workDir.trim()
          : config.default_work_dir,
      };
      await invoke("save_config", { config: nextConfig });
      lastSavedConfigRef.current = JSON.stringify(nextConfig);
      setConfig(nextConfig);
      patchSessionConfig({ mode: onboardingValues.mode, profileId: onboardingValues.profileId, model: null, workDir: onboardingValues.mode === "code" ? onboardingValues.workDir.trim() : null });
      setSidebarNav(onboardingValues.mode);
      try { localStorage.setItem("gx_onboarding_v1", "complete"); } catch { /* ignore */ }
      try { sessionStorage.removeItem("gx_onboarding_v1_dismissed"); } catch { /* ignore */ }
      setOnboardingOpen(false);
      notify(t("ui.setup-saved", lang), "success");
    } catch (error) {
      notify(`${t("ui.could-not-save-setup", lang)}: ${error}`, "error");
    }
  };

  const dismissOnboarding = () => {
    try { sessionStorage.setItem("gx_onboarding_v1_dismissed", "true"); } catch { /* ignore */ }
    setOnboardingOpen(false);
  };

  const fetchModelList = async () => {
    if (!config.base_url) return;
    const snapshot = {
      wire_format: config.wire_format || "openai",
      base_url: config.base_url,
      api_key: config.api_key,
    };
    setModelsLoading(true);
    try {
      // Ollama has a distinct models endpoint; route the shared "fetch models"
      // button to it so the button works regardless of the active wire format.
      const list = snapshot.wire_format === "ollama"
        ? await invoke<ModelInfo[]>("fetch_ollama_models", { baseUrl: snapshot.base_url })
        : await invoke<ModelInfo[]>("fetch_models", {
            wireFormat: snapshot.wire_format,
            baseUrl: snapshot.base_url,
            apiKey: snapshot.api_key,
          });
      setModels(list);
      setModelCatalogSourceKey(modelCatalogKey(snapshot));
      addLog(t("log.modelsFetched", lang, { count: String(list.length), url: snapshot.base_url }), "success");
    } catch (e) {
      addLog(t("log.modelsFailed", lang) + e, "error");
    } finally {
      setModelsLoading(false);
    }
  };

  const applyPreset = (preset: ProviderPreset) => {
    setConfig((prev) => ({
      ...prev,
      provider: preset.provider,
      wire_format: preset.wire_format || "openai",
      base_url: preset.base_url,
      model: preset.default_model || prev.model,
      api_key: preset.needs_api_key ? prev.api_key : "",
    }));
    setModels([]);
    setModelCatalogSourceKey(null);
  };

  const handleSaveProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    try {
      const updated = await invoke<AppConfig>("save_profile", {
        currentConfig: config,
        profile: { name, base_url: config.base_url, api_key: config.api_key, default_model: config.model, wire_format: config.wire_format || "openai", provider: config.provider || "openai" },
      });
      setConfig(updated);
      cacheModelDisplayName(config.model, name);
      setNewProfileName("");
      addLog(t("profile.saved", lang), "success");
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const getModelDisplayName = (modelId: string) => {
    if (config.active_profile) {
      const profile = config.profiles[config.active_profile];
      if (profile && profile.default_model === modelId) return profile.name;
    }
    const profile = Object.values(config.profiles).find(p => p.default_model === modelId);
    if (profile) return profile.name;
    const cached = localStorage.getItem("gx_model_display_names");
    if (cached) {
      try {
        const map: Record<string, string> = JSON.parse(cached);
        if (map[modelId]) return map[modelId];
      } catch { /* ignore */ }
    }
    return modelId;
  };

  const cacheModelDisplayName = (modelId: string, displayName: string) => {
    try {
      const cached = localStorage.getItem("gx_model_display_names");
      const map: Record<string, string> = cached ? JSON.parse(cached) : {};
      map[modelId] = displayName;
      localStorage.setItem("gx_model_display_names", JSON.stringify(map));
    } catch { /* ignore */ }
  };

  const handleActivateProfile = async (name: string) => {
    try {
      const updated = await invoke<AppConfig>("set_active_profile", { currentConfig: config, name });
      setConfig(updated);
      const profile = updated.profiles[name];
      if (profile) cacheModelDisplayName(profile.default_model, profile.name);
      addLog(t("profile.activated", lang) + name, "success");
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const handleDeleteProfile = async (name: string) => {
    try {
      const updated = await invoke<AppConfig>("delete_profile", { currentConfig: config, name });
      setConfig(updated);
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const handleClearActiveProfile = async () => {
    try {
      const updated = await invoke<AppConfig>("clear_active_profile", { currentConfig: config });
      setConfig(updated);
    } catch (e) {
      addLog(String(e), "error");
    }
  };

  const testMcpServer = async (name: string) => {
    const server = config.mcp_servers[name];
    if (!server) return;
    setMcpStatusByName((previous) => ({ ...previous, [name]: { state: "starting" } }));
    try {
      const result = await invoke<{
        status: "ready" | "error";
        toolCount: number;
        error?: string | null;
      }>("test_mcp_server", {
        name,
        command: server.command,
        args: server.args || [],
        env: server.env || {},
      });
      setMcpStatusByName((previous) => ({
        ...previous,
        [name]: {
          state: result.status === "ready" ? "ready" : "error",
          toolCount: result.toolCount,
          message: result.error || undefined,
        },
      }));
    } catch (error) {
      setMcpStatusByName((previous) => ({ ...previous, [name]: { state: "error", message: String(error) } }));
    }
  };

  const deleteMcpServer = async (name: string) => {
    try {
      const updated = await invoke<AppConfig>("delete_mcp_server", { currentConfig: config, name });
      setConfig(updated);
      setMcpStatusByName((previous) => {
        const next = { ...previous };
        delete next[name];
        return next;
      });
    } catch (error) {
      addLog(String(error), "error", true);
    }
  };

  const handleCompact = async () => {
    if (!sessionStorageReady || runtime.isStreaming || requestStartingRef.current) return;
    const sessionId = currentSession.id;
    const messages = currentSession.messages;
    if (messages.length < 3) {
      addLog(t("compact.tooShort", lang), "info");
      return;
    }
    if (requestNeedsApiKey(resolvedCurrentConfig)) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error", true, sessionId);
      return;
    }
    const requestId = `compact-${createRequestId()}`;
    runtime.activeRequestId = requestId;
    runtime.activeRequestSessionId = sessionId;
    runtime.requestSessionById[requestId] = sessionId;
    runtime.isStreaming = true;
    setActiveRunSessionId(sessionId);
    setRuntimeBySession((previous) => ({ ...previous, [sessionId]: { requestId, status: "running" } }));
    addLog(t("compact.start", lang), "info", false, sessionId);
    try {
      const result = await invoke<string>("compact_history", {
        currentConfig: resolvedCurrentConfig,
        requestId,
        contextTokenLimit: Math.min(
          modelContextLimitForConfig(resolvedCurrentConfig.model, models, modelCatalogSourceKey, resolvedCurrentConfig),
          resolvedCurrentConfig.context_limit,
        ),
        messages: messages.flatMap((message) => {
          const serialized = serializeMessageForApi(message);
          return serialized ? [{ role: serialized.role, content: serialized.content }] : [];
        }),
      });
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            compactBackup: messages,
            compactBackupContextSummary: s.contextSummary,
            messages: [
              { id: newMessageId(), role: "assistant" as const, content: result, actions: [], timestamp: Date.now() },
            ],
            contextSummary: undefined,
            updatedAt: Date.now(),
          };
        })
      );
      addLog(t("compact.done", lang), "success", false, sessionId);
    } catch (e) {
      const message = String(e);
      if (message.toLowerCase().includes("cancelled")) {
        addLog(t("ui.history-compaction-cancelled", lang), "info", false, sessionId);
      } else {
        addLog(t("compact.failed", lang) + message, "error", true, sessionId);
      }
    } finally {
      finishStreamingLocally(requestId);
    }
  };

  const undoCompact = () => {
    if (sessionMutationLocked || !currentSession.compactBackup) return;
    setSessions((previous) => previous.map((session) => session.id === currentSessionId ? {
      ...session,
      messages: session.compactBackup || session.messages,
      contextSummary: session.compactBackupContextSummary,
      compactBackup: undefined,
      compactBackupContextSummary: undefined,
      updatedAt: Date.now(),
    } : session));
    notify(t("ui.conversation-restored", lang), "success");
  };

  const saveConfig = async () => {
    setConfigSaveStatus("saving");
    try {
      await invoke("save_config", { config });
      lastSavedConfigRef.current = JSON.stringify(config);
      setConfigSaveStatus("saved");
      addLog(t("log.configSaved", lang), "success", true);
    } catch (e) {
      setConfigSaveStatus("error");
      addLog(t("log.configFailed", lang) + e, "error", true);
    }
  };

  // ==========================================
  // Actions
  // ==========================================

  // Outbound history is everything after the last context divider. Each
  // serialized message keeps a reference to its source so the auto-compact
  // boundary can be mapped back to a concrete message id.
  const activeHistoryPairs = (messages: Message[]) => {
    let lastDividerIdx = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "context_divider") {
        lastDividerIdx = index;
        break;
      }
    }
    return messages.slice(lastDividerIdx + 1).flatMap((message) => {
      const serialized = serializeMessageForApi(message);
      return serialized ? [{ serialized, source: message }] : [];
    });
  };

  const lastContextDivider = (messages: Message[]) =>
    [...messages].reverse().find((message) => message.role === "context_divider") ?? null;

  const summaryAsOutboundMessage = (summary: ContextSummary) => ({
    role: "user" as const,
    content: `${t("ui.summary-preamble", lang)}\n${summary.summary}`,
  });

  const resolveSessionRequest = (sessionConfig: SessionConfig) => {
    const sessionSearchMode = config.tools_enabled.includes("web_search")
      ? sessionConfig.searchMode
      : "off";
    return {
      requestConfig: resolveRequestConfig(config, sessionConfig, sessionSearchMode),
      searchMode: sessionSearchMode,
    };
  };

  const requestNeedsApiKey = (requestConfig: AppConfig) => (
    !requestConfig.api_key.trim()
    && requestConfig.provider !== "ollama"
    && (requestConfig.base_url.includes("deepseek") || requestConfig.base_url.includes("openai.com"))
  );

  const startAgentRequest = async ({
    targetSessionId,
    sessionConfig,
    history,
    userMessage,
    requestAttachments,
    label = "send",
    onAccepted,
    sessionSnapshot,
  }: {
    targetSessionId: string;
    sessionConfig: SessionConfig;
    history: Message[];
    userMessage: string;
    requestAttachments: Attachment[];
    label?: string;
    onAccepted?: () => void;
    sessionSnapshot?: ChatSession;
  }): Promise<boolean> => {
    if (!sessionStorageReady || runtime.isStreaming || requestStartingRef.current) return false;
    const { requestConfig, searchMode: requestSearchMode } = resolveSessionRequest(sessionConfig);
    if (requestNeedsApiKey(requestConfig)) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error", true, targetSessionId);
      return false;
    }

    const requestId = createRequestId();
    const finalMessage = buildPromptWithAttachments(userMessage, requestAttachments);
    const imageAttachments = imageAttachmentsForApi(requestAttachments);
    const instructionTokens = estimateTextTokens(requestConfig.system_prompt)
      + (requestConfig.role_prompt ? estimateTextTokens(requestConfig.role_prompt) + 24 : 0);
    const reportedModelLimit = modelContextLimitForConfig(
      requestConfig.model,
      models,
      modelCatalogSourceKey,
      requestConfig,
    );
    const requestContextLimit = Math.min(
      reportedModelLimit,
      Math.max(1_000, requestConfig.context_limit || reportedModelLimit),
    );
    requestConfig.context_limit = requestContextLimit;

    // Outbound history: messages after the last divider, with the persisted
    // rolling summary standing in for everything that divider hides. The
    // summary only applies while its own divider is still the latest one.
    const targetSession = sessions.find((session) => session.id === targetSessionId) || sessionSnapshot;
    const historyDivider = lastContextDivider(history);
    const activeSummary = targetSession?.contextSummary
      && historyDivider?.id === targetSession.contextSummary.dividerId
      ? targetSession.contextSummary
      : null;
    const outboundPairs = activeHistoryPairs(history);
    let sessionMessages = [
      ...(activeSummary ? [summaryAsOutboundMessage(activeSummary)] : []),
      ...outboundPairs.map((pair) => pair.serialized),
    ];
    const estimateOutboundTokens = (outbound: typeof sessionMessages) => outbound.reduce((sum, message) => (
      sum
      + estimateTextTokens(String(message.content || ""))
      + ((message as { attachments?: Attachment[] }).attachments || []).length * 1100
      + 6
    ), instructionTokens) + estimateTextTokens(finalMessage) + imageAttachments.length * 1100;
    let estimatedRequestTokens = estimateOutboundTokens(sessionMessages);

    requestStartingRef.current = true;
    setPreparingRequestSessionId(targetSessionId);
    const finishPreparingRequest = () => {
      requestStartingRef.current = false;
      setPreparingRequestSessionId((current) => current === targetSessionId ? null : current);
    };

    // Rolling auto-compact, Claude Code style: past half the model window,
    // fold everything but a recent tail into an LLM summary. The summary is
    // persisted on the session (keyed to a context divider), so it is paid
    // for once and rolls forward as the conversation keeps growing.
    const AUTO_COMPACT_TRIGGER_RATIO = 0.5;
    const AUTO_COMPACT_KEEP_TAIL = 8;
    if (
      estimatedRequestTokens > requestContextLimit * AUTO_COMPACT_TRIGGER_RATIO
      && sessionMessages.length > AUTO_COMPACT_KEEP_TAIL + 4
    ) {
      const cutOutbound = sessionMessages.length - AUTO_COMPACT_KEEP_TAIL;
      // Last source-backed message inside the folded range — the new divider
      // lands right after it. (Index shifts by one when a previous summary
      // occupies slot 0 of the outbound array.)
      const coveredPairs = outboundPairs.slice(0, cutOutbound - (activeSummary ? 1 : 0));
      const boundarySource = coveredPairs[coveredPairs.length - 1]?.source;
      if (boundarySource?.id) {
        addLog(
          t("ui.auto-compacting", lang, { tokens: formatTokenCount(estimatedRequestTokens), count: String(cutOutbound) }),
          "info",
          false,
          targetSessionId,
        );
        try {
          const summaryText = await invoke<string>("compact_history", {
            currentConfig: requestConfig,
            requestId: `autocompact-${requestId}`,
            contextTokenLimit: requestContextLimit,
            messages: sessionMessages.slice(0, cutOutbound).map((message) => ({
              role: message.role,
              content: message.content,
            })),
          });
          if (summaryText && summaryText.trim()) {
            const dividerId = newMessageId();
            const supersededDividerId = activeSummary ? targetSession?.contextSummary?.dividerId ?? null : null;
            const nextSummary: ContextSummary = {
              summary: summaryText.trim(),
              dividerId,
              createdAt: Date.now(),
            };
            if (sessionSnapshot && !sessions.some((session) => session.id === targetSessionId)) {
              const kept = sessionSnapshot.messages.filter((message) => message.id !== supersededDividerId);
              const boundaryIdx = kept.findIndex((message) => message.id === boundarySource.id);
              if (boundaryIdx >= 0) {
                sessionSnapshot.messages = [
                  ...kept.slice(0, boundaryIdx + 1),
                  { id: dividerId, role: "context_divider" as const, content: "" },
                  ...kept.slice(boundaryIdx + 1),
                ];
                sessionSnapshot.contextSummary = nextSummary;
                sessionSnapshot.updatedAt = Date.now();
              }
            }
            setSessions((previous) => previous.map((session) => {
              if (session.id !== targetSessionId) return session;
              const kept = session.messages.filter((message) => message.id !== supersededDividerId);
              const boundaryIdx = kept.findIndex((message) => message.id === boundarySource.id);
              if (boundaryIdx < 0) return session;
              const nextMessages = [
                ...kept.slice(0, boundaryIdx + 1),
                { id: dividerId, role: "context_divider" as const, content: "" },
                ...kept.slice(boundaryIdx + 1),
              ];
              return { ...session, messages: nextMessages, contextSummary: nextSummary, updatedAt: Date.now() };
            }));
            sessionMessages = [summaryAsOutboundMessage(nextSummary), ...sessionMessages.slice(cutOutbound)];
            estimatedRequestTokens = estimateOutboundTokens(sessionMessages);
            addLog(
              t("ui.compacted-summary", lang, { tokens: formatTokenCount(estimatedRequestTokens) }),
              "success",
              false,
              targetSessionId,
            );
          }
        } catch (error) {
          addLog(
            t("ui.auto-compact-failed", lang, { error: String(error) }),
            "error",
            false,
            targetSessionId,
          );
        }
      }
    }

    if (estimatedRequestTokens > requestContextLimit * 0.9) {
      finishPreparingRequest();
      addLog(
        t("ui.context-near-limit", lang, { tokens: formatTokenCount(estimatedRequestTokens), limit: formatTokenCount(requestContextLimit) }),
        "error",
        true,
        targetSessionId,
      );
      return false;
    }

    // Only consume the previous restore point after every pure validation has
    // passed. A rejected oversized request must not destroy the user's ability
    // to restore the last successful run.
    const previousCheckpoint = checkpointBySession[targetSessionId];
    if (previousCheckpoint) {
      try {
        await invoke("delete_git_checkpoint", {
          workDir: previousCheckpoint.workDir,
          reference: previousCheckpoint.reference,
        });
        setCheckpointBySession((previous) => ({ ...previous, [targetSessionId]: null }));
      } catch (error) {
        finishPreparingRequest();
        addLog(`${t("ui.could-not-accept-the-previous", lang)}: ${error}`, "error", true, targetSessionId);
        return false;
      }
    }

    try {
      onAccepted?.();
    } catch (error) {
      finishPreparingRequest();
      addLog(`${t("ui.could-not-start-request", lang)}: ${error}`, "error", true, targetSessionId);
      return false;
    }

    runtime.activeRequestId = requestId;
    runtime.activeRequestSessionId = targetSessionId;
    runtime.activeRequestModel = requestConfig.model;
    runtime.activeRequestWorkDir = requestConfig.default_work_dir;
    runtime.activeRequestContextTokens = estimatedRequestTokens;
    runtime.requestSessionById[requestId] = targetSessionId;
    runtime.isStreaming = true;
    setActiveRunSessionId(targetSessionId);
    setRuntimeBySession((previous) => ({
      ...previous,
      [targetSessionId]: { requestId, status: "running" },
    }));
    setPendingApprovalsBySession((previous) => ({ ...previous, [targetSessionId]: null }));
    setUsageStatsBySession((previous) => ({ ...previous, [targetSessionId]: null }));
    setCheckpointBySession((previous) => ({ ...previous, [targetSessionId]: null }));
    setModifiedFilesBySession((previous) => ({ ...previous, [targetSessionId]: {} }));
    finishPreparingRequest();

    addLog(
      `[Request:${label} ${requestId}] mode=${sessionConfig.mode} model=${requestConfig.model} history=${sessionMessages.length}`,
      "info",
      false,
      targetSessionId,
    );

    try {
      await invoke("start_agent_session", {
        requestId,
        prompt: finalMessage,
        config: requestConfig,
        sessionMessages,
        sessionMode: sessionConfig.mode,
        searchMode: requestSearchMode,
        imageAttachments,
      });
      if (runtime.activeRequestId === requestId) finishStreamingLocally(requestId);
      return true;
    } catch (error) {
      if (runtime.activeRequestId === requestId) finishStreamingLocally(requestId);
      addLog(`Agent error: ${error}`, "error", true, targetSessionId);
      setSessions((previous) => previous.map((session) => session.id === targetSessionId ? {
        ...session,
        messages: [
          ...session.messages,
          { id: newMessageId(), role: "assistant", content: `Error: ${error}`, actions: [], timestamp: Date.now() },
        ],
        updatedAt: Date.now(),
      } : session));
      return false;
    }
  };

  const createBranchSession = (source: ChatSession, messages: Message[]) => {
    const branch = createSession(
      source.sessionConfig.mode,
      `${source.title || t("session.new", lang)} ${t("ui.branch", lang)}`,
      messages,
    );
    branch.sessionConfig = { ...source.sessionConfig };
    branch.contextSummary = source.contextSummary
      && messages.some((message) => message.id === source.contextSummary?.dividerId)
      ? source.contextSummary
      : undefined;
    return branch;
  };

  const handleSendMessage = async () => {
    if (!sessionStorageReady) return;
    const sendableAttachments = fitAttachmentBudget([], attachments).accepted;
    if ((!prompt.trim() && sendableAttachments.length === 0) || runtime.isStreaming || requestStartingRef.current || isAttachmentLoading) return;

    // Quick commands using helper
    const { isCommand, command } = parseCommand(prompt.trim());
    if (isCommand && sendableAttachments.length === 0) {
      setPrompt("");

      if (command === "clear") {
        setSessions(prev => prev.map(s => s.id === currentSessionId ? {
          ...s,
          messages: [...s.messages, { id: newMessageId(), role: "context_divider" as const, content: "" }]
        } : s));
        return;
      }

      if (command === "compact") {
        await handleCompact();
        return;
      }

      if (command === "export") {
        const session = sessions.find(s => s.id === currentSessionId);
        if (session) {
          const md = sessionToMarkdown(session.title, session.messages);
          const blob = new Blob([md], { type: 'text/markdown' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${session.title}.md`;
          a.click();
          URL.revokeObjectURL(url);
          notify("已导出为 Markdown", "success");
        }
        return;
      }

      if (command === "help") {
        notify("快捷命令：/clear /compact /export /help", "info");
        return;
      }
    }

    const { requestConfig } = resolveSessionRequest(currentSession.sessionConfig);
    if (requestNeedsApiKey(requestConfig)) {
      setSettingsOpen(true);
      addLog(t("log.needApiKey", lang), "error", true, currentSessionId);
      return;
    }

    const targetSessionId = currentSessionId;
    const targetSession = currentSession;
    const userMessage = prompt.trim();
    const pendingAttachments = [...sendableAttachments];
    const shouldGenerateTitle = targetSession.messages.length === 0 && !targetSession.title.trim();
    const localTitle = fallbackSessionTitle(userMessage, pendingAttachments[0]?.name);
    await startAgentRequest({
      targetSessionId,
      sessionConfig: targetSession.sessionConfig,
      history: targetSession.messages,
      userMessage,
      requestAttachments: pendingAttachments,
      onAccepted: () => {
        if (shouldGenerateTitle) {
          runtime.pendingTitleBySession[targetSessionId] = {
            userMessage: userMessage || pendingAttachments.map((attachment) => attachment.name).join(", "),
            fallbackTitle: localTitle,
            config: requestConfig,
          };
        }
        setDraftsBySession((previous) => ({ ...previous, [targetSessionId]: "" }));
        setAttachmentsBySession((previous) => ({ ...previous, [targetSessionId]: [] }));
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== targetSessionId) return s;
            const title = s.messages.length === 0 && !s.title.trim() ? localTitle : s.title;
            return {
              ...s,
              title,
              messages: [
                ...s.messages,
                {
                  id: newMessageId(),
                  role: "user" as const,
                  content: userMessage,
                  attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
                  timestamp: Date.now(),
                },
              ],
              compactBackup: undefined,
              updatedAt: Date.now(),
            };
          })
        );
      },
    });
  };

  const handleStopStreaming = async () => {
    const requestId = runtime.activeRequestId;
    const sessionId = runtime.activeRequestSessionId;
    if (!requestId || !runtime.isStreaming || sessionId !== currentSessionId || currentRuntime?.status === "stopping") return;

    try {
      setRuntimeBySession((previous) => ({
        ...previous,
        [sessionId]: { requestId, status: "stopping" },
      }));
      await invoke("cancel_agent_session", { requestId });
      addLog(t("ui.stop-requested-for-current-output", lang), "info", false, sessionId);
    } catch (e) {
      addLog(`Stop request failed: ${e}`, "error", true, sessionId);
      if (runtime.activeRequestId === requestId) {
        setRuntimeBySession((previous) => ({
          ...previous,
          [sessionId]: { requestId, status: "running" },
        }));
      }
    }
  };

  const handleSteeringMessage = async () => {
    const message = prompt.trim();
    const sessionId = runtime.activeRequestSessionId;
    const requestId = runtime.activeRequestId;
    if (!message || !isStreaming || sessionId !== currentSessionId || !requestId || currentMode !== "code") return;
    try {
      await invoke("push_steering_message", { requestId, message });
      setSessions(prev => prev.map(s => s.id === sessionId ? {
        ...s,
        messages: [...s.messages, { id: newMessageId(), role: "user" as const, content: `[Steering] ${message}`, timestamp: Date.now() }],
        updatedAt: Date.now(),
      } : s));
      setPrompt("");
      addLog(t("ui.steering-message-sent", lang), "info", false, sessionId);
    } catch (e) {
      addLog(`Steering error: ${e}`, "error", true, sessionId);
    }
  };

  const handleRetry = async (msgIdx: number) => {
    if (!sessionStorageReady || runtime.isStreaming || requestStartingRef.current) return;
    const msgs = currentSession.messages;
    let userIndex = -1;
    for (let i = msgIdx; i >= 0; i--) {
      if (msgs[i].role === "user") {
        userIndex = i;
        break;
      }
    }
    if (userIndex < 0) return;
    const userMessage = msgs[userIndex];
    const userAttachments = [...(userMessage.attachments || [])];
    const userText = userMessage.content;
    if (!userText && userAttachments.length === 0) return;

    const branchMessages = msgs.slice(0, userIndex + 1).map((message) => ({ ...message }));
    const branch = createBranchSession(currentSession, branchMessages);

    await startAgentRequest({
      targetSessionId: branch.id,
      sessionConfig: branch.sessionConfig,
      history: msgs.slice(0, userIndex),
      sessionSnapshot: branch,
      userMessage: userText,
      requestAttachments: userAttachments,
      label: "retry-branch",
      onAccepted: () => {
        setSessions((previous) => [...previous, branch]);
        setCurrentSessionId(branch.id);
        setSidebarNav(branch.sessionConfig.mode);
      },
    });
  };

  const handleEditBranch = async (msgIdx: number) => {
    if (!sessionStorageReady || runtime.isStreaming || requestStartingRef.current) return;
    const sourceMessage = currentSession.messages[msgIdx];
    if (!sourceMessage) return;
    const editedMessage: Message = {
      ...sourceMessage,
      content: editText,
      variants: undefined,
      currentVariantIndex: undefined,
      timestamp: Date.now(),
    };
    const branch = createBranchSession(
      currentSession,
      [...currentSession.messages.slice(0, msgIdx), editedMessage],
    );
    if (editedMessage.role !== "user") {
      setSessions((previous) => [...previous, branch]);
      setCurrentSessionId(branch.id);
      setSidebarNav(branch.sessionConfig.mode);
      setEditingMessageIdx(null);
      return;
    }
    const editedAttachments = [...(editedMessage.attachments || [])];
    if (!editedMessage.content.trim() && editedAttachments.length === 0) {
      setSessions((previous) => [...previous, branch]);
      setCurrentSessionId(branch.id);
      setSidebarNav(branch.sessionConfig.mode);
      setEditingMessageIdx(null);
      return;
    }
    await startAgentRequest({
      targetSessionId: branch.id,
      sessionConfig: branch.sessionConfig,
      history: currentSession.messages.slice(0, msgIdx),
      sessionSnapshot: branch,
      userMessage: editedMessage.content,
      requestAttachments: editedAttachments,
      label: "edit-branch",
      onAccepted: () => {
        setSessions((previous) => [...previous, branch]);
        setCurrentSessionId(branch.id);
        setSidebarNav(branch.sessionConfig.mode);
        setEditingMessageIdx(null);
      },
    });
  };

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

  const toggleTool = (tool: string) => {
    const meta = TOOL_NAMES.find((item) => item.key === tool);
    const wasEnabled = config.tools_enabled.includes(tool);
    setConfig((prev) => ({
      ...prev,
      tools_enabled: prev.tools_enabled.includes(tool)
        ? prev.tools_enabled.filter((t) => t !== tool)
        : [...prev.tools_enabled, tool],
    }));
    addLog(
      t(wasEnabled ? "ui.tool-disabled" : "ui.tool-enabled", lang, { label: meta?.label || tool }),
      wasEnabled ? "info" : "success",
      true
    );
  };

  const removeTrustedPattern = async (toolName: string, pattern: string) => {
    try {
      const updatedConfig = await invoke<AppConfig>("remove_trusted_pattern", {
        currentConfig: config,
        toolName,
        pattern,
      });
      setConfig(updatedConfig);
    } catch (e) {
      addLog(`Failed to remove whitelist pattern: ${e}`, "error");
    }
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

  const toolStatsEntries = toolStatsDialog
    ? Object.entries(toolStatsDialog.stats).sort((a, b) => b[1] - a[1])
    : [];
  const toolStatsTotal = toolStatsEntries.reduce((sum, [, count]) => sum + count, 0);
  const toolStatsMax = toolStatsEntries[0]?.[1] || 0;
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
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item ${toast.type === "cmd" ? "info" : toast.type}`}>
            <span className="toast-dot" />
            <span className="toast-text">{toast.text}</span>
            {toast.actionLabel && toast.onAction && (
              <button type="button" className="toast-action" onClick={() => {
                setToasts((previous) => previous.filter((item) => item.id !== toast.id));
                toast.onAction?.();
              }}>
                {toast.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>

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
        <div className="modal-overlay" onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            setToolStatsDialog(null);
          }
        }}>
          <div className="modal-content stats-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="stats-modal-title">
                <BarChart3 size={15} /> {t("stats.title", lang)}
              </h3>
              <button className="btn" style={{ padding: "3px 8px", fontSize: "var(--font-caption)" }} onClick={() => setToolStatsDialog(null)}>
                {t("settings.close", lang)}
              </button>
            </div>
            <div className="modal-body stats-modal-body">
              <div className="stats-summary">
                <span>{toolStatsDialog.title}</span>
                <strong>{t("stats.total", lang, { count: String(toolStatsTotal) })}</strong>
              </div>
              {toolStatsEntries.length > 0 ? (
                <div className="stats-list">
                  {toolStatsEntries.map(([name, count]) => (
                    <div className="stats-row" key={name}>
                      <div className="stats-row-header">
                        <span className="stats-tool-name">{name}</span>
                        <span className="stats-tool-count">{t("stats.count", lang, { count: String(count) })}</span>
                      </div>
                      <div className="stats-meter">
                        <span style={{ width: `${Math.max(4, Math.round((count / toolStatsMax) * 100))}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="stats-empty">{t("stats.empty", lang)}</div>
              )}
            </div>
          </div>
        </div>
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
