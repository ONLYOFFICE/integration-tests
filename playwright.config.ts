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
      // baseURL is set by the fixture from the adapter: the stack address
      // is only known once global.setup runs (see tests/global.setup.ts)
    },
    {
      name: 'confluence',
      testMatch: ['shared/**/*.spec.ts', 'confluence/**/*.spec.ts'],
      testIgnore: ['shared/force-save.spec.ts'],
    },
    {
      name: 'jira',
      testMatch: ['shared/**/*.spec.ts', 'jira/**/*.spec.ts'],
      testIgnore: ['shared/force-save.spec.ts'],
    },
  ],
});
