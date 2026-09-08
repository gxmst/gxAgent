// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyWorkspaceState } from '../../appDefaults';
import { RunReviewPanel } from './RunReviewPanel';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null }); });
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const review = (diff: string) => ({ repositoryRoot: 'C:/project', version: diff, entries: [{ path: 'src/app.ts', status: 'M', diff }] });
function props() {
  return {
    lang: 'en', checkpoint: { reference: 'refs/gxagent/checkpoints/first', workDir: 'C:/project', commit: 'first', createdAt: 1, label: 'before' },
    workspace: createEmptyWorkspaceState(), modifiedFiles: {}, disabled: false,
    onRefresh: vi.fn(), onSelectGit: vi.fn(), onRestoreGit: vi.fn(), onKeep: vi.fn(), onRestore: vi.fn(),
  };
}

it('invalidates the reviewed mark when the file changes on refresh', async () => {
  const initial = props();
  vi.mocked(invoke).mockResolvedValueOnce(review('first difference'));
  const view = render(<RunReviewPanel {...initial} />);
  await screen.findByText('first difference');
  fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
  expect(screen.getByText('1 / 1 reviewed')).toBeTruthy();
  vi.mocked(invoke).mockResolvedValueOnce(review('new difference'));
  view.rerender(<RunReviewPanel {...initial} workspace={{ ...initial.workspace, entries: [] }} />);
  await screen.findByText('new difference');
  expect(screen.getByText('0 / 1 reviewed')).toBeTruthy();
});

it('discards a late response from an earlier checkpoint', async () => {
  const initial = props();
  let resolve!: (value: ReturnType<typeof review>) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
  const view = render(<RunReviewPanel {...initial} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  vi.mocked(invoke).mockResolvedValueOnce(review('current difference'));
  view.rerender(<RunReviewPanel {...initial} checkpoint={{ ...initial.checkpoint, reference: 'refs/gxagent/checkpoints/second' }} />);
  await screen.findByText('current difference');
  await act(async () => { resolve(review('obsolete difference')); });
  expect(screen.queryByText('obsolete difference')).toBeNull();
  expect(screen.getByText('current difference')).toBeTruthy();
});
