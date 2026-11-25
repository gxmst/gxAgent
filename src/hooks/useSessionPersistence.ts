import { useEffect, useRef, useState } from "react";
import type { ChatSession } from "../types";
import { createDefaultSession, normalizeSessions } from "../appDefaults";
import { useAppStore } from "../store/appStore";
import { useUIStore } from "../store/uiStore";
import { notify } from "../services/agentEvents";
import { useSessionStorage } from "./useSessionStorage";

/**
 * Owns authoritative session loading, incremental dirty-session persistence to
 * Rust storage, localStorage startup mirrors, and per-session draft caching.
 */
export function useSessionPersistence(lang: string, hasActiveRequest: boolean) {
  const {
    saveSession,
    saveSessions,
    loadSessions,
    deleteSession: deleteStoredSession,
  } = useSessionStorage();

  const sessions = useAppStore((s) => s.sessions);
  const setSessions = useAppStore((s) => s.setSessions);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setCurrentSessionId = useAppStore((s) => s.setCurrentSessionId);
  const draftsBySession = useUIStore((s) => s.draftsBySession);
  const customPresets = useUIStore((s) => s.customPresets);

  const [sessionStorageReady, setSessionStorageReady] = useState(false);
  const [sessionLoadAttempt, setSessionLoadAttempt] = useState(0);
  const [sessionSaveStatus, setSessionSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const lastPersistedSessionsRef = useRef<Record<string, string>>({});
  const sessionObjCacheRef = useRef<Record<string, ChatSession>>({});
  const sessionJsonCacheRef = useRef<Record<string, string>>({});
  const mirrorPendingRef = useRef(false);
  const persistLatestRef = useRef<((throwOnError?: boolean) => Promise<void>) | null>(null);
  const sessionPersistenceEpochRef = useRef(0);

  useEffect(() => {
    const repaired = () => setSessionLoadAttempt((attempt) => attempt + 1);
    window.addEventListener("gx-session-storage-repaired", repaired);
    return () => window.removeEventListener("gx-session-storage-repaired", repaired);
  }, []);

  // Debounced per-session composer draft mirror.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem("gx_drafts", JSON.stringify(draftsBySession));
        localStorage.removeItem("gx_draft");
      } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(timer);
  }, [draftsBySession]);

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
    let cancelled = false;

    (async () => {
      const loadedSessions = await loadSessions();
      if (cancelled) return;
      if (loadedSessions === null) {
        setSessionStorageReady(false);
        setSessionSaveStatus("error");
        notify(lang === "zh" ? "会话读取失败，已暂停保存。" : "Could not load sessions. Saving is paused.", "error", {
          actionLabel: lang === "zh" ? "重试" : "Retry",
          onAction: () => setSessionLoadAttempt((attempt) => attempt + 1),
          duration: 0,
        });
        return;
      }
      const storedSessions = normalizeSessions(loadedSessions);
      const rawById = Object.fromEntries(loadedSessions
        .filter((session): session is ChatSession => Boolean(session && typeof session === "object" && typeof session.id === "string"))
        .map((session) => [session.id, JSON.stringify(session)]));
      lastPersistedSessionsRef.current = rawById;
      sessionJsonCacheRef.current = Object.fromEntries(
        storedSessions.map((session) => [session.id, JSON.stringify(session)]),
      );
      sessionObjCacheRef.current = Object.fromEntries(storedSessions
        .filter((session) => rawById[session.id] === JSON.stringify(session))
        .map((session) => [session.id, session]));
      setSessions(storedSessions);
      setCurrentSessionId((prev) =>
        storedSessions.some((session) => session.id === prev) ? prev : (storedSessions[0]?.id ?? createDefaultSession().id),
      );
      try {
        localStorage.setItem("gx_sessions", JSON.stringify(storedSessions));
      } catch { /* backend remains authoritative */ }

      setSessionStorageReady(true);
      setSessionSaveStatus("idle");
    })();

    return () => {
      cancelled = true;
    };
  }, [loadSessions, sessionLoadAttempt]);

  useEffect(() => {
    if (!sessionStorageReady) return;

    let cancelled = false;
    const persistenceEpoch = sessionPersistenceEpochRef.current;
    const persist = async (throwOnError = false) => {
      if (persistenceEpoch !== sessionPersistenceEpochRef.current) return;

      const dirty = sessions.filter((session) => sessionObjCacheRef.current[session.id] !== session);
      if (dirty.length === 0 && !mirrorPendingRef.current
        && sessions.every((session) => lastPersistedSessionsRef.current[session.id] === sessionJsonCacheRef.current[session.id])) {
        return;
      }
      for (const session of dirty) {
        sessionJsonCacheRef.current[session.id] = JSON.stringify(session);
        sessionObjCacheRef.current[session.id] = session;
      }

      if (hasActiveRequest) {
        if (dirty.length > 0) mirrorPendingRef.current = true;
      } else {
        mirrorPendingRef.current = false;
        try {
          const parts = sessions.map((session) =>
            sessionJsonCacheRef.current[session.id]
            ?? (sessionJsonCacheRef.current[session.id] = JSON.stringify(session)),
          );
          const data = `[${parts.join(",")}]`;
          if (data.length > 4 * 1024 * 1024) {
            const trimmed = sessions.map((s: ChatSession) => ({
              ...s,
              messages: s.messages.slice(-20).map((m) => (
                m.attachments
                  ? {
                      ...m,
                      attachments: m.attachments.map((att) =>
                        att.type === "image" ? { ...att, data: "" } : att,
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
          try { localStorage.removeItem("gx_sessions"); } catch { /* quota exceeded */ }
        }
      }

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
        if (throwOnError) throw error;
      }
    };

    persistLatestRef.current = persist;
    const delay = hasActiveRequest ? 1500 : 400;
    const timer = setTimeout(() => { void persist(); }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [saveSession, sessionStorageReady, sessions, hasActiveRequest]);

  useEffect(() => {
    if (!sessionStorageReady) return;
    const timer = window.setInterval(() => { void persistLatestRef.current?.(); }, 5000);
    return () => {
      window.clearInterval(timer);
      persistLatestRef.current = null;
    };
  }, [sessionStorageReady]);

  return {
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
  };
}
