import { loadConvertTemplate, loadTemplate } from '@core';
import { Page } from '@playwright/test';
import { editorPath, expect, test, uniqueName } from './fixtures';

/** The ONLYOFFICE operation of a media row on the media overview (/admin/content/media) */
function operation(page: Page, media: { mid: number }) {
  return page.locator(`a[href^="${editorPath(media)}"]`);
}

test('the media overview offers editing or viewing by format, and nothing for an unsupported one', async ({
  createMedia,
  page,
}) => {
  const docx = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  const odt = await createMedia(uniqueName('odt'), loadConvertTemplate('odt'));
  const txt = await createMedia(uniqueName('txt'), Buffer.from('Hello world'));
  // Allowed by the standard profile's Document field, but not a format the module opens
  const odf = await createMedia(uniqueName('odf'), Buffer.from('not a formula'));

  await page.goto('/admin/content/media');
  // Secondary dropbutton items are hidden until the toggle is opened, so text, not visibility
  await expect(operation(page, docx)).toHaveText('Edit in ONLYOFFICE');
  await expect(operation(page, odt)).toHaveText('View in ONLYOFFICE');
  await expect(operation(page, txt)).toHaveText('View in ONLYOFFICE');
  await expect(page.getByRole('link', { name: odf.name }).first()).toBeVisible();
  await expect(operation(page, odf)).toHaveCount(0);
});

test('a user who can only view media is offered viewing', async ({ createMedia, drupal, pageAs }) => {
  const docx = await createMedia(uniqueName('docx'), loadTemplate('docx'));

  const page = await pageAs(drupal.readOnlyUser);
  await page.goto('/admin/content/media');
  await expect(operation(page, docx)).toHaveText('View in ONLYOFFICE');
});

test('a user who may edit only own documents is offered editing for those only', async ({
  createMedia,
  drupal,
  pageAs,
}) => {
  const own = await createMedia(uniqueName('docx'), loadTemplate('docx'), { owner: drupal.ownerUser });
  const others = await createMedia(uniqueName('docx'), loadTemplate('docx'));

  const page = await pageAs(drupal.ownerUser);
  await page.goto('/admin/content/media');
  await expect(operation(page, own)).toHaveText('Edit in ONLYOFFICE');
  await expect(operation(page, others)).toHaveText('View in ONLYOFFICE');
});
