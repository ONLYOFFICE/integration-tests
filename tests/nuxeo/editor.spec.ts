import { randomUUID } from 'node:crypto';
import { documentServer, loadConvertTemplate, loadTemplate } from '@core';
import { editorConfigOf, editorPath, expect, filterOf, test, uniqueName } from './fixtures';

/** The package's editor page (/nuxeo/site/onlyedit/{id}) and the /filter endpoint behind its Web UI action */

test('an anonymous visitor is sent to the login page instead of the editor', async ({ createFile, pageAs }) => {
  const file = await createFile('docx');
  const page = await pageAs(null);
  await page.goto(editorPath(file.id));

  await expect(page).toHaveURL(/\/login\.jsp/);
});

test('the editor of a document that does not exist answers 404', async ({ page }) => {
  expect((await page.goto(editorPath(randomUUID())))?.status()).toBe(404);
});

// Review 5.2: the editor took the file name of the document without checking it has a file
test('the editor of a document without a file answers 404', async ({ nuxeo, page }) => {
  const empty = await nuxeo.api.createEmptyFile(uniqueName('none'));
  try {
    expect((await page.goto(editorPath(empty.uid)))?.status()).toBe(404);
  } finally {
    await nuxeo.api.deleteDocument(empty.uid).catch(() => {});
  }
});

// Review 5.2: the editor took the type of a format it does not open as known
test('the editor of a file in a format the package does not open answers 404', async ({ createDocument, page }) => {
  const unknown = await createDocument(uniqueName('xyz'), Buffer.from('not a document'));

  expect((await page.goto(editorPath(unknown.uid)))?.status()).toBe(404);
});

test('the editor of a document the user may not see answers 403', async ({ createFile, nuxeo, pageAs }) => {
  const file = await createFile('docx');
  await nuxeo.restrictToReadOnly(file);
  const page = await pageAs(nuxeo.secondUser);

  expect((await page.goto(editorPath(file.id)))?.status()).toBe(403);
});

test('the action offers editing or viewing by format and permission, and nothing for other files', async ({
  createDocument,
  createFile,
  nuxeo,
  page,
  pageAs,
}) => {
  const docx = await createFile('docx');
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));
  const txt = await createDocument(uniqueName('txt'), Buffer.from('Hello world'));
  const unknown = await createDocument(uniqueName('xyz'), Buffer.from('not a document'));
  const empty = await nuxeo.api.createEmptyFile(uniqueName('none'));
  try {
    expect(await filterOf(page, docx.id), 'docx').toEqual({ mode: 'edit' });
    expect(await filterOf(page, odt.uid), 'odt').toEqual({ mode: 'view' });
    expect(await filterOf(page, txt.uid), 'txt').toEqual({ mode: 'view' });
    expect(await filterOf(page, unknown.uid), 'an unknown format').toEqual({});
    expect(await filterOf(page, empty.uid), 'a document without a file').toEqual({});
    expect(await filterOf(await pageAs(nuxeo.readOnlyUser), docx.id), 'a user who may only read').toEqual({ mode: 'view' });
  } finally {
    await nuxeo.api.deleteDocument(empty.uid).catch(() => {});
  }
});

test('a format the package only views opens without editing even for an editor', async ({ createDocument, page }) => {
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));
  const config = await editorConfigOf(page, odt.uid);

  expect(config.document.fileType).toBe('odt');
  expect(config.document.permissions?.edit).toBe(false);
  expect(config.editorConfig.callbackUrl).toBeFalsy();
});

test('a document locked by another user outside ONLYOFFICE opens for viewing', async ({ createFile, nuxeo, pageAs }) => {
  const file = await createFile('docx');
  await nuxeo.api.lock(file.id);
  try {
    const page = await pageAs(nuxeo.secondUser);
    const config = await editorConfigOf(page, file.id);

    expect(config.document.permissions?.edit).toBe(false);
    expect(config.editorConfig.callbackUrl).toBeFalsy();
    expect(await filterOf(page, file.id)).toEqual({ mode: 'view' });
  } finally {
    await nuxeo.api.unlock(file.id).catch(() => {});
  }
});

test('the lock of an editing session does not keep other editors from joining it', async ({
  createFile,
  nuxeo,
  openEditor,
  pageAs,
}) => {
  const file = await createFile('docx');
  await openEditor(file);
  await expect
    .poll(async () => (await nuxeo.api.getDocument(file.id)).lockOwner, { timeout: 30_000, intervals: [1_000] })
    .toBe(nuxeo.defaultUser.username);

  const page = await pageAs(nuxeo.secondUser);
  const config = await editorConfigOf(page, file.id);
  expect(config.document.permissions?.edit).toBe(true);
  expect(config.editorConfig.callbackUrl).toBeTruthy();
  expect(await filterOf(page, file.id)).toEqual({ mode: 'edit' });
});

test('the editor gets the user, the language of the browser and the way back to the folder', async ({
  createFile,
  nuxeo,
  pageAs,
}) => {
  const file = await createFile('docx');
  const config = await editorConfigOf(await pageAs(nuxeo.secondUser, { locale: 'de-DE' }), file.id);

  // First and last name of the account tests/setup/nuxeo.ts creates
  expect(config.editorConfig.user).toEqual({ id: nuxeo.secondUser.username, name: 'Autotest Second' });
  expect(config.editorConfig.lang).toBe('de-DE');
  const goback = (config.editorConfig.customization as { goback?: { url?: string } }).goback;
  expect(goback?.url).toBe(`${nuxeo.baseUrl}/nuxeo/ui/#!/browse/default-domain/workspaces/integration-tests`);
});

test('a user without a first or last name is shown by the login', async ({ createFile, page }) => {
  const file = await createFile('docx');

  // The built-in Administrator has neither
  expect((await editorConfigOf(page, file.id)).editorConfig.user?.name).toBe('Administrator');
});

test('the title and the file name are not interpreted as markup or script', async ({ createDocument, page }) => {
  const title = `</title><img src=x onerror="window.__oitXss=1">${Date.now()}`;
  const fileName = `autotest-${Date.now()}-</script><script>window.__oitXss=2</script>".docx`;
  const document = await createDocument(fileName, loadTemplate('docx'), { title });
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });

  const config = await editorConfigOf(page, document.uid);
  expect(config.document.title).toBe(fileName);
  await expect(page).toHaveTitle(`${title} - ONLYOFFICE`);
  expect(await page.evaluate(() => (window as unknown as { __oitXss?: number }).__oitXss)).toBeUndefined();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(dialogs).toEqual([]);
});

test('the editor loads api.js of the configured Document Server', async ({ createFile, page }) => {
  const file = await createFile('docx');
  await editorConfigOf(page, file.id);

  const sources = await page.locator('script[src*="api/documents/api.js"]').evaluateAll((scripts) =>
    scripts.map((script) => (script as HTMLScriptElement).src),
  );
  expect(sources).toHaveLength(1);
  expect(new URL(sources[0]).origin).toBe(new URL(documentServer().url).origin);
});

test('the editor icon follows the document type', async ({ createFile, page }) => {
  for (const [type, icon] of [
    ['docx', 'word'],
    ['xlsx', 'cell'],
    ['pptx', 'slide'],
  ] as const) {
    const file = await createFile(type);
    await editorConfigOf(page, file.id);
    await expect(page.locator('link[rel="shortcut icon"]'), type).toHaveAttribute('href', new RegExp(`/images/${icon}\\.ico$`));
  }
});

