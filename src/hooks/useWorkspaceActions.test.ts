// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSession } from '../appDefaults';
import { runtime } from '../services/agentRuntime';
import { useAppStore } from '../store/appStore';
import { useWorkspaceViewStore } from '../store/workspaceViewStore';
import { useWorkspaceActions } from './useWorkspaceActions';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null }); });
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../services/agentEvents', () => ({ addLog: vi.fn(), notify: vi.fn(), refreshWorkspace: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); useWorkspaceViewStore.getState().clear(); runtime.fileRequestSequence = {}; });
afterEach(cleanup);

function setup() {
  const first = createSession('code');
  const second = createSession('code');
  useAppStore.setState({ sessions: [first, second], currentSessionId: first.id, workspaceBySession: {}, checkpointBySession: {} });
  const params: Parameters<typeof useWorkspaceActions>[0] = {
    lang: 'en', effectiveWorkDir: 'C:/projects/example', sessionMutationLocked: false,
    requestConfirmation: vi.fn(), attachmentsBySession: {}, setAttachmentsBySession: vi.fn(),
    attachmentLoadingBySession: {}, setAttachmentLoadingBySession: vi.fn(), reportAttachmentFit: vi.fn(),
  };
  return { ...renderHook(() => useWorkspaceActions(params)), first, second };
}

function deferredRead() {
  let resolve!: (content: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  vi.mocked(invoke).mockReturnValueOnce(promise);
  return { resolve, reject };
}

it('finishes a background file read in its own task after navigation', async () => {
  const { result, first, second } = setup();
  const pending = deferredRead();
  let read!: Promise<void>;
  act(() => { read = result.current.selectWorkspaceFile({ path: 'src/first.ts' }); });
  act(() => { useAppStore.setState({ currentSessionId: second.id }); });
  vi.mocked(invoke).mockResolvedValueOnce('second contents');
  await act(async () => { await result.current.selectWorkspaceFile({ path: 'src/second.ts' }); });
  await act(async () => { pending.resolve('first contents'); await read; });
  const files = useWorkspaceViewStore.getState().files;
  expect(files[first.id]).toMatchObject({ path: 'src/first.ts', content: 'first contents', loading: false });
  expect(files[second.id]).toMatchObject({ path: 'src/second.ts', content: 'second contents', loading: false });
});

it.each(['success', 'failure'] as const)('ignores an obsolete read %s after a newer file selection', async outcome => {
  const { result, first } = setup();
  const pending = deferredRead();
  let read!: Promise<void>;
  act(() => { read = result.current.selectWorkspaceFile({ path: 'old.ts' }); });
  vi.mocked(invoke).mockResolvedValueOnce('latest');
  await act(async () => { await result.current.selectWorkspaceFile({ path: 'new.ts' }); });
  await act(async () => {
    if (outcome === 'success') pending.resolve('obsolete');
    else pending.reject(new Error('obsolete failure'));
    await read;
  });
  expect(useWorkspaceViewStore.getState().files[first.id]).toMatchObject({ path: 'new.ts', content: 'latest', error: '', loading: false });
});

it('retains the failed path and clears its error when a retry succeeds', async () => {
  const { result, first } = setup();
  vi.mocked(invoke).mockRejectedValueOnce(new Error('temporarily unavailable'));
  await act(async () => { await result.current.selectWorkspaceFile({ path: 'retry.ts' }); });
  expect(useWorkspaceViewStore.getState().files[first.id]).toMatchObject({ path: 'retry.ts', error: 'Error: temporarily unavailable', loading: false });
  vi.mocked(invoke).mockResolvedValueOnce('recovered');
  await act(async () => { await result.current.selectWorkspaceFile({ path: 'retry.ts' }); });
  expect(useWorkspaceViewStore.getState().files[first.id]).toMatchObject({ content: 'recovered', error: '', loading: false });
});

it('opens an HTML preview in the originating task and ignores obsolete reads', async () => {
  const { result, first, second } = setup();
  const pending = deferredRead();
  let read!: Promise<void>;
  act(() => { read = result.current.selectWorkspaceFile({ path: 'old.html' }); });
  vi.mocked(invoke).mockResolvedValueOnce('<h1>Current preview</h1>');
  await act(async () => { await result.current.selectWorkspaceFile({ path: 'index.html' }); });
  act(() => { useAppStore.setState({ currentSessionId: second.id }); });
  await act(async () => { pending.resolve('<h1>Old preview</h1>'); await read; });
  expect(useAppStore.getState().previewBySession[first.id]).toBe('<h1>Current preview</h1>');
  expect(useAppStore.getState().previewBySession[second.id]).toBeUndefined();
});
