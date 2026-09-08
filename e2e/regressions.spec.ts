import { test, expect, type Locator, type Page } from '@playwright/test';
import { emit, installFixture } from './fixture';

async function requestAt(page: Page, index = 0) {
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === 'start_agent_session').length)).toBe(index + 1);
  return page.evaluate(index => (window as any).__calls.filter((call: any) => call.command === 'start_agent_session')[index].args, index);
}

async function expectContained(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  const bounds = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(-1);
  expect(bounds.y).toBeGreaterThanOrEqual(-1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectConversationLayout(page: Page) {
  await expectContained(page.locator('.chat-textarea'), page);
  await expectContained(page.locator('.composer-send'), page);
  const header = await page.locator('.task-header > div').evaluateAll(elements => elements.map(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }));
  for (let i = 0; i < header.length; i++) {
    for (const other of header.slice(i + 1)) {
      const current = header[i];
      expect(current.x + current.width <= other.x + 1 || other.x + other.width <= current.x + 1
        || current.y + current.height <= other.y + 1 || other.y + other.height <= current.y + 1).toBe(true);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
}

test('Chat and Work change the current session while keeping its history, draft and project', async ({ page }) => {
  await installFixture(page);
  await page.goto('/');
  const modes = page.getByRole('group', { name: 'Workspace mode' });
  const draft = page.getByRole('textbox', { name: 'Message', exact: true });
  await draft.fill('Keep this draft when changing modes');
  for (const mode of ['Chat', 'Work']) {
    await modes.getByRole('button', { name: mode, exact: true }).click();
    await expect(modes.getByRole('button', { name: mode, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: 'Session recovery' })).toBeVisible();
    await expect(page.getByText('Fix persistence after a session load failure.', { exact: true })).toBeVisible();
    await expect(draft).toHaveValue('Keep this draft when changing modes');
    expect(await page.evaluate(() => localStorage.getItem('gx_current_session'))).toBe('review');
  }
  await expect(page.getByRole('button', { name: 'Choose project', exact: true })).toHaveText('gxAgent');
  expect(await page.evaluate(() => (window as any).__calls.some((call: any) => call.command === 'pick_workspace_directory'))).toBe(false);
});

test('retrying an older Codex answer preserves later turns in the next request', async ({ page }) => {
  await installFixture(page, {
    config: { code_engine: 'codex' },
    extraReviewMessages: [
      { id: 'user2', role: 'user', content: 'Preserve the later requirement to support offline mode.', timestamp: 3 },
      { id: 'answer2', role: 'assistant', content: 'Offline mode remains required.', timestamp: 4 },
    ],
  });
  await page.goto('/');
  const firstAnswer = page.locator('.chat-bubble-container.assistant').first();
  await firstAnswer.hover();
  await firstAnswer.getByRole('button', { name: 'Retry', exact: true }).click();
  const first = await requestAt(page);
  expect(JSON.stringify(first.sessionMessages)).not.toContain('support offline mode');
  await expect(page.getByRole('group', { name: 'Workspace mode' }).getByRole('button', { name: 'Chat', exact: true })).toBeDisabled();
  await emit(page, 'agent-codex-thread', { requestId: first.requestId, threadId: 'retried-thread', workDir: 'C:/projects/gxAgent', model: 'fixture-model' });
  await emit(page, 'agent-stream-done', { requestId: first.requestId, content: 'The first answer was regenerated.', authoritative: true, loopCount: 1 });
  await emit(page, 'agent-complete', { requestId: first.requestId, status: 'completed' });
  await expect(page.getByText('Offline mode remains required.', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__sessions.find((session: any) => session.id === 'review')?.codexThread)).toBeUndefined();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue with all requirements');
  await page.locator('.composer-send').click();
  const second = await requestAt(page, 1);
  expect(second.codexThreadId).toBeNull();
  expect(JSON.stringify(second.sessionMessages)).toContain('support offline mode');
  expect(JSON.stringify(second.sessionMessages)).toContain('The first answer was regenerated.');
  await emit(page, 'agent-complete', { requestId: second.requestId, status: 'cancelled' });
});

for (const planning of [false, true]) {
  test(`permission label reflects global unrestricted policy with planning=${planning}`, async ({ page }) => {
    await installFixture(page, { config: { approval_policy: 'unrestricted', plan_mode: planning } });
    await page.goto('/');
    await expect(page.locator('.composer-permission')).toHaveText(planning ? 'Read-only planning' : 'All operations trusted');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect permissions');
    await page.locator('.composer-send').click();
    const args = await requestAt(page);
    expect(args.config.approval_policy).toBe('unrestricted');
    expect(args.config.plan_mode).toBe(planning);
    await emit(page, 'agent-complete', { requestId: args.requestId, status: 'cancelled' });
  });
}

test('attachment-only turns reach the backend with no fabricated retrieval query', async ({ page }) => {
  await installFixture(page, {
    config: { learning: { knowledge_enabled: true } },
    parsedFiles: [{ name: 'private-notes.txt', path: 'C:/docs/private-notes.txt', kind: 'text', mimeType: 'text/plain', content: 'Private attachment evidence.' }],
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await expect(page.locator('.attachment-chip')).toContainText('private-notes.txt');
  await page.locator('.composer-send').click();
  const args = await requestAt(page);
  expect(args.config.learning.knowledge_enabled).toBe(true);
  expect(args.retrievalQuery).toBe('');
  expect(args.prompt).toContain('Private attachment evidence.');
  await emit(page, 'agent-complete', { requestId: args.requestId, status: 'completed' });
});

test('compact navigation fills the viewport and returns to the selected task', async ({ page }, testInfo) => {
  await installFixture(page);
  await page.goto('/');
  for (const width of [1024, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    const navigation = (await page.locator('.workbench-navigation').boundingBox())!;
    expect(navigation.x).toBe(0);
    expect(navigation.width).toBe(width);
    await expect(page.locator('.workspace-container')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`navigation-${width}.png`) });
    await page.locator('[data-session-id="review"]').click();
    await expectConversationLayout(page);
  }
});

test('panel resizing reserves conversation space and restores preferred widths', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await installFixture(page);
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('gx_sidebar_width', '400');
    localStorage.setItem('gx_right_panel_width', '900');
  });
  await page.reload();
  await page.locator('.task-panel-toggle').click();
  for (const width of [1920, 1440, 1280, 1180, 1024, 900, 801, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectConversationLayout(page);
    expect((await page.locator('.chat-panel').boundingBox())!.width).toBeGreaterThanOrEqual(359);
    await expectContained(page.locator('.review-panel'), page);
    for (const tab of await page.locator('.review-tabs > button').all()) await expectContained(tab, page);
    expect(await page.evaluate(() => localStorage.getItem('gx_right_panel_width'))).toBe('900');
    expect(await page.evaluate(() => localStorage.getItem('gx_sidebar_width'))).toBe('400');
    if ([1440, 1180, 801].includes(width)) await page.screenshot({ path: testInfo.outputPath(`split-${width}.png`) });
  }
  expect((await page.locator('.review-panel').boundingBox())!.width).toBe(900);
  expect((await page.locator('.workbench-navigation').boundingBox())!.width).toBe(400);
  await page.locator('.review-divider').focus();
  await page.keyboard.press('ArrowRight');
  expect((await page.locator('.review-panel').boundingBox())!.width).toBe(888);
  expect(await page.evaluate(() => localStorage.getItem('gx_right_panel_width'))).toBe('888');
});

for (const language of ['en', 'zh']) {
  test(`large fonts and desktop zoom viewport sizes stay usable in ${language}`, async ({ page }, testInfo) => {
    test.setTimeout(60000);
    await installFixture(page, { config: { language, font_size: 24, model: 'very-long-model-name-for-overflow-check' } });
    await page.goto('/');
    // Browser/OS scaling reduces the available CSS viewport. DPR alone does not test reflow.
    const viewports = [
      { width: 1920, height: 1080 }, { width: 1536, height: 864 },
      { width: 1280, height: 720 }, { width: 960, height: 540 },
      { width: 683, height: 384 }, { width: 390, height: 600 }, { width: 320, height: 568 },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await expectConversationLayout(page);
      const composer = page.locator('.chat-textarea');
      await composer.fill('First line\nSecond line');
      expect(await composer.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      await composer.fill('');
      await page.locator('.composer-model').click();
      await expectContained(page.locator('.model-menu'), page);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: language === 'zh' ? '\u56de\u590d\u9009\u9879' : 'Response options', exact: true }).click();
      await expectContained(page.locator('.composer-options'), page);
      await page.keyboard.press('Escape');
      await page.screenshot({ path: testInfo.outputPath(`font24-${language}-${viewport.width}.png`) });
      await page.locator('.task-header button[aria-haspopup="dialog"]').click();
      await expectContained(page.locator('.session-settings-panel'), page);
      expect(await page.locator('.session-settings-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.keyboard.press('Escape');
      if (viewport.width < 1180) await page.locator('.task-title-row .panel-toggle-btn').first().click();
      await page.locator('.workbench-global-actions').getByRole('button', { name: language === 'zh' ? '\u8bbe\u7f6e' : 'Settings', exact: true }).click();
      for (const id of ['model', 'chat', 'agent', 'tools', 'skills', 'knowledge', 'search', 'data']) {
        await page.locator(`#settings-tab-${id}`).click();
        await expectContained(page.locator('.settings-modal'), page);
        const body = await page.locator('.settings-modal-body').evaluate(element => ({ height: element.clientHeight, overflow: element.scrollWidth - element.clientWidth }));
        expect(body.height).toBeGreaterThan(120);
        expect(body.overflow).toBeLessThanOrEqual(1);
        if (viewport.width <= 800 && viewport.height <= 600) {
          const tabs = (await page.locator('.settings-tabs').boundingBox())!;
          const dialog = (await page.locator('.settings-modal').boundingBox())!;
          expect(tabs.width).toBeGreaterThan(dialog.width - 4);
          expect(tabs.height).toBeLessThanOrEqual(60);
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`settings-font24-${language}-${viewport.width}.png`) });
      await page.keyboard.press('Escape');
      if (viewport.width < 1180) await page.locator('.navigation-toggle').click();
    }
  });
}
