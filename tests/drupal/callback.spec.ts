import { randomUUID } from 'node:crypto';
import { convertWithDocumentServer, documentServer, EditorConfig, signedCallbackBody, signJwt } from '@core';
import { expect, linkKey, test } from './fixtures';

/**
 * The module's answers to callbacks Document Server would never send as they are — permission
 * checks, missing fields, malformed bodies. The shared callback-security scenario covers the JWT
 * itself; real saves are covered by the shared edit-save scenarios and revisions.spec.ts.
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

test.describe('callback', () => {
  let config: EditorConfig;
  let callbackUrl: string;
  let fileIdBefore: string | undefined;
  let mediaId: string;

  test.beforeEach(async ({ createFile, drupal, openEditor }) => {
    const file = await createFile('docx');
    mediaId = file.id;
    config = await (await openEditor(file)).config();
    callbackUrl = config.editorConfig.callbackUrl!;
    fileIdBefore = (await drupal.api.getMedia(file.id)).fileId;
  });

  const save = (extra: Record<string, unknown> = {}) => ({
    key: config.document.key,
    status: 2,
    url: config.document.url,
    ...extra,
  });

  test('a save by a user who cannot edit the media is refused', async ({ drupal }) => {
    const users = [await drupal.api.userId(drupal.readOnlyUser.username)];

    expect(await post(callbackUrl, signedCallbackBody(save({ users })))).toEqual({ status: 403, error: 1 });
    expect((await drupal.api.getMedia(mediaId)).fileId).toBe(fileIdBefore);
  });

  test('a save without a user is refused', async ({ drupal }) => {
    expect(await post(callbackUrl, signedCallbackBody(save()))).toEqual({ status: 403, error: 1 });
    expect((await drupal.api.getMedia(mediaId)).fileId).toBe(fileIdBefore);
  });

  test('a save without the file URL is refused', async ({ drupal }) => {
    const users = [await drupal.api.userId(drupal.defaultUser.username)];

    expect(await post(callbackUrl, signedCallbackBody(save({ users, url: undefined })))).toEqual({ status: 400, error: 1 });
  });

  test('a forged link key is refused even with a valid JWT', async ({ drupal }) => {
    const users = [await drupal.api.userId(drupal.defaultUser.username)];
    const forged = callbackUrl.replace(/[^/]+$/, 'not-a-link-key');

    expect(await post(forged, signedCallbackBody(save({ users })))).toEqual({ status: 400, error: 1 });
  });

  test('force save and unknown statuses are acknowledged without saving', async ({ drupal }) => {
    const users = [await drupal.api.userId(drupal.defaultUser.username)];

    expect(await post(callbackUrl, signedCallbackBody(save({ users, status: 6 })))).toEqual({ status: 200, error: 0 });
    expect(await post(callbackUrl, signedCallbackBody(save({ users, status: 42 })))).toEqual({ status: 200, error: 0 });
    expect((await drupal.api.getMedia(mediaId)).fileId).toBe(fileIdBefore);
  });

  test('a token in the header only is accepted, as Document Server may send it', async () => {
    const body = { key: config.document.key, status: 4 };
    const { secret, header } = documentServer();

    expect(
      await post(callbackUrl, JSON.stringify(body), { [header]: `Bearer ${signJwt({ payload: body }, secret)}` }),
    ).toEqual({ status: 200, error: 0 });
  });

  test('malformed requests are refused', async () => {
    const { secret, header } = documentServer();
    const body = { key: config.document.key, status: 4 };

    expect(await post(callbackUrl, '42'), 'a body that is a JSON number').toEqual({ status: 400, error: 1 });
    expect(await post(callbackUrl, '[]'), 'a body that is a JSON array').toEqual({ status: 400, error: 1 });
    expect(
      await post(callbackUrl, JSON.stringify(body), { [header]: `Bearer ${signJwt(body, secret)}` }),
      'a header token without payload',
    ).toEqual({ status: 401, error: 1 });
    expect(await post(callbackUrl, JSON.stringify({ ...body, token: 42 })), 'a token that is not a string').toEqual({
      status: 401,
      error: 1,
    });
    expect(await post(callbackUrl, ''), 'an empty body').toEqual({ status: 400, error: 1 });
    expect(await post(callbackUrl, JSON.stringify(body)), 'no token').toEqual({ status: 401, error: 1 });
    expect(await post(callbackUrl, JSON.stringify({ ...body, token: 'not.a.token' })), 'a broken token').toEqual({
      status: 401,
      error: 1,
    });
    expect((await fetch(callbackUrl)).status, 'GET').toBe(405);
  });

  test('a link key for a media that does not exist answers 404', async () => {
    const key = linkKey([randomUUID()]);
    test.skip(!key, 'needs the link secret tests/setup/drupal.ts publishes for a stand it started');

    expect(await post(callbackUrl.replace(/[^/]+$/, key!), signedCallbackBody({ key: 'x', status: 4 }))).toEqual({
      status: 404,
      error: 1,
    });
  });

  test('editing and closing without changes are acknowledged', async () => {
    const opened = { key: config.document.key, status: 1, actions: [{ type: 1, userid: config.editorConfig.user?.id }] };

    expect(await post(callbackUrl, signedCallbackBody(opened))).toEqual({ status: 200, error: 0 });
    expect(await post(callbackUrl, signedCallbackBody({ key: config.document.key, status: 4 }))).toEqual({
      status: 200,
      error: 0,
    });
  });

  test('the request is taken from the token, not from the body around it', async ({ drupal }) => {
    const users = [await drupal.api.userId(drupal.defaultUser.username)];
    const signed = { key: config.document.key, status: 4 };
    const body = { ...save({ users }), token: signJwt(signed, documentServer().secret) };

    expect(await post(callbackUrl, JSON.stringify(body))).toEqual({ status: 200, error: 0 });
    expect((await drupal.api.getMedia(mediaId)).fileId).toBe(fileIdBefore);
  });

  test('a save whose file cannot be downloaded is refused and saves nothing', async ({ drupal }) => {
    const users = [await drupal.api.userId(drupal.defaultUser.username)];

    expect(await post(callbackUrl, signedCallbackBody(save({ users, url: 'http://127.0.0.1:9/output.docx' })))).toEqual({
      status: 400,
      error: 1,
    });
    expect((await drupal.api.getMedia(mediaId)).fileId).toBe(fileIdBefore);
  });

  test('a save of a corrupted session (status 3) is kept as a new revision too', async ({ drupal }) => {
    const users = [await drupal.api.userId(drupal.defaultUser.username)];
    const url = await convertWithDocumentServer(config.document.url, 'docx');

    expect(await post(callbackUrl, signedCallbackBody(save({ users, url, status: 3 })))).toEqual({ status: 200, error: 0 });
    const after = await drupal.api.getMedia(mediaId);
    expect(after.fileId).not.toBe(fileIdBefore);
    expect(await drupal.api.fileExists(fileIdBefore!), 'the previous file').toBe(true);
  });
});
