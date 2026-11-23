import { CAPTURE_EDITOR_CONFIG, loadTemplate, waitForEditorConfig } from '@core';
import { Locator, Page } from '@playwright/test';
import { DrupalAdapter, DrupalMedia, FORM_FIELD, FORM_NODE_TYPE, PDF_FORM } from '@adapters/drupal';
import { editorPath, expect, loadBlankForm, test, uniqueName } from './fixtures';
import { FORMS_PATH, SUBMISSIONS_PATH } from './forms';

/**
 * The forms administrator's pages: the "Create & Upload" dialog, the list of forms and its bulk
 * delete. Forms the dialog creates are found by name through JSON:API and deleted after the test.
 */

/** A valid PDF without the ONLYOFFICE form marker the module looks for */
const PLAIN_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

async function openDialog(page: Page): Promise<Locator> {
  await page.goto(FORMS_PATH);
  await page.getByRole('link', { name: 'Create & Upload' }).click();
  const dialog = page.locator('.ui-dialog');
  await expect(dialog.locator('#onlyoffice-form-create-form-wrapper')).toBeVisible();
  return dialog;
}

/** Presses the dialog's button and returns the editor tab the module opens on success */
async function confirm(page: Page, dialog: Locator, button: 'Create' | 'Upload'): Promise<Page> {
  const [editor] = await Promise.all([
    page.context().waitForEvent('page'),
    dialog.locator('.ui-dialog-buttonpane').getByRole('button', { name: button }).click(),
  ]);
  return editor;
}

async function upload(page: Page, dialog: Locator, name: string, content: Buffer): Promise<void> {
  await dialog.locator('[name="source"]').selectOption('upload');
  const button = dialog.locator('.onlyoffice-form-upload-button');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles({
    name,
    mimeType: 'application/pdf',
    buffer: content,
  });
}

function formsNamed(drupal: DrupalAdapter, name: string): Promise<DrupalMedia[]> {
  return drupal.api.findMedia(name, PDF_FORM);
}

/** A name for a blank form: the module adds .pdf to it for the file */
function formName(): string {
  return uniqueName('pdf').replace(/\.pdf$/, '');
}

test('the forms pages are closed to users without the forms permission', async ({ drupal, pageAs }) => {
  const editor = await pageAs(drupal.secondUser);
  for (const path of [FORMS_PATH, `${FORMS_PATH}/create`, '/onlyoffice-form/create', SUBMISSIONS_PATH]) {
    expect((await editor.request.get(path)).status(), path).toBe(403);
  }
});

test('a blank form is created in the dialog and opens in the editor', async ({ deleteMediaNamed, drupal, page }) => {
  const name = formName();
  deleteMediaNamed(name, PDF_FORM);
  const dialog = await openDialog(page);
  await dialog.locator('[name="name"]').fill(name);
  const editor = await confirm(page, dialog, 'Create');

  const [form] = await formsNamed(drupal, name);
  expect(form).toBeDefined();
  expect(form.fileUrl).toBe(`/sites/default/files/onlyoffice_forms/${name}.pdf`);
  await expect(editor).toHaveURL(new RegExp(`${editorPath(form)}$`));
  await page.waitForURL(new RegExp(`${FORMS_PATH}$`));
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
});

test('the blank form editor edits the PDF and goes back to the forms list', async ({ createForm, page }) => {
  const form = await createForm();
  await page.addInitScript(CAPTURE_EDITOR_CONFIG);
  await page.goto(editorPath(form));
  const config = await waitForEditorConfig(page);

  expect(config.documentType).toBe('pdf');
  expect(config.editorConfig.mode).toBe('edit');
  expect((config.editorConfig.customization as { goback?: { url?: string } }).goback?.url).toMatch(
    new RegExp(`${FORMS_PATH}$`),
  );
});

test('a blank form needs a name', async ({ page }) => {
  const dialog = await openDialog(page);
  await dialog.locator('.ui-dialog-buttonpane').getByRole('button', { name: 'Create' }).click();
  await expect(dialog.locator('[name="name"]')).toHaveJSProperty('validity.valueMissing', true);
});

test('two blank forms of the same name get files of their own', async ({ deleteMediaNamed, drupal, page }) => {
  const name = formName();
  deleteMediaNamed(name, PDF_FORM);
  for (let i = 0; i < 2; i++) {
    const dialog = await openDialog(page);
    await dialog.locator('[name="name"]').fill(name);
    await (await confirm(page, dialog, 'Create')).close();
    await page.waitForURL(new RegExp(`${FORMS_PATH}$`));
  }

  const forms = await formsNamed(drupal, name);
  expect(forms).toHaveLength(2);
  expect(forms[0].fileUrl).not.toBe(forms[1].fileUrl);
});

test('a form name cannot lead its file out of the forms directory', async ({ deleteMediaNamed, drupal, page }) => {
  const name = `../../${formName()}`;
  deleteMediaNamed(name, PDF_FORM);
  const dialog = await openDialog(page);
  await dialog.locator('[name="name"]').fill(name);
  await (await confirm(page, dialog, 'Create')).close();

  const [form] = await formsNamed(drupal, name);
  expect(form.fileUrl).toBe(`/sites/default/files/onlyoffice_forms/${name.replace('../../', '')}.pdf`);
});

