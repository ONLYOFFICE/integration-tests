import { loadConvertTemplate, loadTemplate } from '@core';
import { WORKSPACE_PATH } from '@adapters/nuxeo';
import { expect, test, uniqueName } from './fixtures';

/**
 * The package's Automation operations behind its Web UI dialogs: ONLYOFFICE.Create ("Create with
 * ONLYOFFICE") and ONLYOFFICE.Convert ("Convert using ONLYOFFICE"). The shared create-via-plugin
 * and convert scenarios cover the content; these cover what the documents are created as.
 */

const MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};

test('created documents get the extension and mime type of their type', async ({ deleteAfter, nuxeo }) => {
  for (const [type, extension] of [
    ['word', 'docx'],
    ['cell', 'xlsx'],
    ['slide', 'pptx'],
    ['pdf', 'pdf'],
  ] as const) {
    const title = uniqueName(type).replace(/\.\w+$/, '');
    const uid = await nuxeo.api.createViaPlugin(title, type);
    deleteAfter(uid);

    const document = await nuxeo.api.getDocument(uid);
    expect(document.title, type).toBe(title);
    expect(document.fileName, type).toBe(`${title}.${extension}`);
    expect(document.mimeType, type).toBe(MIME_TYPES[extension]);
  }
});

test('a title with a slash creates the document under a name and file name without it', async ({ deleteAfter, nuxeo }) => {
  const title = `Autotest ${Date.now()} a/b`;
  const uid = await nuxeo.api.createViaPlugin(title, 'word');
  deleteAfter(uid);

  const document = await nuxeo.api.getDocument(uid);
  expect(document.title).toBe(title);
  expect(document.name).not.toContain('/');
  expect(document.fileName).not.toContain('/');
  expect(document.fileName).toMatch(/\.docx$/);
});

test('a user who may only read the folder cannot create documents in it', async ({ nuxeo }) => {
  const api = nuxeo.apiAs(nuxeo.readOnlyUser);

  await expect(
    api.operation('ONLYOFFICE.Create', { path: WORKSPACE_PATH, title: uniqueName('docx'), type: 'word', language: 'en' }),
  ).rejects.toThrow(/: 403 /);
});

test('the converted document gets the mime type of its new format', async ({ convertLegacyFile, nuxeo }) => {
  const file = await convertLegacyFile('odt');

  const document = await nuxeo.api.getDocument(file.id);
  expect(document.fileName).toMatch(/\.docx$/);
  expect(document.mimeType).toBe(MIME_TYPES.docx);
});

test('a user who may only read the document cannot convert it', async ({ createDocument, nuxeo }) => {
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));

  await expect(nuxeo.apiAs(nuxeo.readOnlyUser).convert(odt.uid)).rejects.toThrow(/: 403 /);
  expect((await nuxeo.api.getDocument(odt.uid)).digest).toBe(odt.digest);
});

test('a document already in an editable format is not converted', async ({ createDocument, nuxeo }) => {
  const docx = await createDocument(uniqueName('docx'), loadTemplate('docx'));

  await expect(nuxeo.api.convert(docx.uid)).rejects.toThrow();
  expect((await nuxeo.api.getDocument(docx.uid)).digest).toBe(docx.digest);
});
