import { expect, test } from '@playwright/test';
import { installFixture } from './fixture';

const oldProfile = { name: 'Office', provider: 'openai', wire_format: 'openai', base_url: 'https://old.example.invalid/v1', api_key: 'fake-old-key', default_model: 'private-model', models: ['private-model', 'other-model'] };
async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('.workbench-global-actions').getByRole('button', { name: 'Settings', exact: true }).click();
}

test('adding a provider isolates credentials and cancelling preserves the default', async ({ page }) => {
  await installFixture(page, { config: { ...oldProfile, model: oldProfile.default_model, active_profile: 'legacy-id', profiles: { 'legacy-id': oldProfile } } });
  await openSettings(page);
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByRole('button', { name: 'OpenAI', exact: true }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await page.getByLabel('Connection name', { exact: true }).fill('New provider');
  await page.getByLabel('API key', { exact: true }).fill('fake-new-key');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.connection-current')).toContainText('Office');
  expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.command === 'save_profile' || call.command === 'save_config').length)).toBe(0);
});

test('directory errors permit private model IDs and connection save errors retain the form', async ({ page }, testInfo) => {
  await installFixture(page);
  await openSettings(page);
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Private gateway');
  await page.getByLabel('API base URL', { exact: true }).fill('https://private.example.invalid/v1');
  await page.getByLabel('API key', { exact: true }).fill('fake-private-key');
  await page.getByRole('combobox', { name: 'Default model', exact: true }).fill('private-model');
  await page.getByLabel('Connection name', { exact: true }).click();
  await page.evaluate(() => { (window as any).__modelDirectoryFailure = true; (window as any).__profileSaveFailure = true; });
  await page.getByRole('button', { name: 'Check connection & fetch models', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Directory unavailable');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Profile disk unavailable');
  await expect(page.getByRole('combobox', { name: 'Default model', exact: true })).toHaveValue('private-model');
  await page.evaluate(() => { (window as any).__profileSaveFailure = false; });
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.locator('.connection-card')).toContainText('Private gateway');
  await page.screenshot({ path: testInfo.outputPath('connections.png') });
  const saved = await page.evaluate(() => (window as any).__config);
  expect(saved).toMatchObject({ base_url: 'https://private.example.invalid/v1', api_key: 'fake-private-key', model: 'private-model', wire_format: 'openai' });
});

test('renaming a connection preserves its stable ID and synchronizes the default', async ({ page }) => {
  await installFixture(page, { config: { ...oldProfile, model: oldProfile.default_model, active_profile: 'legacy-id', profiles: { 'legacy-id': oldProfile } } });
  await openSettings(page);
  await page.getByRole('button', { name: 'Edit Office', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Renamed office');
  await page.getByRole('combobox', { name: 'Default model', exact: true }).fill('new-private-model');
  await page.getByLabel('Connection name', { exact: true }).click();
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.locator('.connection-current')).toContainText('Renamed office');
  expect(await page.evaluate(() => (window as any).__config.active_profile)).toBe('legacy-id');
  expect(await page.evaluate(() => (window as any).__config.model)).toBe('new-private-model');
});

test('copy clears secrets, duplicate names are rejected, and deleting requires a deliberate replacement', async ({ page }) => {
  await installFixture(page, { config: { ...oldProfile, model: oldProfile.default_model, active_profile: 'legacy-id', profiles: { 'legacy-id': oldProfile, other: { ...oldProfile, name: 'Other', api_key: 'fake-other-key', default_model: 'other-model' } } } });
  await openSettings(page);
  await page.getByRole('button', { name: 'Copy Office', exact: true }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await page.getByLabel('Connection name', { exact: true }).fill('Other');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Office', exact: true }).click();
  await expect(page.locator('.connection-card')).toHaveCount(0);
  await page.getByLabel('Replacement connection', { exact: true }).selectOption('other');
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await expect(page.locator('.connection-current')).toContainText('Other');
  expect(await page.evaluate(() => (window as any).__config.active_profile)).toBe('other');
});

test('a failed global save keeps settings open', async ({ page }) => {
  await installFixture(page);
  await openSettings(page);
  await page.evaluate(() => { (window as any).__configSaveFailure = true; });
  await page.locator('.settings-modal-footer button').click();
  await expect(page.locator('.settings-modal')).toBeVisible();
  await expect(page.locator('.settings-modal-footer [role=status]')).toContainText('failed');
});

test('connection editor fits small Chinese windows with keyboard model entry', async ({ page }, testInfo) => {
  await installFixture(page, { config: { language: 'zh' } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Session recovery', exact: true })).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: '添加供应商', exact: true }).click();
  await page.getByRole('combobox', { name: '默认模型', exact: true }).fill('私有模型');
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-modal')).toBeVisible();
  expect(await page.locator('.settings-modal-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('connection-editor-zh-390.png') });
});

test('MCP arguments preserve commas and invalid environment lines are shown inline', async ({ page }) => {
  await installFixture(page);
  await openSettings(page);
  await page.locator('#settings-tab-tools').click();
  await page.getByRole('button', { name: 'Add Server', exact: true }).click();
  await page.getByLabel('Server Name', { exact: true }).fill('comma-server');
  await page.getByLabel('Start Command', { exact: true }).fill('node');
  await page.getByLabel('Arguments (JSON array or one per line)', { exact: true }).fill('["tool.js", "a,b", "C:\\\\My Files"]');
  await page.getByLabel('Environment variables (NAME=value, one per line)', { exact: true }).fill('invalid line');
  await page.getByRole('button', { name: 'Add Server', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('NAME=value');
  await page.getByLabel('Environment variables (NAME=value, one per line)', { exact: true }).fill('TOKEN=a=b');
  await page.getByRole('button', { name: 'Add Server', exact: true }).click();
  const saved = await page.evaluate(() => (window as any).__calls.find((call: any) => call.command === 'save_mcp_server').args);
  expect(saved.args).toEqual(['tool.js', 'a,b', 'C:\\My Files']);
  expect(saved.env).toEqual({ TOKEN: 'a=b' });
});

test('keyboard navigation and outside dismissal keep a connection draft', async ({ page }) => {
  await installFixture(page);
  await openSettings(page);
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Unsaved gateway');
  await page.locator('#settings-tab-model').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('Connection name', { exact: true })).toHaveValue('Unsaved gateway');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect(page.getByLabel('Connection name', { exact: true })).toHaveValue('Unsaved gateway');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#settings-tab-model').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#settings-tab-chat')).toHaveAttribute('aria-selected', 'true');
});
