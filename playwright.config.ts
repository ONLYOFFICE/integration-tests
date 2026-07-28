import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/global.setup.ts',
  globalTeardown: './tests/global.teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  // The editor doesn't load quickly, and saving arrives via an async callback
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'alfresco',
      testMatch: ['shared/**/*.spec.ts', 'alfresco/**/*.spec.ts'],
      use: {
        baseURL: process.env.ALFRESCO_URL ?? 'http://localhost:8080',
      },
    },
    // Additional connectors are added the same way:
    // { name: 'confluence', testMatch: ['shared/**/*.spec.ts', 'confluence/**/*.spec.ts'], use: { baseURL: ... } },
  ],
});
