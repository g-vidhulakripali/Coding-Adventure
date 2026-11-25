import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production build, served from a sub-path by a
 * plain static file server: the same situation as on a free static host.
 *
 * Locally the installed Chrome and Edge are used. Set E2E_BROWSERS to a list such as
 * "chromium,firefox,webkit" to use Playwright's own browsers (as the CI workflow does).
 */
const own = process.env.E2E_BROWSERS?.split(',').map((s) => s.trim());
const engines = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] };

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4321/code-playground/', viewport: { width: 1500, height: 950 }, trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/server.mjs', url: 'http://127.0.0.1:4321/code-playground/', reuseExistingServer: !process.env.CI },
  projects: own
    ? own.map((name) => ({ name, use: { ...engines[name as keyof typeof engines], viewport: { width: 1500, height: 950 } } }))
    : [
        { name: 'chrome', use: { channel: 'chrome' } },
        { name: 'edge', use: { channel: 'msedge' } },
      ],
});
