import { documentServer, loadTemplate, waitForEditorConfig } from '@core';
import { Page } from '@playwright/test';
import { expect, test, uniqueName } from './fixtures';

/**
 * The module's preview formatter, which tests/setup/drupal.ts puts on the Document media page
 * (/media/{id}) and opens to anonymous visitors.
 */

function mediaPath(media: { mid: number }): string {
  return `/media/${media.mid}`;
}

/**
 * The "Manage display" form of a media type — on its own path since Drupal 11.4, which turned
 * …/display into an overview of the view modes.
 */
async function openManageDisplay(page: Page, bundle: string): Promise<void> {
  const response = await page.goto(`/admin/structure/media/manage/${bundle}/display/default`);
  if (response?.status() === 404) {
    await page.goto(`/admin/structure/media/manage/${bundle}/display`);
  }
}

test('an anonymous visitor sees the document in an embedded viewer', async ({ createMedia, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const page = await pageAs(null);
  expect((await page.goto(mediaPath(media)))?.status()).toBe(200);

  const config = await waitForEditorConfig(page);
  expect(config.type).toBe('embedded');
  expect(config.editorConfig.mode).toBe('view');
  expect(config.editorConfig.callbackUrl).toBeFalsy();
  await expect(page.locator('iframe[name="frameEditor"]')).toBeAttached();
});

test('the preview is not served from the page cache, so its links stay fresh', async ({ createMedia, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const page = await pageAs(null);

  await page.goto(mediaPath(media));
  const response = await page.goto(mediaPath(media));
  expect(response?.headers()['x-drupal-cache']).not.toBe('HIT');
});

test('an unpublished document is not previewed to an anonymous visitor', async ({ createMedia, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'), { published: false });
  const page = await pageAs(null);

  expect((await page.goto(mediaPath(media)))?.status()).toBe(403);
});

test("the page loads Docs' api.js from the configured address", async ({ createMedia, pageAs }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const page = await pageAs(null);
  await page.goto(mediaPath(media));

  const sources = await page.locator('script[src*="api/documents/api.js"]').evaluateAll((scripts) =>
    scripts.map((script) => (script as HTMLScriptElement).src),
  );
  expect(sources).toHaveLength(1);
  expect(new URL(sources[0]).host).toBe(new URL(documentServer().url).host);
});

test('the formatter is offered only for file fields that take office formats', async ({ page }) => {
  await openManageDisplay(page, 'document');
  const document = page.locator('select[name="fields[field_media_document][type]"] option[value="onlyoffice_preview"]');
  await expect(document).toHaveCount(1);

  await openManageDisplay(page, 'image');
  await expect(page.locator('select[name="fields[field_media_image][type]"]')).toHaveCount(1);
  await expect(
    page.locator('select[name="fields[field_media_image][type]"] option[value="onlyoffice_preview"]'),
  ).toHaveCount(0);
});

test('the formatter summary shows its size', async ({ page }) => {
  await openManageDisplay(page, 'document');
  const row = page.locator('tr', { has: page.locator('select[name="fields[field_media_document][type]"]') });

  await expect(row).toContainText('100%');
  await expect(row).toContainText('640px');
});
