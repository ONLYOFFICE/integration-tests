import { EditorPage, loadConvertTemplate, loadTemplate } from '@core';
import { editorPath, expect, test, uniqueName } from './fixtures';

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
