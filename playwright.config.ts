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
      name: 'drupal',
      testMatch: ['shared/**/*.spec.ts', 'drupal/**/*.spec.ts'],
      testIgnore: [
        // The callback controller doesn't handle force-save (status 6)
        'shared/force-save.spec.ts',
        // The module has no "create new document" or conversion flow
        'shared/create-via-plugin.spec.ts',
        'shared/convert.spec.ts',
      ],
    },
    {
      name: 'jira',
      testMatch: ['shared/**/*.spec.ts', 'jira/**/*.spec.ts'],
      testIgnore: ['shared/force-save.spec.ts'],
    },
    {
      name: 'liferay',
      testMatch: ['shared/**/*.spec.ts', 'liferay/**/*.spec.ts'],
    },
    {
      name: 'mattermost',
      testMatch: ['shared/**/*.spec.ts', 'mattermost/**/*.spec.ts'],
      testIgnore: ['shared/force-save.spec.ts'],
    },
    {
      name: 'nuxeo',
      testMatch: ['shared/**/*.spec.ts', 'nuxeo/**/*.spec.ts'],
      // The package's callback service has no force-save handler (only editing/save/closed)
      testIgnore: ['shared/force-save.spec.ts'],
    },
  ],
});
