import { loadConvertTemplate } from '@core';
import { editorPath, expect, test, uniqueName } from '../fixtures';
import { EDITOR_FRAME, NuxeoWebUi } from '../web-ui';

/** The "Edit/View in ONLYOFFICE" action on a document's page (onlyoffice-editor-button) */

test('the action offers editing a document the package edits and viewing one it only views', async ({
  createDocument,
  createFile,
  webUi,
}) => {
  const docx = await createFile('docx');
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));

  await webUi.openDocument(docx.id);
  await expect(webUi.editorActionLabel).toHaveText('Edit in ONLYOFFICE');

  await webUi.openDocument(odt.uid);
  await expect(webUi.editorActionLabel).toHaveText('View in ONLYOFFICE');
});

test('a user who may only read the document is offered viewing', async ({ createFile, nuxeo, pageAs }) => {
  const file = await createFile('docx');
  const webUi = new NuxeoWebUi(await pageAs(nuxeo.readOnlyUser));

  await webUi.openDocument(file.id);
  await expect(webUi.editorActionLabel).toHaveText('View in ONLYOFFICE');
});

test('a file the package does not open gets no action', async ({ createDocument, page, webUi }) => {
  const file = await createDocument(uniqueName('xyz'), Buffer.from('not a document'));

  await webUi.openDocument(file.uid);
  await expect(page.locator('onlyoffice-editor-button')).toHaveCount(1);
  await expect(webUi.editorAction).toHaveCount(0);
});

test('the action opens the editor of the document in a new window', async ({ createFile, page, webUi }) => {
  const file = await createFile('docx');
  await page.context().route(EDITOR_FRAME, (route) => route.abort());
  await webUi.openDocument(file.id);

  const [editor] = await Promise.all([page.waitForEvent('popup'), webUi.editorAction.click()]);

  await expect(editor).toHaveURL((url) => url.pathname === editorPath(file.id));
  expect(page.url(), 'the document page stays where it was').toContain(`/doc/${file.id}`);
});

// Review 1.2: a version opens for editing, and saving it then fails. (The page of a trashed document
// shows no document actions at all, so the package's action is not offered there either.)
test('a version of a document is offered viewing only', async ({ createFile, nuxeo, webUi }) => {
  const file = await createFile('docx');
  const version = await nuxeo.api.createVersion(file.id);

  await webUi.openDocument(version);
  await expect(webUi.editorActionLabel).toHaveText('View in ONLYOFFICE');
});

// Review 5.3: the action keeps the answer for the previous document until the new one arrives
test('going to another document does not show the action of the previous one', async ({
  createDocument,
  createFile,
  page,
  webUi,
}) => {
  test.fail();
  const docx = await createFile('docx');
  const unknown = await createDocument(uniqueName('xyz'), Buffer.from('not a document'));
  await webUi.openDocument(docx.id);
  await expect(webUi.editorActionLabel).toHaveText('Edit in ONLYOFFICE');

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/onlyoffice/filter/${unknown.uid}`, async (route) => {
    await held;
    await route.continue();
  });
  const asked = page.waitForRequest(`**/onlyoffice/filter/${unknown.uid}`);
  await webUi.goto(`doc/${unknown.uid}`);
  await asked;
  try {
    await expect(webUi.editorAction).toHaveCount(0);
  } finally {
    release();
  }
});
