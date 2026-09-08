import { test, expect } from '@playwright/test';
import { emit, installFixture } from './fixture';

test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Session recovery' })).toBeVisible();
});

test('unified navigation preserves drafts and supports per-project task creation', async ({ page }) => {
  await expect(page.locator('[data-session-id="chat"]')).toBeVisible();
  await expect(page.locator('.review-panel')).toBeHidden();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Task draft');
  await page.locator('[data-session-id="chat"]').click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Chat draft');
  await page.locator('[data-session-id="review"]').click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Task draft');
  await page.getByRole('button', { name: 'New task in gxAgent', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What should we get done?' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === 'pick_workspace_directory').length)).toBe(0);
  await expect(page.getByRole('button', { name: 'Choose project', exact: true })).toHaveText('gxAgent');
});

test('file read errors retry successfully and selected files stay with their task', async ({ page }) => {
  await page.locator('.task-panel-toggle').click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.locator('.workspace-tree-main').filter({ hasText: /^src$/ }).click();
  await page.evaluate(() => { (window as any).__fileFailure = true; });
  await page.locator('.workspace-tree-main').filter({ hasText: 'App.tsx' }).click();
  await expect(page.getByRole('alert')).toContainText('Temporary read failure');
  await page.evaluate(() => { (window as any).__fileFailure = false; });
  await page.locator('.workspace-file-view').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.workspace-file-view pre')).toContainText('ready = true');
  await page.locator('[data-session-id="performance"]').click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.locator('.workspace-file-view')).toContainText('No file selected');
  await page.locator('[data-session-id="review"]').click();
  await expect(page.locator('.workspace-file-view pre')).toContainText('ready = true');
});

test('Codex turns handle approval, questions, continuation and interruption', async ({ page }, testInfo) => {
  await page.locator('[data-session-id="performance"]').click();
  await page.getByRole('button', { name: 'Response options' }).click();
  await page.getByRole('combobox', { name: 'Coding engine', exact: true }).selectOption('codex');
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect the fixture project');
  await page.locator('.composer-send').click();
  await expect.poll(async () => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === 'start_agent_session').length)).toBe(1);
  const first = await page.evaluate(() => (window as any).__calls.find((call: any) => call.command === 'start_agent_session').args);
  expect(first.config.code_engine).toBe('codex');
  await emit(page, 'agent-codex-thread', { requestId: first.requestId, threadId: 'thread-fixture', workDir: 'C:/projects/gxAgent', model: 'fixture-model' });
  await emit(page, 'agent-checkpoint', { requestId: first.requestId, status: 'created', reference: 'refs/gxagent/checkpoints/fixture', commit: '1'.repeat(40), createdAt: 1, label: 'before Codex turn' });
  await emit(page, 'agent-tool-approval-request', { requestId: first.requestId, request_id: 'codex-approval-fixture', source: 'codex', tool_calls: [{ id: 'command', name: 'execute_command', arguments: '{"command":"npm test"}', approval_level: 'confirm' }] });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await emit(page, 'agent-tool-approval-resolved', { requestId: first.requestId, approvalRequestId: 'codex-approval-fixture', itemId: 'command', approved: true });
  await emit(page, 'agent-tool-output', { requestId: first.requestId, id: 'command', name: 'execute_command', arguments: '{"command":"npm test"}', output: 'Tests passed' });
  await emit(page, 'agent-codex-question', { requestId: first.requestId, question: { interactionId: 'question-fixture', questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?', options: [{ label: 'Current project', description: 'Use the selected project.' }] }] } });
  await page.getByRole('radio').check();
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.locator('.agent-question')).toBeHidden();
  await emit(page, 'agent-stream-done', { requestId: first.requestId, content: 'Fixture completed', authoritative: true, loopCount: 1 });
  await expect(page.getByText('Fixture completed', { exact: true })).toBeVisible();
  await emit(page, 'agent-complete', { requestId: first.requestId, status: 'completed' });
  await page.locator('.task-panel-toggle').click();
  await expect(page.locator('.review-file')).toContainText('src/App.tsx');
  await expect(page.locator('.review-diff')).toContainText('const ready = false;');
  await page.screenshot({ path: testInfo.outputPath('codex-run-review.png') });
  await expect.poll(async () => page.evaluate(() => (window as any).__sessions.find((session: any) => session.id === 'performance')?.codexThread?.historyKey?.length)).toBe(64);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue the fixture');
  await page.locator('.composer-send').click();
  await expect.poll(async () => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === 'start_agent_session').length)).toBe(2);
  const second = await page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === 'start_agent_session')[1].args);
  expect(second.codexThreadId).toBe('thread-fixture');
  await page.locator('.composer-send').click();
  await emit(page, 'agent-complete', { requestId: second.requestId, status: 'cancelled' });
  await expect(page.locator('.composer-send')).not.toHaveClass(/stopping/);
});

