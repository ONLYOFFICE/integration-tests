import { Page, Route } from '@playwright/test';
import { readSettings, ValidationResults } from '@adapters/nuxeo';
import { expect, test } from '../fixtures';
import { NuxeoWebUi } from '../web-ui';

/**
 * The package's settings page in Web UI's administration (onlyoffice-settings). Saving is answered
 * here instead of by the server: the stand's settings are shared by the scenarios running in
 * parallel, and the page's handling of each answer is what is under test.
 */

const SETTINGS = '**/nuxeo/api/v1/onlyoffice/settings';
const ALL_PASSED: ValidationResults = {
  documentServer: { status: 'success' },
  commandService: { status: 'success' },
  convertService: { status: 'success' },
};

/** Answers the page's saves with these check results; returns the bodies it posted */
async function answerSaves(page: Page, validationResults: ValidationResults): Promise<Record<string, unknown>[]> {
  const posted: Record<string, unknown>[] = [];
  await page.route(SETTINGS, (route: Route) => {
    if (route.request().method() !== 'POST') {
      return route.continue();
    }
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { validationResults } });
  });
  return posted;
}

test('the settings page is in the administration menu of administrators only', async ({ nuxeo, pageAs, webUi }) => {
  await webUi.openSettings();
  await expect(webUi.settingsMenuItem).toHaveCount(1);

  const user = new NuxeoWebUi(await pageAs(nuxeo.secondUser));
  await user.goto('admin/onlyoffice-settings');
  await user.page.waitForLoadState('networkidle');
  await expect(user.page.locator('nuxeo-app:not([unresolved])')).toHaveCount(1);
  await expect(user.settingsMenuItem).toHaveCount(0);
  await expect(user.page.locator('onlyoffice-settings')).toHaveCount(0);
});

test('the form shows the stored settings', async ({ page, webUi }) => {
  const stored = await readSettings(page);
  await webUi.openSettings();

  await expect(webUi.settingsInput('doc-url')).toHaveValue(stored.url);
  await expect(webUi.settingsInput('jwt-secret')).toHaveValue(stored.security?.key ?? '');
  await expect(webUi.settingsInput('jwt-header')).toHaveValue(stored.security?.header ?? '');
});

test('saving posts the form and reports success when every check passes', async ({ page, webUi }) => {
  const stored = await readSettings(page);
  const posted = await answerSaves(page, ALL_PASSED);
  await webUi.openSettings();

  await webUi.settingsSaveButton.click();

  await expect.poll(() => webUi.notifications()).toEqual(['Settings were successfully saved']);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ url: stored.url });
});

// The settings are saved whatever the checks say: the page shows that they are, and on screen at
// the same time, in a toast of its own, which check failed
test('a failed check is reported along with the saved settings', async ({ page, webUi }) => {
  await answerSaves(page, { ...ALL_PASSED, commandService: { status: 'failed', error: 'TOKEN' } });
  await webUi.openSettings();

  await webUi.settingsSaveButton.click();

  const messages = ['Error when trying to check CommandService (Invalid token).', 'Settings were successfully saved'];
  await expect.poll(() => webUi.notifications()).toEqual(messages);
  await expect.poll(async () => (await webUi.openToasts()).sort()).toEqual([...messages].sort());
});

// Review 3.3: a check failed with an error code the SDK doesn't know comes without `error`
test('a check failed with an unknown error does not turn into an error of saving', async ({ page, webUi }) => {
  await answerSaves(page, { ...ALL_PASSED, commandService: { status: 'failed' } });
  await webUi.openSettings();

  await webUi.settingsSaveButton.click();

  await expect
    .poll(() => webUi.notifications())
    .toEqual(['Error when trying to check CommandService (Unknown error).', 'Settings were successfully saved']);
});

// Review 5.3: Save isn't disabled while saving
test('a double click on Save saves once', async ({ page, webUi }) => {
  test.fail();
  const posted = await answerSaves(page, ALL_PASSED);
  await webUi.openSettings();

  await webUi.settingsSaveButton.dblclick();
  await expect.poll(() => posted.length).toBeGreaterThan(0);
  await page.waitForTimeout(2_000);

  expect(posted).toHaveLength(1);
});

// Review 5.3: a settings page that failed to load throws on Save and says nothing
test('settings that failed to load are reported', async ({ page, webUi }) => {
  test.fail();
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.route(SETTINGS, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 500, json: {} }) : route.continue(),
  );
  await webUi.openSettings();

  await expect.poll(() => webUi.notifications()).not.toEqual([]);
  await webUi.settingsSaveButton.click();
  expect(errors.map((error) => error.message)).toEqual([]);
});
