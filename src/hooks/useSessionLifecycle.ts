/**
 * Session lifecycle: create sessions (with workspace picking in code mode),
 * switch sidebar modes, bulk-replace/import sessions, and delete with undo —
 * plus the per-session UI-state reset/drop bookkeeping those flows need.
 *
 * Extracted verbatim from App.tsx. Store-backed state comes from zustand;
 * App-local per-session maps, persistence caches and refs flow in as params.
 */
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { Attachment, ChatSession, SessionConfig } from "../types";
import {
  createSession,
  omitSessionKey,
  type RunCheckpoint,
} from "../appDefaults";
import { compareSidebarSessions } from "../utils/sessionOrder";
import { useAppStore } from "../store/appStore";
import { runtime } from "../services/agentRuntime";
import { addLog, notify, discardStreamBuffer } from "../services/agentEvents";

export function useSessionLifecycle({
  lang,
  sessionStorageReady,
  currentSession,
  sidebarNav,
  setSidebarNav,
  lastSessionByModeRef,
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
  setDiffView,
}: {
  lang: string;
  sessionStorageReady: boolean;
  currentSession: ChatSession;
  sidebarNav: "chat" | "code";
  setSidebarNav: React.Dispatch<React.SetStateAction<"chat" | "code">>;
  lastSessionByModeRef: React.MutableRefObject<Partial<Record<SessionConfig["mode"], string>>>;
  requestStartingRef: React.MutableRefObject<boolean>;
  sessionPersistenceEpochRef: React.MutableRefObject<number>;
  lastPersistedSessionsRef: React.MutableRefObject<Record<string, string>>;
  sessionObjCacheRef: React.MutableRefObject<Record<string, ChatSession>>;
  sessionJsonCacheRef: React.MutableRefObject<Record<string, string>>;
  saveSession: (session: ChatSession) => Promise<void>;
  saveSessions: (sessions: ChatSession[]) => Promise<void>;
  deleteStoredSession: (id: string) => Promise<void>;
  setDraftsBySession: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setAttachmentsBySession: React.Dispatch<React.SetStateAction<Record<string, Attachment[]>>>;
  attachmentLoadingBySession: Record<string, boolean>;
  setAttachmentLoadingBySession: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setEditingMessageIdxBySession: React.Dispatch<React.SetStateAction<Record<string, number | null>>>;
  setEditTextBySession: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setExpandedActions: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setDiffView: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const sessions = useAppStore((s) => s.sessions);
  const setSessions = useAppStore((s) => s.setSessions);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setCurrentSessionId = useAppStore((s) => s.setCurrentSessionId);
  const setActiveRunSessionId = useAppStore((s) => s.setActiveRunSessionId);
  const preparingRequestSessionId = useAppStore((s) => s.preparingRequestSessionId);
  const setPreparingRequestSessionId = useAppStore((s) => s.setPreparingRequestSessionId);
  const runtimeBySession = useAppStore((s) => s.runtimeBySession);
  const setRuntimeBySession = useAppStore((s) => s.setRuntimeBySession);
  const checkpointBySession = useAppStore((s) => s.checkpointBySession);
  const setCheckpointBySession = useAppStore((s) => s.setCheckpointBySession);
  const setPreviewBySession = useAppStore((s) => s.setPreviewBySession);
  const setModifiedFilesBySession = useAppStore((s) => s.setModifiedFilesBySession);
  const setWorkspaceBySession = useAppStore((s) => s.setWorkspaceBySession);
  const setTerminalLogsBySession = useAppStore((s) => s.setTerminalLogsBySession);
  const setPreviewConsoleLogsBySession = useAppStore((s) => s.setPreviewConsoleLogsBySession);
  const setPendingApprovalsBySession = useAppStore((s) => s.setPendingApprovalsBySession);
  const setApprovalSubmittingBySession = useAppStore((s) => s.setApprovalSubmittingBySession);
  const setUsageStatsBySession = useAppStore((s) => s.setUsageStatsBySession);
  const setQuoteBySession = useAppStore((s) => s.setQuoteBySession);
  const setFileContent = useAppStore((s) => s.setFileContent);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

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

  const switchSidebarMode = (mode: SessionConfig["mode"]) => {
    setSidebarNav(mode);
    if (currentSession.sessionConfig.mode === mode) return;
    const rememberedSessionId = lastSessionByModeRef.current[mode];
    const target = sessions.find((session) => (
      session.id === rememberedSessionId && session.sessionConfig.mode === mode
    )) || sessions
      .filter((session) => session.sessionConfig.mode === mode && !session.archived)
      .sort(compareSidebarSessions)[0];
    if (target) {
      setCurrentSessionId(target.id);
    } else {
      void createNewSessionInMode(mode);
    }
  };

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
    setQuoteBySession({});
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
    setQuoteBySession((previous) => omitSessionKey(previous, sessionId));
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

  const setSessionArchived = (id: string, archived: boolean) => {
    if (!sessionStorageReady) return;
    const target = sessions.find((session) => session.id === id);
    if (!target || Boolean(target.archived) === archived) return;

    // Archiving the current session leaves a hole in the visible list; pick
    // the next visible same-mode session, mirroring deleteSession's fallback.
    if (archived && currentSessionId === id) {
      const targetMode = target.sessionConfig.mode || sidebarNav;
      const orderedModeSessions = sessions
        .filter((session) => session.sessionConfig.mode === targetMode && !session.archived)
        .sort(compareSidebarSessions);
      const archivedVisibleIndex = orderedModeSessions.findIndex((session) => session.id === id);
      const remainingInMode = orderedModeSessions.filter((session) => session.id !== id);
      const fallbackSession = remainingInMode[Math.min(
        Math.max(archivedVisibleIndex, 0),
        Math.max(remainingInMode.length - 1, 0),
      )] || sessions.find((session) => session.id !== id && !session.archived);
      if (fallbackSession) {
        setCurrentSessionId(fallbackSession.id);
        setSidebarNav(fallbackSession.sessionConfig.mode || "chat");
      }
    }

    setSessions((previous) => previous.map((session) => session.id === id
      ? { ...session, archived: archived ? true : undefined, updatedAt: Date.now() }
      : session));
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
      .filter((session) => session.sessionConfig.mode === targetMode && !session.archived)
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

  return {
    createNewSessionInMode,
    createNewSession,
    switchSidebarMode,
    replaceAllSessions,
    deleteSession,
    setSessionArchived,
  };
}
