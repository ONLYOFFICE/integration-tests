import { randomUUID } from 'node:crypto';
import { documentServer, EditorConfig, extractText, FileRef, signedCallbackBody, signJwt } from '@core';
import { docxOnDocumentServer, editorConfigOf, expect, test, uniqueName } from './fixtures';

/**
 * The package's callback endpoint (/api/v1/onlyoffice/callback/{id}?token=…): the token in its
 * query is the package's own, signed for the callback of one document in one editing session and
 * naming the user who opened the editor, so the callback acts as that user. The shared
 * callback-security scenario covers the JWT itself; real saves through the editor are covered by
 * the shared edit-save scenarios.
 */

interface Answer {
  status: number;
  error?: number;
}

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const json = (await response.json().catch(() => ({}))) as { error?: number };
  return { status: response.status, error: json.error };
}

/** The same callback route of the same user, for another document */
function forDocument(callbackUrl: string, uid: string): string {
  return callbackUrl.replace(/\/callback\/[^/?]+/, `/callback/${uid}`);
}

test.describe('callback', () => {
  let file: FileRef;
  let config: EditorConfig;
  let callbackUrl: string;
  let uid: string;

  test.beforeEach(async ({ createFile, page }) => {
    file = await createFile('docx');
    uid = file.id;
    config = await editorConfigOf(page, uid);
    callbackUrl = config.editorConfig.callbackUrl!;
    expect(callbackUrl).toBeTruthy();
  });

  const save = (extra: Record<string, unknown> = {}) => ({
    key: config.document.key,
    status: 2,
    url: config.document.url,
    users: [config.editorConfig.user?.id],
    ...extra,
  });

  test('a save replaces the content as a new minor version and keeps the file name and type', async ({
    createDocument,
    nuxeo,
    page,
  }) => {
    const before = await nuxeo.api.getDocument(uid);
    expect(before.version).toBe('0.0');
    const marker = `Autotest-${Date.now()}`;
    const url = await docxOnDocumentServer(page, createDocument, marker);

    expect(await post(callbackUrl, signedCallbackBody(save({ url })))).toEqual({ status: 200, error: 0 });

    const after = await nuxeo.api.getDocument(uid);
    expect(await extractText('docx', await nuxeo.api.downloadBlob(uid))).toContain(marker);
    expect(after.fileName).toBe(before.fileName);
    expect(after.mimeType).toBe(before.mimeType);
    expect(after.version).toBe('0.1');
    expect(after.lastContributor).toBe(nuxeo.defaultUser.username);

    // The key comes from the document's change token, so the saved version opens as a new
    // document in Docs rather than the cached old one
    expect((await editorConfigOf(page, uid)).document.key).not.toBe(config.document.key);
  });

  test('a save of a corrupted session (status 3) is kept too', async ({ createDocument, nuxeo, page }) => {
    const marker = `Autotest-${Date.now()}`;
    const url = await docxOnDocumentServer(page, createDocument, marker);

    expect(await post(callbackUrl, signedCallbackBody(save({ url, status: 3 })))).toEqual({ status: 200, error: 0 });
    expect(await extractText('docx', await nuxeo.api.downloadBlob(uid))).toContain(marker);
  });

  test('the editing session locks the document and closing it without changes unlocks it', async ({
    nuxeo,
    openEditor,
  }) => {
    await openEditor(file);
    // Document Server reports the user entering (status 1) once the editor has loaded
    await expect
      .poll(async () => (await nuxeo.api.getDocument(uid)).lockOwner, { timeout: 30_000, intervals: [1_000] })
      .toBe(nuxeo.defaultUser.username);

    expect(await post(callbackUrl, signedCallbackBody({ key: config.document.key, status: 4 }))).toEqual({
      status: 200,
      error: 0,
    });
    expect((await nuxeo.api.getDocument(uid)).lockOwner).toBeUndefined();
  });

  test('force save is acknowledged without saving', async ({ nuxeo }) => {
    const before = await nuxeo.api.getDocument(uid);

    expect(await post(callbackUrl, signedCallbackBody(save({ status: 6 })))).toEqual({ status: 200, error: 0 });
    expect((await nuxeo.api.getDocument(uid)).digest).toBe(before.digest);
  });

  test('a save whose file cannot be downloaded fails and saves nothing', async ({ nuxeo }) => {
    const before = await nuxeo.api.getDocument(uid);

    const answer = await post(callbackUrl, signedCallbackBody(save({ url: 'http://127.0.0.1:9/output.docx' })));
    expect(answer.error).toBe(1);
    // A failure Document Server should retry later, not a refusal
    expect(answer.status).toBeGreaterThanOrEqual(500);
    const after = await nuxeo.api.getDocument(uid);
    expect(after.digest).toBe(before.digest);
    expect(after.version).toBe(before.version);
  });

  test('a token in the header only is accepted, as Document Server may send it', async () => {
    const body = { key: config.document.key, status: 4 };
    const { secret, header } = documentServer();

    expect(
      await post(callbackUrl, JSON.stringify(body), { [header]: `Bearer ${signJwt({ payload: body }, secret)}` }),
    ).toEqual({ status: 200, error: 0 });
  });

  test('the request is taken from the token, not from the body around it', async ({ nuxeo }) => {
    const before = await nuxeo.api.getDocument(uid);
    const signed = { key: config.document.key, status: 4 };
    const body = { ...save(), token: signJwt(signed, documentServer().secret) };

    expect(await post(callbackUrl, JSON.stringify(body))).toEqual({ status: 200, error: 0 });
    expect((await nuxeo.api.getDocument(uid)).digest).toBe(before.digest);
  });

  test('tokens Document Server would not send are refused', async ({ nuxeo }) => {
    const before = await nuxeo.api.getDocument(uid);
    const { secret } = documentServer();
    const cases: [string, string][] = [
      ['an expired token', JSON.stringify({ ...save(), token: signJwt(save(), secret, { expiresIn: -600 }) })],
      ['a token for another operation', JSON.stringify({ ...save(), token: signJwt({ ...save(), operation: 'download' }, secret) })],
      ['a broken token', JSON.stringify({ ...save(), token: 'not.a.token' })],
    ];
    for (const [label, body] of cases) {
      expect(await post(callbackUrl, body), label).toEqual({ status: 401, error: 1 });
    }
    expect((await nuxeo.api.getDocument(uid)).digest).toBe(before.digest);
  });

  test('requests Document Server would not send are refused, not failed on', async () => {
    const { secret, header } = documentServer();
    const body = { key: config.document.key, status: 4 };
    const cases: [string, string, Record<string, string>][] = [
      ['a body that is a JSON number', '42', {}],
      ['a body that is a JSON array', '[]', {}],
      ['an empty body', '', {}],
      ['a header token without payload', JSON.stringify(body), { [header]: `Bearer ${signJwt(body, secret)}` }],
      ['an unknown status', signedCallbackBody({ key: config.document.key, status: 42 }), {}],
      ['no status', signedCallbackBody({ key: config.document.key }), {}],
    ];
    for (const [label, requestBody, headers] of cases) {
      const answer = await post(callbackUrl, requestBody, headers);
      expect(answer.status, label).toBeGreaterThanOrEqual(400);
      expect(answer.status, label).toBeLessThan(500);
    }
  });

  test('a callback without the token of its link is not served', async () => {
    const anonymous = callbackUrl.replace(/\?.*$/, '');

    expect((await post(anonymous, signedCallbackBody({ key: config.document.key, status: 4 }))).status).toBe(401);
  });

  test('the link of a document is refused for any other document', async ({ createFile }) => {
    for (const other of [randomUUID(), (await createFile('docx')).id]) {
      expect(await post(forDocument(callbackUrl, other), signedCallbackBody({ key: config.document.key, status: 4 })), other).toEqual({
        status: 401,
        error: 1,
      });
    }
  });

  test('the token of the download link is refused for the callback', async () => {
    const url = callbackUrl.replace(/\?.*$/, `?token=${new URL(config.document.url).searchParams.get('token')}`);

    expect(await post(url, signedCallbackBody({ key: config.document.key, status: 4 }))).toEqual({ status: 401, error: 1 });
  });

  test('the link is refused for another editing session of the document', async ({ nuxeo }) => {
    const before = await nuxeo.api.getDocument(uid);

    expect(await post(callbackUrl, signedCallbackBody(save({ key: `${config.document.key}x` })))).toEqual({
      status: 401,
      error: 1,
    });
    expect((await nuxeo.api.getDocument(uid)).digest).toBe(before.digest);
  });

  test('only POST is served', async () => {
    expect((await fetch(callbackUrl)).status).toBe(401);
  });
});

