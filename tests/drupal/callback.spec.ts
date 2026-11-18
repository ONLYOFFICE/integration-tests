import { documentServerJwt, EditorConfig, signedCallbackBody, signJwt } from '@core';
import { expect, test } from './fixtures';

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
    const { secret, header } = documentServerJwt();

    expect(
      await post(callbackUrl, JSON.stringify(body), { [header]: `Bearer ${signJwt({ payload: body }, secret)}` }),
    ).toEqual({ status: 200, error: 0 });
  });

  test('malformed requests are refused', async () => {
    const { secret, header } = documentServerJwt();
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
  });
});
