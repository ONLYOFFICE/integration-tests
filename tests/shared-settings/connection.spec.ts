import { CAPTURE_EDITOR_CONFIG, ConnectionSettings, DocsConnection, downloadHeaders, documentServer, waitForEditorConfig } from '@core';
import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

/**
 * The plugin's connection settings, changed the way an administrator does it. These run one at a
 * time before the system's other scenarios (see system() in playwright.config.ts), and each puts
 * the settings it found back — checking the plugin accepts them again.
 */

let settings: ConnectionSettings;
let original: DocsConnection | undefined;

test.beforeEach(async ({ adapter, page }) => {
  original = undefined;
  test.skip(!adapter.connectionSettings, `the ${adapter.name} adapter cannot change the connection settings`);
  settings = adapter.connectionSettings!;
  original = await settings.read(page);
});

test.afterEach(async ({ page }) => {
  if (!original) {
    return;
  }
  const check = await settings.write(page, original!);
  expect(check.ok, `restoring the settings: ${check.message}`).toBe(true);
});

/** The file link the plugin hands Docs, read from the editor page without waiting for Docs to open it */
async function downloadUrlOf(page: Page, open: (page: Page) => Promise<void>): Promise<string> {
  await page.addInitScript(CAPTURE_EDITOR_CONFIG);
  await open(page);
  return (await waitForEditorConfig(page)).document.url;
}

async function servesFile(response: Response): Promise<boolean> {
  return response.ok && (await response.arrayBuffer()).byteLength > 0;
}

test('the connection check refuses a secret Document Server does not share, and the editor works again once it is restored', async ({
  createFile,
  openEditor,
  page,
}) => {
  const check = await settings.write(page, { ...original!, secret: 'not-the-document-server-secret-0123456789' });
  expect(check.ok, check.message).toBe(false);

  await settings.write(page, original!);
  const editor = await openEditor(await createFile('docx'));
  await expect(editor.frame.locator('#toolbar')).toBeVisible();
});

test('the connection check refuses an address where no Document Server answers', async ({ page }) => {
  const check = await settings.write(page, { ...original!, url: 'http://127.0.0.1:9/' });
  expect(check.ok, check.message).toBe(false);
});

test('with a custom JWT header the file link takes the token there and ignores Authorization', async ({
  adapter,
  createFile,
  page,
}) => {
  const header = 'AuthorizationJwt';
  await settings.write(page, { ...original!, header });
  const file = await createFile('docx');
  const url = await downloadUrlOf(page, (page) => adapter.openInEditor(page, file));
  const { secret } = documentServer();

  expect(await servesFile(await fetch(url, { headers: downloadHeaders(url, secret, { header }) })), header).toBe(true);
  expect(
    await servesFile(await fetch(url, { headers: downloadHeaders(url, secret, { header: 'Authorization' }) })),
    'Authorization',
  ).toBe(false);
});

test('with JWT off in the plugin the editor config is unsigned and the file link needs no token', async ({
  adapter,
  createFile,
  page,
}) => {
  await settings.write(page, { ...original!, secret: '' });
  const file = await createFile('docx');
  await page.addInitScript(CAPTURE_EDITOR_CONFIG);
  await adapter.openInEditor(page, file);
  const config = await waitForEditorConfig(page);

  expect(config.token).toBeUndefined();
  expect(await servesFile(await fetch(config.document.url))).toBe(true);
});
