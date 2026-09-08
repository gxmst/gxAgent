// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createSession } from '../appDefaults';
import { useAppStore } from '../store/appStore';
import { useSessionLifecycle } from './useSessionLifecycle';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../services/agentEvents', () => ({ notify: vi.fn(), addLog: vi.fn(), discardStreamBuffer: vi.fn() }));
vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

function setup() {
  vi.useFakeTimers();
  const a = createSession('chat');
  const b = createSession('chat');
  useAppStore.setState({ sessions: [a, b], currentSessionId: a.id, runtimeBySession: {}, checkpointBySession: {} });
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const deletion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const params: Parameters<typeof useSessionLifecycle>[0] = {
    lang: 'en', sessionStorageReady: true, currentSession: a, sidebarNav: 'chat',
    setSidebarNav: vi.fn(), lastSessionByModeRef: { current: {} }, requestStartingRef: { current: false },
    sessionPersistenceEpochRef: { current: 0 }, lastPersistedSessionsRef: { current: {} },
    sessionObjCacheRef: { current: {} }, sessionJsonCacheRef: { current: {} },
    saveSession: vi.fn().mockResolvedValue(undefined), saveSessions: vi.fn().mockResolvedValue(undefined),
    deleteStoredSession: vi.fn(() => deletion), setDraftsBySession: vi.fn(), setAttachmentsBySession: vi.fn(),
    attachmentLoadingBySession: {}, setAttachmentLoadingBySession: vi.fn(), setEditingMessageIdxBySession: vi.fn(),
    setEditTextBySession: vi.fn(), setExpandedActions: vi.fn(),
  };
  const hook = renderHook(() => useSessionLifecycle(params));
  const event = { stopPropagation: vi.fn() } as unknown as React.MouseEvent;
  return { ...hook, a, b, params, resolve, reject, event };
}

it('preserves streaming updates and a new selection during deletion', async () => {
  const { result, a, b, resolve, event, params } = setup();
  act(() => { useAppStore.setState({ currentSessionId: b.id }); });
  let pending!: Promise<void>;
  act(() => { pending = result.current.deleteSession(a.id, event); });
  const updatedB = { ...b, messages: [{ id: 'stream', role: 'assistant' as const, content: 'new streamed text' }] };
  act(() => { useAppStore.setState({ sessions: [updatedB], currentSessionId: b.id }); });
  await act(async () => { resolve(); await pending; });
  expect(useAppStore.getState().sessions).toEqual([updatedB]);
  expect(useAppStore.getState().currentSessionId).toBe(b.id);
  expect(params.setSidebarNav).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('gx_sessions')!)).toEqual([updatedB]);
});

it('rolls back a failed delete without reverting other session edits', async () => {
  const { result, a, b, reject, event, params } = setup();
  params.lastPersistedSessionsRef.current[a.id] = JSON.stringify(a);
  params.sessionObjCacheRef.current[a.id] = a;
  params.sessionJsonCacheRef.current[a.id] = JSON.stringify(a);
  let pending!: Promise<void>;
  act(() => { pending = result.current.deleteSession(a.id, event); });
  const updatedB = { ...b, title: 'changed while deleting' };
  act(() => { useAppStore.setState({ sessions: [updatedB], currentSessionId: b.id }); });
  await act(async () => { reject(new Error('disk unavailable')); await pending; });
  expect(useAppStore.getState().sessions).toEqual([a, updatedB]);
  expect(useAppStore.getState().currentSessionId).toBe(b.id);
  expect(params.lastPersistedSessionsRef.current[a.id]).toBeUndefined();
  expect(params.sessionObjCacheRef.current[a.id]).toBeUndefined();
  expect(params.sessionJsonCacheRef.current[a.id]).toBeUndefined();
});

it('keeps selection valid during a current-session delete and preserves later navigation', async () => {
  const { result, a, b, resolve, event } = setup();
  const c = createSession('chat');
  act(() => { useAppStore.setState({ sessions: [a, b, c] }); });
  let pending!: Promise<void>;
  act(() => { pending = result.current.deleteSession(a.id, event); });
  expect(useAppStore.getState().sessions.some((session) => session.id === useAppStore.getState().currentSessionId)).toBe(true);
  act(() => { useAppStore.setState({ currentSessionId: c.id }); });
  await act(async () => { resolve(); await pending; });
  expect(useAppStore.getState().currentSessionId).toBe(c.id);
});

it('creates a task in the selected project without opening another directory picker', async () => {
  const { result, params } = setup();
  await act(async () => {
    await result.current.createNewSessionInMode('code', 'C:/projects/example');
  });
  const state = useAppStore.getState();
  expect(invoke).not.toHaveBeenCalled();
  expect(state.sessions.find(session => session.id === state.currentSessionId)?.sessionConfig)
    .toMatchObject({ mode: 'code', workDir: 'C:/projects/example' });
  expect(params.setSidebarNav).toHaveBeenCalledWith('code');
});

it('keeps the current mode and selection when the project picker is cancelled', async () => {
  const { result, a, b, params } = setup();
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await act(async () => { result.current.switchSidebarMode('code'); });
  expect(invoke).toHaveBeenCalledWith('pick_workspace_directory');
  expect(params.setSidebarNav).not.toHaveBeenCalled();
  expect(useAppStore.getState().currentSessionId).toBe(a.id);
  expect(useAppStore.getState().sessions).toEqual([a, b]);
});
