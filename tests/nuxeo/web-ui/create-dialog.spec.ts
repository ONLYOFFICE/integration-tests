import { Locator, Page } from '@playwright/test';
import { EDITOR_PATH } from '@adapters/nuxeo';
import { expect, test, uniqueName } from '../fixtures';
import { EDITOR_FRAME, NuxeoWebUi } from '../web-ui';

/** The ONLYOFFICE tab of Web UI's "New" popup (onlyoffice-create) */

const CREATE_OPERATION = '**/automation/ONLYOFFICE.Create';

/**
 * The uid of the document whose editor opens next — in this tab (what the dialog does now) or in
 * a new one (review 5.3 asks for that).
 */
async function editorOpened(page: Page): Promise<string> {
  const editorUrl = (url: URL) => url.pathname.startsWith(`${EDITOR_PATH}/`);
  const timeout = 30_000;
  const url = await Promise.any([
    page.waitForURL(editorUrl, { timeout }).then(() => page.url()),
    page
      .context()
      .waitForEvent('page', { timeout })
      .then(async (opened) => {
        await opened.waitForURL(editorUrl, { timeout });
        return opened.url();
      }),
  ]).catch(() => {
    throw new Error(`No editor opened within ${timeout} ms`);
  });
  return new URL(url).pathname.split('/').pop()!;
}

async function fill(dialog: Locator, title: string, type: 'word' | 'cell' | 'slide' | 'pdf' = 'word'): Promise<void> {
  await dialog.locator('nuxeo-input#title input').fill(title);
  await dialog.locator(`paper-button.docTypeButton[name="${type}"]`).click();
}

test.beforeEach(async ({ page }) => {
  await page.context().route(EDITOR_FRAME, (route) => route.abort());
});

test('a document created from the dialog opens in its editor', async ({ deleteAfter, nuxeo, page, webUi }) => {
  const title = uniqueName();
  await webUi.openWorkspace();
  const dialog = await webUi.openCreateDialog();

  await fill(dialog, title, 'cell');
  const opened = editorOpened(page);
  await dialog.locator('paper-button#create').click();
  const uid = await opened;
  deleteAfter(uid);

  const document = await nuxeo.api.getDocument(uid);
  expect(document.fileName).toBe(`${title}.xlsx`);
});

test('Create waits for a type to be chosen', async ({ webUi }) => {
  await webUi.openWorkspace();
  const dialog = await webUi.openCreateDialog();
  const create = dialog.locator('paper-button#create');

  await dialog.locator('nuxeo-input#title input').fill(uniqueName());
  await expect(create).toHaveAttribute('aria-disabled', 'true');
  await dialog.locator('paper-button.docTypeButton[name="word"]').click();
  await expect(create).toHaveAttribute('aria-disabled', 'false');
});

// Review 5.3: the form's Enter handler (_submitKeyHandler) doesn't exist
test('Enter in the title creates the document', async ({ deleteAfter, page, webUi }) => {
  test.fail();
  await webUi.openWorkspace();
  const dialog = await webUi.openCreateDialog();

  await fill(dialog, uniqueName());
  const opened = editorOpened(page);
  await dialog.locator('nuxeo-input#title input').press('Enter');
  deleteAfter(await opened);
});

// Review 5.3: "report.docx" becomes "report.docx.docx"
test('a title with the extension of its type does not get it twice', async ({ deleteAfter, nuxeo, page, webUi }) => {
  test.fail();
  const name = `${uniqueName()}.docx`;
  await webUi.openWorkspace();
  const dialog = await webUi.openCreateDialog();

  await fill(dialog, name);
  const opened = editorOpened(page);
  await dialog.locator('paper-button#create').click();
  const uid = await opened;
  deleteAfter(uid);

  expect((await nuxeo.api.getDocument(uid)).fileName).toBe(name);
});

// Review 5.3: `required` takes spaces for a title
test('a title of spaces only is not accepted', async ({ page, webUi }) => {
  test.fail();
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/automation/ONLYOFFICE.Create')) {
      asked.push(request.url());
    }
  });
  await webUi.openWorkspace();
  const dialog = await webUi.openCreateDialog();

  await fill(dialog, '   ');
  await dialog.locator('paper-button#create').click();
  await page.waitForTimeout(2_000);

  expect(asked).toEqual([]);
});

// Review 5.3: the server's reason is replaced by a generic message
test('the reason the server refused to create the document is shown', async ({ page, webUi }) => {
  test.fail();
  const reason = 'A document with this name cannot be created here';
  await page.route(CREATE_OPERATION, (route) =>
    route.fulfill({ status: 400, json: { 'entity-type': 'exception', status: 400, message: reason } }),
  );
  await webUi.openWorkspace();
  const dialog = await webUi.openCreateDialog();

  await fill(dialog, uniqueName());
  await dialog.locator('paper-button#create').click();

  await expect.poll(() => webUi.notifications()).toContainEqual(expect.stringContaining(reason));
});

test('a user who may only read the folder cannot create in it', async ({ nuxeo, pageAs }) => {
  const webUi = new NuxeoWebUi(await pageAs(nuxeo.readOnlyUser));
  await webUi.openWorkspace();
  const dialog = await webUi.openCreateDialog();

  await fill(dialog, uniqueName());

  await expect(dialog.locator('paper-button#create')).toHaveAttribute('aria-disabled', 'true');
});
