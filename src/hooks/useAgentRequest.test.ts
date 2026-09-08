// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createSession, DEFAULT_CONFIG } from '../appDefaults';
import type { Attachment, Message } from '../types';
import { useAppStore } from '../store/appStore';
import { runtime } from '../services/agentRuntime';
import { useAgentRequest } from './useAgentRequest';
import type { ApiMessage } from '../utils/messageHistory';
import { notify } from '../services/agentEvents';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../services/agentEvents', () => ({ addLog: vi.fn(), notify: vi.fn(), finishStreamingLocally: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function setup(history: Message[], prompt = 'continue', contextLimit = 32000, codeEngine: 'native' | 'codex' = 'native', attachments: Attachment[] = []) {
  const config = { ...DEFAULT_CONFIG, provider: 'ollama', base_url: 'http://localhost:11434', system_prompt: '', context_limit: contextLimit, code_engine: codeEngine };
  const session = createSession('code', 'test', history);
  useAppStore.setState({ sessions: [session], currentSessionId: session.id, activeRunSessionId: null, checkpointBySession: {}, quoteBySession: {}, runtimeBySession: {} });
  Object.assign(runtime, { isStreaming: false, activeRequestId: '', activeRequestSessionId: '', requestSessionById: {}, assistantMessageIdByRequest: {} });
  const params: Parameters<typeof useAgentRequest>[0] = {
    lang: 'en', config, sessionStorageReady: true, sessionMutationLocked: false, requestStartingRef: { current: false },
    models: [], modelCatalogSourceKey: null, resolvedCurrentConfig: config, currentSession: session, prompt,
    setPrompt: vi.fn(), attachments, isAttachmentLoading: false, setDraftsBySession: vi.fn(),
    setAttachmentsBySession: vi.fn(), setSidebarNav: vi.fn(), editText: '', setEditingMessageIdx: vi.fn(),
  };
  return renderHook(() => useAgentRequest(params));
}

function assistant(id: string, size = 10): Message {
  return { id, role: 'assistant', content: 'done', actions: [
    { id: 'call_0', name: 'read_file', arguments: JSON.stringify({ path: `${id}.txt` }), status: 'done', output: 'x'.repeat(size) },
  ] };
}

it('keeps local attachments outside the raw query used for retrieval and forced web search', async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const attachments: Attachment[] = [{ type: 'text', name: 'private.txt', data: 'Internal document contents' }];
  const { result } = setup([], 'Compare release dates', 32000, 'native', attachments);
  await act(async () => { await result.current.handleSendMessage(); });
  const args = vi.mocked(invoke).mock.calls.find(([command]) => command === 'start_agent_session')?.[1] as { prompt: string; retrievalQuery: string };
  expect(args.prompt).toContain('Internal document contents');
  expect(args.retrievalQuery).toBe('Compare release dates');
});

it('marks non-tail Codex retries as incomplete history', async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const { result } = setup([
    { id: 'u1', role: 'user', content: 'First requirement' }, assistant('a1'),
    { id: 'u2', role: 'user', content: 'Later requirement' }, assistant('a2'),
  ], '', 32000, 'codex');
  await act(async () => { await result.current.handleRetry(1); });
  expect(runtime.activeCodexHistoryComplete).toBe(false);
  expect(useAppStore.getState().sessions[0].messages[2].content).toBe('Later requirement');
});

it('sends tool calls and observations to the next agent request', async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const { result } = setup([{ id: 'user', role: 'user', content: 'read the file' }, assistant('answer')]);
  await act(async () => { await result.current.handleSendMessage(); });
  const args = vi.mocked(invoke).mock.calls.find(([command]) => command === 'start_agent_session')?.[1] as { sessionMessages: ApiMessage[] };
  expect(args.sessionMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  expect(args.sessionMessages[2].tool_call_id).toBe(args.sessionMessages[1].tool_calls?.[0].id);
  expect(args.sessionMessages[1].tool_calls?.[0].function.arguments).toContain('answer.txt');
});

it('compacts whole source groups and retains tool metadata in the summary input', async () => {
  vi.mocked(invoke).mockImplementation(async (command) => command === 'compact_history' ? 'file review summary' : undefined);
  const history = Array.from({ length: 14 }, (_, index) => assistant(`answer-${index}`, index < 6 ? 1400 : 10));
  const { result } = setup(history, 'continue', 4000);
  await act(async () => { await result.current.handleSendMessage(); });
  const compact = vi.mocked(invoke).mock.calls.find(([command]) => command === 'compact_history')?.[1] as { messages: ApiMessage[] };
  expect(compact.messages).toHaveLength(18);
  expect(compact.messages[0].tool_calls?.[0].function.arguments).toContain('answer-0.txt');
  const request = vi.mocked(invoke).mock.calls.find(([command]) => command === 'start_agent_session')?.[1] as { sessionMessages: ApiMessage[] };
  expect(request.sessionMessages).toHaveLength(25);
  expect(request.sessionMessages[1].tool_calls?.[0].function.arguments).toContain('answer-6.txt');
  const saved = useAppStore.getState().sessions[0];
  const divider = saved.messages.findIndex((message) => message.role === 'context_divider');
  expect(saved.messages[divider - 1].id).toBe('answer-5');
});

it('passes tool metadata through manual compaction too', async () => {
  vi.mocked(invoke).mockResolvedValue('summary');
  const { result } = setup([assistant('first'), assistant('second'), assistant('third')], '/compact');
  await act(async () => { await result.current.handleSendMessage(); });
  const args = vi.mocked(invoke).mock.calls.find(([command]) => command === 'compact_history')?.[1] as { messages: ApiMessage[] };
  expect(args.messages[0].tool_calls?.[0].function.name).toBe('read_file');
  expect(args.messages[1].tool_call_id).toBe(args.messages[0].tool_calls?.[0].id);
});

it('does not route Codex manual compaction to a different provider', async () => {
  const history = [assistant('first'), assistant('second'), assistant('third')];
  const { result } = setup(history, '/compact', 32000, 'codex');
  await act(async () => { await result.current.handleSendMessage(); });
  expect(invoke).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('Codex manages context'), 'info');
  expect(useAppStore.getState().sessions[0].messages).toEqual(history);
});