test('desktop and narrow layouts remain usable in both themes', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-session-id="performance"]').click();
  await page.screenshot({ path: testInfo.outputPath('desktop-light.png') });
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('desktop-dark.png') });
  for (const width of [1024, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.getByRole('button', { name: 'Response options' }).click();
    const bounds = await page.locator('.composer-options').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: testInfo.outputPath(`narrow-${width}.png`) });
  }
  expect(errors).toEqual([]);
});

test('approval and question retries preserve the next queued interaction', async ({ page }) => {
  await page.locator('[data-session-id="performance"]').click();
  await page.getByRole('button', { name: 'Response options' }).click();
  await page.getByRole('combobox', { name: 'Coding engine', exact: true }).selectOption('codex');
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Test pending interactions');
  await page.locator('.composer-send').click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.some((call: any) => call.command === 'start_agent_session'))).toBe(true);
  const requestId = await page.evaluate(() => (window as any).__calls.find((call: any) => call.command === 'start_agent_session').args.requestId);
  const approval = (id: string) => ({ requestId, request_id: id, source: 'codex', tool_calls: [{ id, name: 'execute_command', arguments: JSON.stringify({ command: id }), approval_level: 'confirm' }] });
  await emit(page, 'agent-tool-approval-request', approval('first-action'));
  await page.evaluate(next => { (window as any).__approvalFailure = true; (window as any).__nextApproval = next; }, approval('second-action'));
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Approval connection interrupted');
  await page.evaluate(() => { (window as any).__approvalFailure = false; });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.approval-card:visible')).toContainText('second-action');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.locator('.approval-card:visible')).toHaveCount(0);
  const question = (id: string) => ({ requestId, question: { interactionId: id, questions: [{ id: 'scope', header: 'Scope', question: id, options: [{ label: 'Current project', description: 'Use the selected project.' }] }] } });
  await emit(page, 'agent-codex-question', question('First question'));
  await page.evaluate(next => { (window as any).__questionFailure = true; (window as any).__nextQuestion = next; }, question('Second question'));
  await page.getByRole('radio').check();
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Answer connection interrupted');
  await page.evaluate(() => { (window as any).__questionFailure = false; });
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.locator('.agent-question')).toContainText('Second question');
  await page.getByRole('textbox', { name: 'Scope', exact: true }).fill('Custom scope');
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  await expect(page.locator('.agent-question')).toBeHidden();
  await emit(page, 'agent-complete', { requestId, status: 'cancelled' });
});

test('settings and review remain contained on desktop and narrow Chinese layouts', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  for (const language of ['en', 'zh']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(value => localStorage.setItem('fixture_language', value), language);
    await page.reload();
    await page.locator('.workbench-global-actions').getByRole('button', { name: language === 'zh' ? '设置' : 'Settings', exact: true }).click();
    const dialog = page.locator('.settings-modal');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const id of ['model', 'chat', 'agent', 'tools', 'skills', 'knowledge', 'search', 'data']) {
        await page.locator(`#settings-tab-${id}`).click();
        await expect(page.locator(`#settings-panel-${id}`)).toBeVisible();
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await page.locator('.settings-modal-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        if (language === 'zh' && ['skills', 'knowledge'].includes(id)) {
          await page.screenshot({ path: testInfo.outputPath(`${id}-${language}-${width}.png`) });
        }
      }
      await page.locator('#settings-tab-model').click();
      await page.screenshot({ path: testInfo.outputPath(`settings-${language}-${width}.png`) });
    }
    await page.keyboard.press('Escape');
    await page.locator('.mobile-workspace-tabs').getByRole('button', { name: language === 'zh' ? '审查' : 'Workspace', exact: true }).click();
    await expect(page.locator('.review-panel')).toBeVisible();
    for (const id of ['changes', 'files', 'activity', 'context', 'preview']) {
      await page.locator(`#workspace-tab-${id}`).click();
      await expect(page.locator(`#workspace-panel-${id}`)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    }
    await page.locator('#workspace-tab-changes').click();
    await page.screenshot({ path: testInfo.outputPath(`review-${language}-320.png`) });
  }
});
