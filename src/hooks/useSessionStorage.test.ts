// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createSession } from '../appDefaults';
import { useSessionStorage } from './useSessionStorage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => { vi.mocked(invoke).mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('authoritative session loading', () => {
  it('prevents every write after a failed load, then permits writes after retry', async () => {
    const session = createSession('chat');
    session.messages = [{ id: 'cached', role: 'assistant', content: 'truncated cache' }];
    const { result } = renderHook(useSessionStorage);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('disk unavailable'));
    await act(async () => { expect(await result.current.loadSessions()).toBeNull(); });
    await act(async () => {
      await expect(result.current.saveSession(session)).rejects.toThrow('not been loaded');
      await expect(result.current.saveSessions([session])).rejects.toThrow('not been loaded');
      await expect(result.current.deleteSession(session.id)).rejects.toThrow('not been loaded');
      await expect(result.current.clearSessions()).rejects.toThrow('not been loaded');
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    vi.mocked(invoke).mockResolvedValueOnce([session]);
    await act(async () => { expect(await result.current.loadSessions()).toEqual([session]); });
    await act(async () => { await result.current.saveSession(session); });
    expect(invoke).toHaveBeenLastCalledWith('save_session', { session });
  });

  it('treats a successful empty store as writable', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const { result } = renderHook(useSessionStorage);
    await act(async () => { expect(await result.current.loadSessions()).toEqual([]); });
    await act(async () => { await result.current.saveSessions([createSession('chat')]); });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
