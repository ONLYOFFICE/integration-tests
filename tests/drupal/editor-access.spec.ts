import { devices } from '@playwright/test';
import { EditorPage, loadConvertTemplate, loadTemplate, waitForEditorConfig } from '@core';
import { editorPath, expect, saveAsUrl, test, uniqueName } from './fixtures';

test('an anonymous visitor cannot open the editor', async ({ createMedia, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const page = await pageAs(null);

  expect((await page.goto(editorPath(media)))?.status()).toBe(403);
});

test('the editor of an unpublished media is closed to a user who cannot view it', async ({
  createMedia,
  drupal,
  pageAs,
}) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const page = await pageAs(drupal.readOnlyUser);
  expect((await page.goto(editorPath(media)))?.status(), 'published').toBe(200);

  await drupal.api.setPublished(media.uuid, false);
  expect((await page.goto(editorPath(media)))?.status(), 'unpublished').toBe(403);
});

test('the editor of a missing media answers 404', async ({ page }) => {
  expect((await page.goto('/admin/media/999999999/onlyoffice-editor'))?.status()).toBe(404);
});

test('the editor route takes only a numeric media id', async ({ page }) => {
  expect((await page.goto('/admin/media/not-a-number/onlyoffice-editor'))?.status()).toBe(404);
});

test('a mobile browser gets the mobile editor', async ({ createMedia, drupal, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const page = await pageAs(drupal.defaultUser, { userAgent: devices['iPhone 13'].userAgent });
  await page.goto(editorPath(media));

  expect((await waitForEditorConfig(page)).type).toBe('mobile');
});

test('a user who may edit only own documents edits them and views the others', async ({
  createMedia,
  drupal,
  pageAs,
}) => {
  const own = await createMedia(uniqueName('docx'), loadTemplate('docx'), { owner: drupal.ownerUser });
  const others = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const page = await pageAs(drupal.ownerUser);

  await page.goto(editorPath(own));
  const ownConfig = await waitForEditorConfig(page);
  expect(ownConfig.editorConfig.mode, 'own document').toBe('edit');
  expect(ownConfig.editorConfig.callbackUrl, 'own document').toBeTruthy();

  await page.goto(editorPath(others));
  const othersConfig = await waitForEditorConfig(page);
  expect(othersConfig.editorConfig.mode, "another user's document").toBe('view');
  expect(othersConfig.editorConfig.callbackUrl, "another user's document").toBeFalsy();
});

test('"Save copy as" is offered only to users who may create documents', async ({ createMedia, drupal, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));

  expect(await saveAsUrl(await pageAs(drupal.defaultUser), media), 'admin').toBeTruthy();
  expect(await saveAsUrl(await pageAs(drupal.ownerUser), media), 'a user who can create documents').toBeTruthy();
  expect(await saveAsUrl(await pageAs(drupal.secondUser), media), 'an editor who cannot create documents').toBeNull();
  expect(await saveAsUrl(await pageAs(drupal.readOnlyUser), media), 'a viewer').toBeNull();
});

test('by default only the owner of a document may protect it', async ({ createMedia, drupal, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));

  const owner = await pageAs(drupal.defaultUser);
  await owner.goto(editorPath(media));
  expect((await waitForEditorConfig(owner)).document.permissions?.protect, 'the owner').toBe(true);

  const editor = await pageAs(drupal.secondUser);
  await editor.goto(editorPath(media));
  expect((await waitForEditorConfig(editor)).document.permissions?.protect, 'another editor').toBe(false);
});

test('the editor gets the default customization settings', async ({ createMedia, drupal, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const page = await pageAs(drupal.defaultUser);
  await page.goto(editorPath(media));
  const config = await waitForEditorConfig(page);
  const customization = config.editorConfig.customization as Record<string, unknown>;

  expect(customization.uiTheme).toBe('theme-system');
  // The defaults keep the chat, help, plugins and macros on, and the header, feedback off — the
  // module only writes what differs from the editor's own defaults
  expect(config.document.permissions?.chat).toBeUndefined();
  expect(customization).not.toHaveProperty('help');
  expect(customization).not.toHaveProperty('plugins');
  expect(customization).not.toHaveProperty('macros');
  expect(customization).not.toHaveProperty('compactHeader');
  expect(customization).not.toHaveProperty('feedback');
});

test('?mode=view opens an editable document for viewing', async ({ createMedia, drupal, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const page = await pageAs(drupal.defaultUser);
  await page.goto(editorPath(media, '?mode=view'));
  const editor = await EditorPage.attach(page);

  expect((await editor.config()).editorConfig.mode).toBe('view');
});

test('a format the module only views opens in view mode even for an editor', async ({ createMedia, drupal, pageAs }) => {
  const media = await createMedia(uniqueName('odt'), loadConvertTemplate('odt'));
  const page = await pageAs(drupal.defaultUser);
  await page.goto(editorPath(media));
  const editor = await EditorPage.attach(page);

  const config = await editor.config();
  expect(config.document.fileType).toBe('odt');
  expect(config.editorConfig.mode).toBe('view');
});

test('an unsupported format shows a message instead of the editor', async ({ createMedia, page }) => {
  // Known bug: the page passes an empty config to DocsAPI.DocEditor and shows the message in its
  // onAppReady, which never fires without a document — the user gets a blank page.
  test.fail();
  const media = await createMedia(uniqueName('odf'), Buffer.from('not a formula'));
  const scriptErrors: string[] = [];
  page.on('pageerror', (error) => scriptErrors.push(error.message));

  expect((await page.goto(editorPath(media)))?.status()).toBe(200);
  await expect(page.getByText("Sorry, this file format isn't supported (odf)")).toBeVisible();
  expect(scriptErrors).toEqual([]);
});
