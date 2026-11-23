import { waitForEditorConfig } from '@core';
import { expect, test } from './fixtures';
import {
  listSubmissions,
  submissionPath,
  submissionsPath,
  submitForm,
  SUBMISSIONS_PATH,
  waitForSubmissions,
} from './forms';

/**
 * Filling in and submitting a form published on a page, and the forms administrator's view of the
 * submissions. The page's field shows the form with the defaults of the module's formatter: the
 * Submit button on, the form hidden from whoever has submitted it.
 */

const ALREADY_SUBMITTED = 'You have already submitted this form.';

test('a signed-in visitor gets the form to fill in, with a key of their own', async ({
  createForm,
  createFormPage,
  drupal,
  pageAs,
}) => {
  const node = await createFormPage(await createForm());
  const page = await pageAs(drupal.secondUser);
  await page.goto(`/node/${node.nid}`);
  const config = await waitForEditorConfig(page);

  expect(config.type).toBe('embedded');
  expect(config.documentType).toBe('pdf');
  expect(config.editorConfig.mode).toBe('edit');
  expect(config.document.permissions).toMatchObject({
    edit: false,
    fillForms: true,
    protect: false,
  });
  expect(config.editorConfig.callbackUrl).toContain('/onlyoffice-form-callback/');
  expect(config.editorConfig.customization).toMatchObject({
    submitForm: { visible: '1' },
  });
  const userId = await drupal.api.userId(drupal.secondUser.username);
  expect(String(config.editorConfig.user?.id)).toBe(userId);
  expect(config.document.key).toMatch(new RegExp(`_${userId}$`));
});

test('an anonymous visitor gets a guest key', async ({ createForm, createFormPage, pageAs }) => {
  const node = await createFormPage(await createForm());
  const page = await pageAs(null);
  await page.goto(`/node/${node.nid}`);
  const config = await waitForEditorConfig(page);

  expect(config.editorConfig.user?.id ?? null).toBeNull();
  expect(config.document.key).toMatch(/_guest_[0-9a-f-]{36}$/);
});

test('a signed-in visitor submits the form once', async ({ createForm, createFormPage, drupal, page, pageAs }) => {
  const form = await createForm();
  const node = await createFormPage(form);
  const visitor = await pageAs(drupal.secondUser);
  await visitor.goto(`/node/${node.nid}`);
  await submitForm(visitor);

  const [submission] = await waitForSubmissions(page, form, 1);
  expect(submission.submitter).toBe(drupal.secondUser.username);

  await visitor.goto(`/node/${node.nid}`);
  await expect(visitor.getByText(ALREADY_SUBMITTED)).toBeVisible();
  await expect(visitor.locator('iframe[name="frameEditor"]')).toHaveCount(0);
});

test('an anonymous visitor submits the form, which is then hidden only from their browser', async ({
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
  expect(submission.submitter).toBe('Anonymous');

  await visitor.goto(`/node/${node.nid}`);
  await expect(visitor.getByText(ALREADY_SUBMITTED)).toBeVisible();

  const another = await pageAs(null);
  await another.goto(`/node/${node.nid}`);
  await expect(another.locator('iframe[name="frameEditor"]')).toHaveCount(1);
  await expect(another.getByText(ALREADY_SUBMITTED)).toHaveCount(0);
});

test.describe('a submitted form', () => {
  test('is counted in the submissions overview', async ({ createForm, createFormPage, page, pageAs }) => {
    const form = await createForm();
    const node = await createFormPage(form);
    const visitor = await pageAs(null);
    await visitor.goto(`/node/${node.nid}`);
    await submitForm(visitor);
    await waitForSubmissions(page, form, 1);

    await page.goto(SUBMISSIONS_PATH);
    const row = page.locator('table.onlyoffice-form-submissions tbody tr', {
      has: page.locator(`a[href="${submissionsPath(form)}"]`),
    });
    await expect(row.locator('td').nth(1)).toHaveText('1');
  });

  test('opens for a forms administrator in the viewer and downloads as a PDF', async ({
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
    await submitForm(visitor);
    const [submission] = await waitForSubmissions(page, form, 1);

    const admin = await pageAs(drupal.defaultUser);
    expect((await admin.goto(submissionPath(submission, 'view')))?.status()).toBe(200);
    const config = await waitForEditorConfig(admin);
    expect(config.editorConfig.mode).toBe('view');
    expect(config.document.permissions?.edit).toBe(false);
    expect(config.editorConfig.callbackUrl ?? null).toBeNull();

    const download = await page.request.get(submissionPath(submission, 'download'));
    expect(download.status()).toBe(200);
    expect(download.headers()['content-disposition']).toContain('attachment');
    expect((await download.body()).subarray(0, 4).toString()).toBe('%PDF');
  });

  test('is closed to users without the forms permission', async ({
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
    await submitForm(visitor);
    const [submission] = await waitForSubmissions(page, form, 1);

    const editor = await pageAs(drupal.secondUser);
    for (const path of [
      submissionPath(submission, 'view'),
      submissionPath(submission, 'download'),
      submissionPath(submission, 'delete'),
      submissionsPath(form),
      SUBMISSIONS_PATH,
    ]) {
      expect((await editor.request.get(path)).status(), path).toBe(403);
    }
  });

  test('is deleted on its own and with all the submissions of its form', async ({
    createForm,
    createFormPage,
    page,
    pageAs,
  }) => {
    const form = await createForm();
    const node = await createFormPage(form);
    for (let i = 0; i < 3; i++) {
      const visitor = await pageAs(null);
      await visitor.goto(`/node/${node.nid}`);
      await submitForm(visitor);
      await waitForSubmissions(page, form, i + 1);
    }
    const [first, ...rest] = await listSubmissions(page, form);

    await page.goto(submissionPath(first, 'delete'));
    await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);
    expect((await listSubmissions(page, form)).map((submission) => submission.id)).toEqual(rest.map((s) => s.id));

    await page.goto(`${submissionsPath(form)}/delete`);
    await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);
    expect(await listSubmissions(page, form)).toEqual([]);
  });
});