test('the callback acts with the permissions its user has now: a document made read-only gets nothing saved', async ({
  createFile,
  createDocument,
  nuxeo,
  page,
  pageAs,
}) => {
  // The editor of secondUser, who may edit the documents of the workspace…
  const own = await createFile('docx');
  const config = await editorConfigOf(await pageAs(nuxeo.secondUser), own.id);
  expect(config.editorConfig.callbackUrl).toBeTruthy();
  const before = await nuxeo.api.getDocument(own.id);
  // …on a document secondUser may only read by the time of the save
  await nuxeo.api.blockPermissionInheritance(own.id);
  await nuxeo.api.addPermission(own.id, nuxeo.secondUser.username, 'Read');
  const url = await docxOnDocumentServer(page, createDocument, `Autotest-${Date.now()}`);

  const answer = await post(
    config.editorConfig.callbackUrl!,
    signedCallbackBody({ key: config.document.key, status: 2, url, users: [nuxeo.secondUser.username] }),
  );
  expect(answer).toEqual({ status: 403, error: 1 });
  expect((await nuxeo.api.getDocument(own.id)).digest).toBe(before.digest);
});

test('the callback acts with the permissions its user has now: a document hidden meanwhile is not reached', async ({
  createFile,
  nuxeo,
  pageAs,
}) => {
  const own = await createFile('docx');
  const config = await editorConfigOf(await pageAs(nuxeo.secondUser), own.id);
  await nuxeo.restrictToReadOnly(own);

  expect(await post(config.editorConfig.callbackUrl!, signedCallbackBody({ key: config.document.key, status: 4 }))).toEqual({
    status: 403,
    error: 1,
  });
});

test('a lock set outside ONLYOFFICE outlives the editing session, and saving keeps it', async ({
  createDocument,
  createFile,
  nuxeo,
  openEditor,
  page,
}) => {
  const file = await createFile('docx');
  await nuxeo.api.lock(file.id);
  try {
    const config = await (await openEditor(file)).config();
    expect(config.editorConfig.callbackUrl, 'the owner of the lock still edits').toBeTruthy();
    const url = await docxOnDocumentServer(page, createDocument, `Autotest-${Date.now()}`);

    const save = { key: config.document.key, status: 2, url, users: [config.editorConfig.user?.id] };
    expect(await post(config.editorConfig.callbackUrl!, signedCallbackBody(save))).toEqual({ status: 200, error: 0 });
    expect((await nuxeo.api.getDocument(file.id)).lockOwner).toBe(nuxeo.defaultUser.username);
  } finally {
    await nuxeo.api.unlock(file.id).catch(() => {});
  }
});
