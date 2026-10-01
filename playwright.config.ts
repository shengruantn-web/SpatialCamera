import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', workers: 1, timeout: 60_000,
  webServer: { command: 'npm run dev -- --port 3000', url: 'http://localhost:3000', reuseExistingServer: true, timeout: 120_000 },
  use: { baseURL: 'http://localhost:3000', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL, viewport: { width: 1200, height: 750 }, launchOptions: { args: ['--enable-unsafe-swiftshader'] } },
});
