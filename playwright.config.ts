import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT || 1421);
const url = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: './.shots/workbench',
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: url,
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 5000,
    screenshot: 'only-on-failure',
  },
  webServer: { command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`, url, reuseExistingServer: false },
});
