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
  useAppStore.setState({ sessions: [a, b], currentSessionId: a.id, runtimeBySession: {}, checkpointBySession: {}, activeRunSessionId: null, preparingRequestSessionId: null });
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const deletion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const params: Parameters<typeof useSessionLifecycle>[0] = {
    lang: 'en', sessionStorageReady: true, sidebarNav: 'chat',
    setSidebarNav: vi.fn(), requestStartingRef: { current: false },
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
  await act(async () => { await result.current.switchSessionMode('code'); });
  expect(invoke).toHaveBeenCalledWith('pick_workspace_directory');
  expect(params.setSidebarNav).not.toHaveBeenCalled();
  expect(useAppStore.getState().currentSessionId).toBe(a.id);
  expect(useAppStore.getState().sessions).toEqual([a, b]);
});

it('changes mode on the current session while preserving its history and drafts', async () => {
  const { result, a, b, params } = setup();
  a.messages = [{ id: 'message', role: 'user', content: 'Keep this requirement' }];
  b.sessionConfig.mode = 'code';
  vi.mocked(invoke).mockResolvedValue('C:/projects/current');
  await act(async () => { await result.current.switchSessionMode('code'); });
  const state = useAppStore.getState();
  expect(state.currentSessionId).toBe(a.id);
  expect(state.sessions).toHaveLength(2);
  expect(state.sessions[0]).toMatchObject({ id: a.id, messages: a.messages, sessionConfig: { mode: 'code', workDir: 'C:/projects/current' } });
  expect(state.sessions[1]).toBe(b);
  expect(params.setDraftsBySession).not.toHaveBeenCalled();
  await act(async () => { await result.current.switchSessionMode('chat'); });
  expect(useAppStore.getState().sessions[0].sessionConfig.workDir).toBe('C:/projects/current');
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('does not apply a pending project selection to a different task or active run', async () => {
  const { result, a, b } = setup();
  let choose!: (path: string) => void;
  vi.mocked(invoke).mockImplementation(() => new Promise(resolve => { choose = resolve as typeof choose; }));
  let pending!: Promise<void>;
  act(() => { pending = result.current.switchSessionMode('code'); });
  act(() => { useAppStore.setState({ currentSessionId: b.id }); });
  await act(async () => { choose('C:/projects/stale'); await pending; });
  expect(useAppStore.getState().sessions).toEqual([a, b]);
  useAppStore.setState({ activeRunSessionId: b.id });
  await act(async () => { await result.current.switchSessionMode('code'); });
  expect(invoke).toHaveBeenCalledTimes(1);
});
