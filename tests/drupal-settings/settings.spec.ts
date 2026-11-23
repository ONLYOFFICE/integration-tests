import { SETTINGS_PATH } from '@adapters/drupal';
import {
  CAPTURE_EDITOR_CONFIG,
  convertWithDocumentServer,
  DocsConnection,
  loadTemplate,
  waitForEditorConfig,
} from '@core';
import { Page } from '@playwright/test';
import { editorPath, expect, saveAsUrl, test, uniqueName } from '../drupal/fixtures';
import { standDrush } from '../setup/drupal-drush';

/**
 * Module settings beyond the connection (tests/shared-settings covers that), changed for the
 * whole stand — so these run one at a time before the drupal project (playwright.config.ts) and
 * put the defaults back after each scenario.
 */

/** The module's defaults (config/install/onlyoffice.settings.yml) for the editor options */
const DEFAULT_OPTIONS = {
  chat: true,
  compact_header: false,
  feedback: false,
  help: true,
  theme: 'theme-system',
  plugins: true,
  macros: true,
  protection: 'owner',
};
type Options = typeof DEFAULT_OPTIONS;

async function saveOptions(page: Page, options: Options): Promise<void> {
  await page.goto(SETTINGS_PATH);
  for (const name of ['chat', 'compact_header', 'feedback', 'help', 'plugins', 'macros'] as const) {
    await page.locator(`input[name="${name}"]`).setChecked(options[name]);
  }
  await page.locator(`input[name="theme"][value="${options.theme}"]`).check();
  await page.locator(`input[name="protection"][value="${options.protection}"]`).check();
  await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);
  await expect(page.locator('[data-drupal-messages]')).toContainText('connection check succeeded');
}

let connection: DocsConnection;

test.beforeEach(async ({ drupal, page }) => {
  connection = await drupal.connectionSettings.read(page);
});

test.afterEach(async ({ drupal, page }) => {
  standDrush()?.('config:set', '-y', 'onlyoffice.settings', 'doc_server_jwt', connection.secret);
  const check = await drupal.connectionSettings.write(page, connection);
  expect(check.ok, `restoring the connection: ${check.message}`).toBe(true);
  await saveOptions(page, DEFAULT_OPTIONS);
});

test('the address is saved without trailing slashes', async ({ drupal, page }) => {
  await drupal.connectionSettings.write(page, { ...connection, url: `${connection.url.replace(/\/+$/, '')}///` });

  await page.goto(SETTINGS_PATH);
  await expect(page.locator('input[name="doc_server_url"]')).toHaveValue(connection.url.replace(/\/+$/, ''));
});

test('an address with a single-label host, such as a docker service name, is accepted', async ({ drupal, page }) => {
  const check = await drupal.connectionSettings.write(page, { ...connection, url: 'http://documentserver' });

  // Saved, and only the connection check fails — there is no such host on the stand
  expect(check.ok).toBe(false);
  expect(check.message).toContain('connection check failed');
  await page.goto(SETTINGS_PATH);
  await expect(page.locator('input[name="doc_server_url"]')).toHaveValue('http://documentserver');
});

test('the status report warns about a secret shorter than ONLYOFFICE Docs requires', async ({ page }) => {
  const drush = standDrush();
  test.skip(!drush, 'the form refuses short secrets; setting one needs drush on a stand the tests started');

  // A short secret only comes from settings saved before the form checked its length
  drush!('config:set', '-y', 'onlyoffice.settings', 'doc_server_jwt', 'short-secret');
  await page.goto('/admin/reports/status');
  await expect(page.getByText('ONLYOFFICE Docs secret key').first()).toBeVisible();
  await expect(page.getByText(/The secret key is shorter than \d+ characters/).first()).toBeVisible();
});

test('with protection for all users, editors other than the owner may protect the document too', async ({
  createMedia,
  drupal,
  page,
  pageAs,
}) => {
  await saveOptions(page, { ...DEFAULT_OPTIONS, protection: 'all' });
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));

  const editor = await pageAs(drupal.secondUser);
  await editor.goto(editorPath(media));
  expect((await waitForEditorConfig(editor)).document.permissions?.protect).toBe(true);
});

test('the editor options reach the editor config', async ({ createMedia, page }) => {
  await saveOptions(page, {
    chat: false,
    compact_header: true,
    feedback: true,
    help: false,
    theme: 'default-dark',
    plugins: false,
    macros: false,
    protection: 'owner',
  });
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  await page.addInitScript(CAPTURE_EDITOR_CONFIG);
  await page.goto(editorPath(media));
  const config = await waitForEditorConfig(page);

  expect(config.document.permissions?.chat).toBe(false);
  expect(config.editorConfig.customization).toMatchObject({
    compactHeader: true,
    feedback: true,
    help: false,
    uiTheme: 'default-dark',
    plugins: false,
    macros: false,
  });
});

test('"Save copy as" refuses a copy larger than the field allows', async ({ createMedia, page }) => {
  const drush = standDrush();
  test.skip(!drush, 'changing the field limit needs drush on a stand the tests started');
  const setLimit = (limit: string) =>
    drush!(
      'php:eval',
      `$field = \\Drupal\\field\\Entity\\FieldConfig::loadByName('media', 'document', 'field_media_document');
       $field->setSetting('max_filesize', '${limit}')->save();`,
    );

  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  await page.addInitScript(CAPTURE_EDITOR_CONFIG);
  await page.goto(editorPath(media));
  const config = await waitForEditorConfig(page);
  const copyUrl = await convertWithDocumentServer(config.document.url, 'docx');
  const url = (await saveAsUrl(page, media))!;

  setLimit('1 KB');
  try {
    const response = await page.request.post(url, { data: { title: uniqueName('docx'), fileType: 'docx', url: copyUrl } });
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/exceed|size/i);
  } finally {
    setLimit('');
  }
});
