// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { initAgentEventListeners, finishStreamingLocally, upsertToolActions } from './agentEvents';
import { runtime } from './agentRuntime';
import { useAppStore } from '../store/appStore';
import { createSession } from '../appDefaults';
import { serializeMessageForApi } from '../utils/messageHistory';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceViewStore } from '../store/workspaceViewStore';
import { rememberCodexHistory } from './codexWorkflow';

const handlers = vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  return new Map<string, (event: { payload: unknown }) => void>();
});
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
  handlers.set(name, handler);
  return () => { handlers.delete(name); };
}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('./codexWorkflow', () => ({ rememberCodexHistory: vi.fn() }));
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); vi.useRealTimers(); useWorkspaceViewStore.getState().clear(); });

it.each([true, false])('remembers cancelled Codex history only when a turn actually started: %s', started => {
  vi.useFakeTimers();
  vi.mocked(rememberCodexHistory).mockClear();
  const session = createSession('code');
  Object.assign(runtime, { activeRequestId: 'cancelled-start', activeRequestSessionId: session.id, activeRequestEngine: 'codex', activeCodexTurnStarted: started, assistantMessageIdByRequest: {}, requestSessionById: { 'cancelled-start': session.id } });
  useAppStore.setState({ sessions: [session], currentSessionId: session.id });
  finishStreamingLocally('cancelled-start', 'stopped');
  expect(rememberCodexHistory).toHaveBeenCalledTimes(started ? 1 : 0);
});

it.each([true, false])('uses authoritative Codex text with prior deltas: %s', async hadDelta => {
  vi.useFakeTimers();
  const session = createSession('code');
  session.messages = [{ id: 'previous-answer', role: 'assistant', content: 'Keep this reply' }];
  useAppStore.setState({ sessions: [session], currentSessionId: session.id });
  Object.assign(runtime, { activeRequestId: 'final-text', activeRequestSessionId: session.id, assistantMessageIdByRequest: {}, requestSessionById: { 'final-text': session.id } });
  dispose = await initAgentEventListeners();
  if (hadDelta) handlers.get('agent-stream-chunk')!({ payload: { requestId: 'final-text', content: 'draft text' } });
  handlers.get('agent-stream-done')!({ payload: { requestId: 'final-text', content: 'Corrected final reply', authoritative: true } });
  const messages = useAppStore.getState().sessions[0].messages;
  expect(messages).toHaveLength(2);
  expect(messages[0].content).toBe('Keep this reply');
  expect(messages[1]).toMatchObject({ content: 'Corrected final reply', variants: ['Corrected final reply'] });
});

it('updates only the active retry variant and preserves native done semantics', async () => {
  const session = createSession('code');
  session.messages = [{ id: 'answer', role: 'assistant', content: 'stream', variants: ['Original reply', 'stream'], currentVariantIndex: 1 }];
  useAppStore.setState({ sessions: [session], currentSessionId: session.id });
  Object.assign(runtime, { activeRequestId: 'retry', activeRequestSessionId: session.id, assistantMessageIdByRequest: { retry: 'answer' }, requestSessionById: { retry: session.id } });
  dispose = await initAgentEventListeners();
  handlers.get('agent-stream-done')!({ payload: { requestId: 'retry', content: 'Native last round only' } });
  expect(useAppStore.getState().sessions[0].messages[0].content).toBe('stream');
  handlers.get('agent-stream-done')!({ payload: { requestId: 'retry', content: 'Final Codex text', authoritative: true } });
  expect(useAppStore.getState().sessions[0].messages[0].variants).toEqual(['Original reply', 'Final Codex text']);
});

it('resolves an approval without clearing the next queued action', async () => {
  const session = createSession('code');
  useAppStore.setState({ sessions: [session], currentSessionId: session.id, pendingApprovalsBySession: {} });
  Object.assign(runtime, { activeRequestId: 'approvals', activeRequestSessionId: session.id, assistantMessageIdByRequest: {}, requestSessionById: { approvals: session.id } });
  dispose = await initAgentEventListeners();
  for (const id of ['first', 'second']) handlers.get('agent-tool-approval-request')!({ payload: {
    requestId: 'approvals', source: 'codex', request_id: id, tool_calls: [{ id, name: 'execute_command', arguments: '{}' }],
  } });
  handlers.get('agent-tool-approval-resolved')!({ payload: { requestId: 'approvals', approvalRequestId: 'first', itemId: 'first', approved: true } });
  expect(useAppStore.getState().pendingApprovalsBySession[session.id]?.request_id).toBe('second');
  expect(useAppStore.getState().sessions[0].messages[0].actions?.map(action => action.status)).toEqual(['executing', 'pending_approval']);
  handlers.get('agent-tool-approval-resolved')!({ payload: { requestId: 'approvals', approvalRequestId: 'second', itemId: 'second', approved: false } });
  expect(useAppStore.getState().pendingApprovalsBySession[session.id]).toBeNull();
  expect(useAppStore.getState().sessions[0].messages[0].actions?.[1].status).toBe('blocked');
});

