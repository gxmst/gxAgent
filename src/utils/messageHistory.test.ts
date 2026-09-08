import { describe, expect, it } from 'vitest';
import type { Message, ToolAction } from '../types';
import { normalizeMessage } from '../appDefaults';
import { activeHistoryGroups, estimateApiMessageTokens, selectMessageVariant, serializeMessageForApi } from './messageHistory';

const action: ToolAction = { id: 'call_0', name: 'read_file', arguments: '{"path":"first.txt"}', output: 'first file contents', status: 'done' };

describe('tool history', () => {
  it('keeps tool-only turns and matching results in execution order', () => {
    const messages = serializeMessageForApi({ id: 'assistant', role: 'assistant', content: '', actions: [action, { ...action, name: 'edit_file', status: 'error', output: 'Error: missing replacement' }] });
    expect(messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
    expect(messages[0].tool_calls?.[0].function).toEqual({ name: action.name, arguments: action.arguments });
    expect(messages[1].tool_call_id).toBe(messages[0].tool_calls?.[0].id);
    expect(messages[1].content).toBe('first file contents');
    expect(messages[3].tool_call_id).toBe(messages[2].tool_calls?.[0].id);
    expect(messages[3].content).toContain('Error:');
  });

  it('does not claim that incomplete or blocked tools succeeded', () => {
    const messages = serializeMessageForApi({ role: 'assistant', content: '', actions: [
      { ...action, status: 'drafting' },
      { ...action, status: 'executing', output: undefined },
      { ...action, status: 'blocked', output: undefined },
      { ...action, status: 'error', arguments: '{broken', output: undefined },
    ] });
    expect(messages).toHaveLength(6);
    expect(messages[1].content).toContain('interrupted');
    expect(messages[3].content).toContain('blocked');
    expect(messages[5].content).toContain('Invalid tool arguments');
  });

  it('groups all exchanges by source and gives repeated legacy ids distinct API ids', () => {
    const groups = activeHistoryGroups([
      { role: 'assistant', content: 'discarded' },
      { role: 'context_divider', content: '' },
      { id: 'one', role: 'assistant', content: 'one', actions: [action, action] },
      { id: 'two', role: 'assistant', content: 'two', actions: [action] },
    ]);
    expect(groups.map((group) => group.serialized.length)).toEqual([5, 3]);
    expect(groups[0].source.id).toBe('one');
    const ids = groups.flatMap((group) => group.serialized.flatMap((message) => message.tool_calls?.map((call) => call.id) || []));
    expect(new Set(ids).size).toBe(3);
  });

  it('counts large tool arguments and results toward the context budget', () => {
    const messages = serializeMessageForApi({ role: 'assistant', content: '', actions: [{ ...action, arguments: JSON.stringify({ content: 'x'.repeat(12000) }), output: 'x'.repeat(12000) }] });
    expect(messages.map(estimateApiMessageTokens).every((tokens) => tokens > 2000)).toBe(true);
  });

  it('preserves attachments in user history', () => {
    const messages = serializeMessageForApi({ role: 'user', content: 'inspect', attachments: [
      { name: 'image.png', type: 'image', data: 'image-data' },
      { name: 'file.txt', type: 'text', data: 'file content' },
    ] });
    expect(messages[0].attachments).toHaveLength(1);
    expect(messages[0].content).toContain('file content');
  });

  it('restores each variant with its own actions across save and reload', () => {
    const latestAction = { ...action, arguments: '{"path":"second.txt"}' };
    const latest: Message = { role: 'assistant', content: 'second', variants: ['first', 'second'], currentVariantIndex: 1, actionVariants: [[action], []], actions: [latestAction] };
    const first = selectMessageVariant(latest, 0);
    const reloaded = normalizeMessage(JSON.parse(JSON.stringify(first)))!;
    expect(serializeMessageForApi(reloaded)[0].tool_calls?.[0].function.arguments).toBe(action.arguments);
    expect(selectMessageVariant(reloaded, 1).actions).toEqual([latestAction]);
    const legacy = normalizeMessage({ ...latest, actionVariants: undefined, content: 'first', currentVariantIndex: 0 })!;
    expect(serializeMessageForApi(legacy)).toEqual([{ role: 'assistant', content: 'first' }]);
    expect(selectMessageVariant(legacy, 1).actions).toEqual([latestAction]);
  });
});
