import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChatSession } from '../types';

export function useSessionStorage() {
  const [loading, setLoading] = useState(false);

  const saveSession = useCallback(async (session: ChatSession) => {
    setLoading(true);
    try {
      await invoke('save_session', { session });
    } catch (e) {
      console.error('Failed to save session:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const saveSessions = useCallback(async (sessions: ChatSession[]) => {
    setLoading(true);
    try {
      await invoke('save_sessions', { sessions });
    } catch (e) {
      console.error('Failed to save sessions:', e);
    } finally {
      setLoading(false);
    }
  }, []);

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

  const loadSessions = useCallback(async (): Promise<ChatSession[]> => {
    setLoading(true);
    try {
      return await invoke('load_sessions');
    } catch (e) {
      console.error('Failed to load sessions:', e);
      return [];
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
      await invoke('delete_session', { id });
    } catch (e) {
      console.error('Failed to delete session:', e);
    }
  }, []);

  const clearSessions = useCallback(async () => {
    try {
      await invoke('clear_all_sessions');
    } catch (e) {
      console.error('Failed to clear sessions:', e);
    }
  }, []);

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
