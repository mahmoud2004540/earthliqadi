import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end tests against the running Docker Compose stack
 * (`docker compose up --build -d`). They use the real edge proxy, API, engine,
 * WebSocket gateway and web app. Never point this at a shared environment.
 */
export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } },
    },
  ],
});
