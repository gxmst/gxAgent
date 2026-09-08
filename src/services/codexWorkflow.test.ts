// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { beforeAll, expect, it, vi } from 'vitest';
import { codexHistoryKey, rememberCodexHistory } from './codexWorkflow';
import type { Message } from '../types';
import { normalizeSessions } from '../appDefaults';
import { useAppStore } from '../store/appStore';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null }); });
beforeAll(() => { vi.stubGlobal('crypto', webcrypto); });

it('drops a thread that does not contain all visible turns after retry', () => {
  const sessions = normalizeSessions([{ id: 'retry', codexThread: { id: 'thread', workDir: 'C:/project', historyKey: 'a'.repeat(64) }, messages: [
    { id: 'earlier', role: 'assistant', content: 'Retried answer' },
    { id: 'later', role: 'user', content: 'A requirement never sent to that thread' },
  ] }]);
  useAppStore.setState({ sessions });
  rememberCodexHistory('retry', false);
  expect(useAppStore.getState().sessions[0].codexThread).toBeUndefined();
  expect(useAppStore.getState().sessions[0].messages).toEqual(sessions[0].messages);
});

it('changes the thread fingerprint for equal-length edits and tool results', async () => {
  const history: Message[] = [{ id: 'user', role: 'user', content: 'old' }, { id: 'assistant', role: 'assistant', content: 'reply', actions: [{ id: 'tool', name: 'read_file', arguments: '{}', status: 'done', output: 'old' }] }];
  const original = await codexHistoryKey(history);
  expect(await codexHistoryKey([{ ...history[0], content: 'new' }, history[1]])).not.toBe(original);
  expect(await codexHistoryKey([history[0], { ...history[1], actions: [{ ...history[1].actions![0], output: 'new' }] }])).not.toBe(original);
  expect(await codexHistoryKey(history.map(message => ({ ...message, timestamp: 123 })))).toBe(original);
});

it('starts a new context after isolation and follows the selected retry variant', async () => {
  const messages: Message[] = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'one', variants: ['one', 'two'], currentVariantIndex: 0 }];
  const original = await codexHistoryKey(messages);
  expect(await codexHistoryKey([messages[0], { ...messages[1], currentVariantIndex: 1 }])).not.toBe(original);
  expect(await codexHistoryKey([...messages, { role: 'context_divider', content: '' }])).toBe(await codexHistoryKey([]));
});

it('discards malformed saved thread identities before attempting a resume', () => {
  const valid = { id: 'thread', workDir: 'C:/project', historyKey: 'a'.repeat(64) };
  expect(normalizeSessions([{ id: 'valid', codexThread: valid }])[0].codexThread).toEqual(valid);
  for (const codexThread of [null, {}, { ...valid, id: 12 }, { ...valid, workDir: null }, { ...valid, historyKey: 'invalid' }]) {
    expect(normalizeSessions([{ id: 'invalid', codexThread }])[0].codexThread).toBeUndefined();
  }
});