it('keeps both rounds and parallel calls when stream indexes restart', async () => {
  vi.useFakeTimers();
  const session = createSession('chat');
  useAppStore.setState({ sessions: [session], currentSessionId: session.id });
  Object.assign(runtime, { activeRequestId: 'request', activeRequestSessionId: session.id, assistantMessageIdByRequest: {}, requestSessionById: { request: session.id } });
  dispose = await initAgentEventListeners();
  const emit = (name: string, payload: object) => handlers.get(name)!({ payload: { requestId: 'request', ...payload } });
  const first = { index: 0, id: 'local-first', name: 'read_file', arguments: '{"path":"first.txt"}' };
  emit('agent-tool-drafting', first);
  emit('agent-tool-executing', first);
  emit('agent-tool-output', { ...first, output: 'first contents' });
  const second = { index: 0, id: 'local-second', name: 'write_file', arguments: '{"path":"second.txt","content":"new"}' };
  emit('agent-tool-drafting', { ...second, name: '', arguments: '{"path":' });
  emit('agent-tool-drafting', second);
  const parallel = { index: 1, id: 'local-third', name: 'grep', arguments: '{"pattern":"TODO"}' };
  emit('agent-tool-drafting', parallel);
  emit('agent-tool-executing', second);
  emit('agent-tool-output', { ...second, output: 'Error: permission denied' });
  emit('agent-tool-drafting', { ...first, arguments: 'late stale draft' });
  const assistant = useAppStore.getState().sessions[0].messages[0];
  expect(assistant.actions).toHaveLength(3);
  expect(assistant.actions?.[0]).toMatchObject({ id: first.id, name: first.name, arguments: first.arguments, status: 'done', output: 'first contents' });
  expect(assistant.actions?.[1]).toMatchObject({ id: second.id, name: second.name, arguments: second.arguments, status: 'error' });
  expect(assistant.actions?.[2].status).toBe('drafting');
  const history = serializeMessageForApi(assistant);
  expect(history[0].tool_calls?.[0].function.arguments).toBe(first.arguments);
  expect(history[1].content).toBe('first contents');
  expect(history[2].tool_calls?.[0].function.name).toBe('write_file');
});

it.each(['completed', 'error', 'stopped'] as const)('persists the %s outcome on the correct assistant message', status => {
  vi.useFakeTimers();
  const session = createSession('code');
  Object.assign(runtime, { activeRequestId: 'request', activeRequestSessionId: session.id, assistantMessageIdByRequest: {}, requestSessionById: { request: session.id } });
  session.messages = upsertToolActions([], [
    { id: 'tool', name: 'read_file', arguments: '{}', status: 'done' },
    { id: 'pending', name: 'execute_command', arguments: '{}', status: 'pending_approval' },
    { id: 'running', name: 'execute_command', arguments: '{}', status: 'executing', output: 'partial output' },
  ], 'request');
  useAppStore.setState({ sessions: [session], currentSessionId: session.id, activeRunSessionId: session.id });
  finishStreamingLocally('request', status);
  expect(useAppStore.getState().sessions[0].messages[0].run).toMatchObject({ requestId: 'request', status });
  expect(useAppStore.getState().activeRunSessionId).toBeNull();
  const actions = useAppStore.getState().sessions[0].messages[0].actions!;
  expect(actions).toHaveLength(3);
  expect(actions[0].status).toBe('done');
  expect(actions[1].status).toBe(status === 'error' ? 'error' : 'blocked');
  expect(actions[2]).toMatchObject({ status: status === 'error' ? 'error' : 'blocked', output: 'partial output' });
});

it('refreshes matching file views in background tasks without touching another project', async () => {
  vi.useFakeTimers();
  const session = createSession('code');
  useAppStore.setState({ sessions: [session], currentSessionId: 'other-project' });
  Object.assign(runtime, {
    activeRequestId: 'file-request', activeRequestSessionId: session.id, activeRequestWorkDir: 'C:/projects/example',
    effectiveWorkDir: 'C:/projects/other', assistantMessageIdByRequest: {}, requestSessionById: { 'file-request': session.id },
  });
  const views = useWorkspaceViewStore.getState();
  views.setFile(session.id, { workDir: 'C:/projects/example', path: 'src/app.ts', content: 'old' });
  views.setFile('same-project', { workDir: 'c:\\projects\\EXAMPLE', path: 'c:\\projects\\example\\src\\app.ts', content: 'old' });
  views.setFile('other-project', { workDir: 'C:/projects/other', path: 'src/app.ts', content: 'different' });
  vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce({ repositoryRoot: 'C:/projects/example', branch: 'main', entries: [] });
  dispose = await initAgentEventListeners();
  handlers.get('agent-tool-output')!({ payload: {
    requestId: 'file-request', id: 'write', name: 'write_file', output: 'Written',
    path: 'src/app.ts', afterExists: true, afterContent: 'updated',
  } });
  expect(useWorkspaceViewStore.getState().files[session.id].content).toBe('updated');
  expect(useWorkspaceViewStore.getState().files['same-project'].content).toBe('updated');
  expect(useWorkspaceViewStore.getState().files['other-project'].content).toBe('different');
});
