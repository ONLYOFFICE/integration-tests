import { FORM_FIELD, FORM_NODE_TYPE, PDF_FORM } from '@adapters/drupal';
import { waitForEditorConfig } from '@core';
import { Page } from '@playwright/test';
import { expect, test } from '../drupal/fixtures';
import { submissionFileUrl, submissionPath, submitForm, waitForSubmissions } from '../drupal/forms';
import { standDrush } from '../setup/drupal-drush';

/**
 * Where forms and submissions are stored, and the form formatter's settings — both set for the
 * whole stand, through drush: the file system of the PDF form media type's file field (public by
 * default, as the module installs it with a site's default scheme) and the formatter on the form
 * page's display. Each scenario puts the defaults back.
 */

const drush = standDrush();
test.skip(!drush, 'Needs drush on the stand, which tests/setup/drupal.ts publishes');

const PUBLIC_WARNING = 'Submitted forms are stored in the public file system';

function setFormScheme(scheme: 'public' | 'private'): void {
  drush!(
    'php:eval',
    `$storage = \\Drupal\\field\\Entity\\FieldStorageConfig::load('media.field_media_pdf_file');
      $storage->setSetting('uri_scheme', '${scheme}')->save();`,
  );
}

function setFormatter(settings: Record<string, string>): void {
  const phpArray = Object.entries(settings)
    .map(([name, value]) => `'${name}' => '${value}'`)
    .join(', ');
  drush!(
    'php:eval',
    `$display = \\Drupal::service('entity_display.repository')->getViewDisplay('node', '${FORM_NODE_TYPE}', 'default');
      $component = $display->getComponent('${FORM_FIELD}');
      $component['settings'] = [${phpArray}] + $component['settings'];
      $display->setComponent('${FORM_FIELD}', $component)->save();`,
  );
}

async function statusReport(page: Page): Promise<string> {
  await page.goto('/admin/reports/status');
  return page.locator('main').innerText();
}

test.afterEach(() => {
  setFormScheme('public');
  setFormatter({ save_submissions: '1', hide_after_submission: '1' });
});

test.describe('forms in the public file system', () => {
  test('make the status report warn about the submissions', async ({ page }) => {
    expect(await statusReport(page)).toContain(PUBLIC_WARNING);
  });

  test('keep a submission at a public address until it is deleted', async ({
    createForm,
    createFormPage,
    page,
    pageAs,
  }) => {
    const form = await createForm();
    const node = await createFormPage(form);
    const visitor = await pageAs(null);
    await visitor.goto(`/node/${node.nid}`);
    await submitForm(visitor);
    const [submission] = await waitForSubmissions(page, form, 1);
    const url = submissionFileUrl(form, submission, 'public');

    const anonymous = await pageAs(null);
    expect((await anonymous.request.get(url)).status()).toBe(200);

    await page.goto(submissionPath(submission, 'delete'));
    await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);
    expect((await anonymous.request.get(url)).status()).toBe(404);
  });
});

test.describe('forms in the private file system', () => {
  test.beforeEach(() => setFormScheme('private'));

  test('leave the status report without the warning', async ({ page }) => {
    expect(await statusReport(page)).not.toContain(PUBLIC_WARNING);
  });

  test('keep a submission private and delete its file with it', async ({
    createForm,
    createFormPage,
    drupal,
    page,
    pageAs,
  }) => {
    const form = await createForm();
    const node = await createFormPage(form);
    const visitor = await pageAs(null);
    await visitor.goto(`/node/${node.nid}`);
    expect((await waitForEditorConfig(visitor)).document.url).toContain('/onlyoffice-download/');
    await submitForm(visitor);
    const [submission] = await waitForSubmissions(page, form, 1);
    const url = submissionFileUrl(form, submission, 'private');

    expect((await (await pageAs(null)).request.get(url)).status()).toBe(403);
    expect((await (await pageAs(drupal.secondUser)).request.get(url)).status()).toBe(403);
    const own = await page.request.get(url);
    expect(own.status()).toBe(200);
    expect((await own.body()).subarray(0, 4).toString()).toBe('%PDF');

    await page.goto(submissionPath(submission, 'delete'));
    await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);
    expect((await page.request.get(url)).status()).toBe(404);
  });

  test('store new forms privately', async ({ createForm, drupal }) => {
    const form = await createForm();
    const [stored] = await drupal.api.findMedia(form.name, PDF_FORM);
    expect(stored.fileUrl).toMatch(/^\/system\/files\/onlyoffice_forms\//);
  });
});

test.describe('the form formatter', () => {
  test('hides the Submit button when submissions are not saved', async ({ createForm, createFormPage, pageAs }) => {
    setFormatter({ save_submissions: '0' });
    const node = await createFormPage(await createForm());
    const visitor = await pageAs(null);
    await visitor.goto(`/node/${node.nid}`);

    const config = await waitForEditorConfig(visitor);
    expect(config.editorConfig.customization).toMatchObject({
      submitForm: { visible: '0' },
    });
  });

  test('shows the form again after a submission when told to', async ({ createForm, createFormPage, page, pageAs }) => {
    setFormatter({ hide_after_submission: '0' });
    const form = await createForm();
    const node = await createFormPage(form);
    const visitor = await pageAs(null);
    await visitor.goto(`/node/${node.nid}`);
    await submitForm(visitor);
    await waitForSubmissions(page, form, 1);

    await visitor.goto(`/node/${node.nid}`);
    await expect(visitor.locator('iframe[name="frameEditor"]')).toHaveCount(1);
  });
});
