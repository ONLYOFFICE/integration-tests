import { randomUUID } from 'node:crypto';
import { documentServer, downloadHeaders, signJwt, TestUser } from '@core';
import { editorConfigOf, expect, test } from './fixtures';

/**
 * The routes Document Server calls without a session: the file download
 * (/api/v1/onlyoffice/download/{id}?token=…) and the test file of the connection check
 * (/api/v1/onlyoffice/test-txt). The token in the query authenticates as a Nuxeo user, the JWT in
 * the header as Document Server — both are needed. The shared download-security scenario covers
 * the JWT on a real link.
 */

/** Headers of a download request whose JWT carries `claims` besides the request itself */
function signedWith(url: string, claims: Record<string, unknown>): Record<string, string> {
  const { secret, header } = documentServer();
  return { [header]: `Bearer ${signJwt({ payload: { url }, ...claims }, secret)}` };
}

async function serves(response: Response, file: Buffer): Promise<boolean> {
  return response.ok && Buffer.from(await response.arrayBuffer()).equals(file);
}

test.describe('download', () => {
  let downloadUrl: string;
  let content: Buffer;

  test.beforeEach(async ({ createFile, nuxeo, page }) => {
    const file = await createFile('docx');
    downloadUrl = (await editorConfigOf(page, file.id)).document.url;
    content = await nuxeo.downloadFile(file);
  });

  /** The same route of the same user, for another document */
  const forDocument = (uid: string) => downloadUrl.replace(/\/download\/[^/?]+/, `/download/${uid}`);

  test('an expired JWT is refused', async () => {
    const response = await fetch(downloadUrl, { headers: downloadHeaders(downloadUrl, undefined, { expiresIn: -600 }) });
    expect(response.status).toBe(403);
  });

  test('a JWT for another operation is refused, one for downloading is accepted', async () => {
    expect((await fetch(downloadUrl, { headers: signedWith(downloadUrl, { operation: 'callback' }) })).status).toBe(403);
    expect(await serves(await fetch(downloadUrl, { headers: signedWith(downloadUrl, { operation: 'download' }) }), content)).toBe(
      true,
    );
  });

  test('the link does not work without the Nuxeo token of its user', async () => {
    const anonymous = downloadUrl.replace(/\?.*$/, '');
    expect((await fetch(anonymous, { headers: downloadHeaders(anonymous) })).status).toBe(401);
  });

  test('a document that does not exist answers 404', async () => {
    const url = forDocument(randomUUID());
    expect((await fetch(url, { headers: downloadHeaders(url) })).status).toBe(404);
  });

  test('the link of a user does not serve a document that user may not see', async ({ createFile, nuxeo, pageAs }) => {
    const own = await createFile('docx');
    const url = (await editorConfigOf(await pageAs(nuxeo.secondUser), own.id)).document.url;
    const hidden = await createFile('docx');
    await nuxeo.restrictToReadOnly(hidden);

    const hiddenUrl = url.replace(/\/download\/[^/?]+/, `/download/${hidden.id}`);
    expect(await serves(await fetch(hiddenUrl, { headers: downloadHeaders(hiddenUrl) }), content)).toBe(false);
  });

  test('only GET is allowed', async () => {
    expect((await fetch(downloadUrl, { method: 'POST', headers: downloadHeaders(downloadUrl) })).status).toBe(405);
  });
});

test.describe('the test file of the connection check', () => {
  const TEST_TXT = '/nuxeo/api/v1/onlyoffice/test-txt';

  test('is served to the administrator with the JWT of Document Server', async ({ nuxeo }) => {
    const url = `${nuxeo.baseUrl}${TEST_TXT}`;
    const response = await fetch(url, {
      headers: { ...downloadHeaders(url), 'X-Authentication-Token': await tokenOf(nuxeo.baseUrl, nuxeo.defaultUser) },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Test file for conversion');
  });

  test('needs the JWT, and one for downloading', async ({ nuxeo }) => {
    const url = `${nuxeo.baseUrl}${TEST_TXT}`;
    const auth = { 'X-Authentication-Token': await tokenOf(nuxeo.baseUrl, nuxeo.defaultUser) };

    expect((await fetch(url, { headers: auth })).status, 'without a JWT').toBe(401);
    expect(
      (await fetch(url, { headers: { ...auth, ...signedWith(url, { operation: 'callback' }) } })).status,
      'a JWT for another operation',
    ).toBe(401);
  });

  test('is closed to other users', async ({ nuxeo }) => {
    const url = `${nuxeo.baseUrl}${TEST_TXT}`;
    const basic = Buffer.from(`${nuxeo.secondUser.username}:${nuxeo.secondUser.password}`).toString('base64');

    expect((await fetch(url, { headers: { Authorization: `Basic ${basic}` } })).status).toBe(403);
  });
});

/**
 * A Nuxeo authentication token of the user, as the package puts one into the links it hands
 * Document Server — Basic auth would take the Authorization header the JWT travels in.
 */
async function tokenOf(baseUrl: string, user: TestUser): Promise<string> {
  const basic = Buffer.from(`${user.username}:${user.password}`).toString('base64');
  const response = await fetch(
    `${baseUrl}/nuxeo/authentication/token?applicationName=autotest&deviceId=${randomUUID()}&permission=rw`,
    { headers: { Authorization: `Basic ${basic}` } },
  );
  if (!response.ok) {
    throw new Error(`Could not acquire a Nuxeo token: ${response.status} ${await response.text()}`);
  }
  return response.text();
}
