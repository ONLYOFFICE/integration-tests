import { defineConfig, devices, PlaywrightTestProject } from '@playwright/test';
import 'dotenv/config';

/**
 * Shared scenarios not yet verified against every system: each project runs them only once it
 * has been checked against that system's plugin (then drop it from that project's testIgnore).
 */
const UNVERIFIED_SHARED = [
  'shared/editor-permissions.spec.ts',
  'shared/download-security.spec.ts',
  'shared/callback-security.spec.ts',
];

/**
 * The project of one system: the shared scenarios plus tests/<name>/. With `settings`, also a
 * <name>-settings project the system's project depends on, so `--project=<name>` runs it first:
 * tests/shared-settings/ (needs the adapter's connectionSettings) and tests/<name>-settings/.
 * Those change the plugin's settings for the whole stand, so they run one at a time and before
 * the scenarios that rely on working settings. A failure there skips the system's project, as
 * with any Playwright dependency.
 */
function system(name: string, options: { ignore?: string[]; settings?: boolean } = {}): PlaywrightTestProject[] {
  const project: PlaywrightTestProject = {
    name,
    testMatch: ['shared/**/*.spec.ts', `${name}/**/*.spec.ts`],
    testIgnore: options.ignore ?? [],
    // baseURL is set by the fixture from the adapter: the stack address
    // is only known once global.setup runs (see tests/global.setup.ts)
  };
  if (!options.settings) {
    return [project];
  }
  return [
    {
      name: `${name}-settings`,
      testMatch: ['shared-settings/**/*.spec.ts', `${name}-settings/**/*.spec.ts`],
      fullyParallel: false,
      workers: 1,
    },
    { ...project, dependencies: [`${name}-settings`] },
  ];
}

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
    ...system('alfresco', { ignore: UNVERIFIED_SHARED }),
    ...system('confluence', { ignore: ['shared/force-save.spec.ts', ...UNVERIFIED_SHARED] }),
    ...system('drupal', {
      ignore: [
        // The callback controller doesn't handle force-save (status 6)
        'shared/force-save.spec.ts',
        // The module has no "create new document" or conversion flow
        'shared/create-via-plugin.spec.ts',
        'shared/convert.spec.ts',
      ],
      settings: true,
    }),
    ...system('jira', { ignore: ['shared/force-save.spec.ts', ...UNVERIFIED_SHARED] }),
    ...system('liferay', { ignore: UNVERIFIED_SHARED }),
    ...system('mattermost', { ignore: ['shared/force-save.spec.ts', ...UNVERIFIED_SHARED] }),
    // The nuxeo package's callback service has no force-save handler (only editing/save/closed)
    ...system('nuxeo', { ignore: ['shared/force-save.spec.ts', ...UNVERIFIED_SHARED] }),
  ],
});
