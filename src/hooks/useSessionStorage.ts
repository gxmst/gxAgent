import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChatSession } from '../types';

export function useSessionStorage() {
  const [loading, setLoading] = useState(false);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueWrite = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = writeQueueRef.current.then(operation, operation);
    writeQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const saveSession = useCallback(async (session: ChatSession) => {
    setLoading(true);
    try {
      await enqueueWrite(() => invoke('save_session', { session }));
    } catch (e) {
      console.error('Failed to save session:', e);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [enqueueWrite]);

  const saveSessions = useCallback(async (sessions: ChatSession[]) => {
    setLoading(true);
    try {
      await enqueueWrite(() => invoke('save_sessions', { sessions }));
    } catch (e) {
      console.error('Failed to save sessions:', e);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [enqueueWrite]);

  const loadSession = useCallback(async (id: string): Promise<ChatSession | null> => {
    setLoading(true);
    try {
      return await invoke('load_session', { id });
    } catch (e) {
      console.error('Failed to load session:', e);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async (): Promise<ChatSession[] | null> => {
    setLoading(true);
    try {
      return await invoke('load_sessions');
    } catch (e) {
      console.error('Failed to load sessions:', e);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const listSessions = useCallback(async (): Promise<string[]> => {
    try {
      return await invoke('list_sessions');
    } catch (e) {
      console.error('Failed to list sessions:', e);
      return [];
    }
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await enqueueWrite(() => invoke('delete_session', { id }));
    } catch (e) {
      console.error('Failed to delete session:', e);
      throw e;
    }
  }, [enqueueWrite]);

  const clearSessions = useCallback(async () => {
    try {
      await enqueueWrite(() => invoke('clear_all_sessions'));
    } catch (e) {
      console.error('Failed to clear sessions:', e);
      throw e;
    }
  }, [enqueueWrite]);

  return {
    saveSession,
    saveSessions,
    loadSession,
    loadSessions,
    listSessions,
    deleteSession,
    clearSessions,
    loading,
  };
}