test.describe('uploading a form', () => {
  test('takes an ONLYOFFICE form', async ({ deleteMediaNamed, drupal, page }) => {
    const name = uniqueName('pdf');
    deleteMediaNamed(name, PDF_FORM);
    const dialog = await openDialog(page);
    await upload(page, dialog, name, loadBlankForm());
    await expect(dialog.locator('.onlyoffice-form-uploaded-file')).toContainText(name);
    const editor = await confirm(page, dialog, 'Upload');

    const [form] = await formsNamed(drupal, name);
    expect(form.fileUrl).toBe(`/sites/default/files/onlyoffice_forms/${name}`);
    await expect(editor).toHaveURL(new RegExp(`${editorPath(form)}$`));
  });

  test('refuses a file that is not a PDF', async ({ page }) => {
    const dialog = await openDialog(page);
    await upload(page, dialog, uniqueName('txt'), Buffer.from('Not a PDF'));
    await expect(dialog).toContainText('Only files with the following extensions are allowed: pdf');
  });

  test('refuses a PDF that is not an ONLYOFFICE form', async ({ drupal, page }) => {
    const name = uniqueName('pdf');
    const dialog = await openDialog(page);
    await upload(page, dialog, name, PLAIN_PDF);
    await expect(dialog.locator('.onlyoffice-form-uploaded-file')).toContainText(name);
    await dialog.locator('.ui-dialog-buttonpane').getByRole('button', { name: 'Upload' }).click();

    await expect(dialog).toContainText('The uploaded file is not a valid ONLYOFFICE form.');
    expect(await formsNamed(drupal, name)).toEqual([]);
  });
});

test.describe('the upload endpoint', () => {
  test('needs a CSRF token', async ({ page }) => {
    const response = await page.request.post('/onlyoffice-form/file-upload', {
      multipart: {
        'files[upload_file]': {
          name: 'form.pdf',
          mimeType: 'application/pdf',
          buffer: loadBlankForm(),
        },
      },
    });
    expect(response.status()).toBe(403);
  });

  test('answers 400 without a file', async ({ page }) => {
    const token = await (await page.request.get('/session/token')).text();
    const response = await page.request.post('/onlyoffice-form/file-upload', {
      headers: { 'X-CSRF-Token': token },
      multipart: { other: 'value' },
    });
    expect(response.status()).toBe(400);
  });
});

test.describe('the forms list', () => {
  test('finds forms by name and links them to the editor', async ({ createForm, page }) => {
    const form = await createForm();
    await page.goto(FORMS_PATH);
    await page
      .locator('#onlyoffice-form-filter-form input[type="search"], #onlyoffice-form-filter-form input[type="text"]')
      .first()
      .fill(form.name);
    await Promise.all([
      page.waitForLoadState('load'),
      page.locator('#onlyoffice-form-filter-form .form-submit').first().click(),
    ]);

    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(
      rows
        .first()
        .locator(`a[href$="${editorPath(form)}"]`)
        .first(),
    ).toBeVisible();
  });

  test('deletes the selected forms', async ({ createForm, drupal, page }) => {
    const forms = [await createForm(), await createForm()];
    await page.goto(FORMS_PATH);
    for (const form of forms) {
      await page.locator(`[name="items[${form.mid}]"]`).check();
    }
    await page.locator('[name="action"]').selectOption('delete');
    await Promise.all([
      page.waitForLoadState('load'),
      page.getByRole('button', { name: 'Apply to selected items' }).click(),
    ]);
    await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);

    for (const form of forms) {
      expect(await formsNamed(drupal, form.name)).toEqual([]);
    }
  });

  test('asks to select forms before applying an action', async ({ createForm, page }) => {
    await createForm();
    await page.goto(FORMS_PATH);
    await page.locator('[name="action"]').selectOption('delete');
    await Promise.all([
      page.waitForLoadState('load'),
      page.getByRole('button', { name: 'Apply to selected items' }).click(),
    ]);
    await expect(page.locator('[data-drupal-messages]')).toContainText('No items selected');
  });
});

test('a form can be deleted only by a forms administrator', async ({ createForm, drupal, pageAs }) => {
  const form = await createForm();
  const editor = await pageAs(drupal.secondUser);
  expect((await editor.request.get(`/media/${form.mid}/delete`)).status()).toBe(403);
});

test('the form field offers only ONLYOFFICE forms and publishes the chosen one', async ({
  createForm,
  createMedia,
  page,
}) => {
  const form = await createForm();
  const document = await createMedia(form.name.replace(/\.pdf$/, '.docx'), loadTemplate('docx'));
  await page.goto(`/node/add/${FORM_NODE_TYPE}`);
  await expect(page.getByRole('link', { name: 'Create new ONLYOFFICE form' })).toHaveAttribute('href', FORMS_PATH);

  const field = page.locator(`[name="${FORM_FIELD}[0][target_id]"]`);
  await field.pressSequentially(form.name.replace(/\.pdf$/, ''));
  const suggestions = page.locator('.ui-autocomplete li:visible');
  await expect(suggestions).toHaveCount(1);
  await expect(suggestions).toHaveText(form.name);
  await expect(suggestions).not.toHaveText(document.name);
  await suggestions.click();

  await page.locator('[name="title[0][value]"]').fill(`Form page ${form.name}`);
  await Promise.all([page.waitForURL(/\/node\/\d+$/), page.locator('#edit-submit').click()]);
  try {
    await expect(page.locator('iframe[name="frameEditor"]')).toHaveCount(1, { timeout: 30_000 });
  } finally {
    await page.goto(`${new URL(page.url()).pathname}/delete`);
    await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);
  }
});

test('the forms pages are translated', async ({ page }) => {
  await page.goto(`/ru${FORMS_PATH}`);
  await expect(page.getByRole('link', { name: 'Создать и загрузить' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'PDF-формы' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Отправленные формы' })).toBeVisible();
});
