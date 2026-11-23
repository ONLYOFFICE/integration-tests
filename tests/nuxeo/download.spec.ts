import { randomUUID } from 'node:crypto';
import { documentServer, downloadHeaders, signJwt, TestUser } from '@core';
import { editorConfigOf, expect, test } from './fixtures';

/**
 * The routes Document Server calls without a session: the file download
 * (/api/v1/onlyoffice/download/{id}?token=…) and the test file of the connection check
 * (/api/v1/onlyoffice/test-txt). The token in the query is the package's own, signed for one
 * operation on one document and naming the user it acts as; the JWT in the header authenticates
 * Document Server — both are needed. The shared download-security scenario covers the JWT on a
 * real link.
 */

/** The link token of a url the package hands Document Server */
function linkTokenOf(url: string): string {
  return new URL(url).searchParams.get('token')!;
}

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
  let callbackUrl: string;
  let content: Buffer;

  test.beforeEach(async ({ createFile, nuxeo, page }) => {
    const file = await createFile('docx');
    const config = await editorConfigOf(page, file.id);
    downloadUrl = config.document.url;
    callbackUrl = config.editorConfig.callbackUrl!;
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

  test('the link does not work without its token', async () => {
    const anonymous = downloadUrl.replace(/\?.*$/, '');
    expect((await fetch(anonymous, { headers: downloadHeaders(anonymous) })).status).toBe(401);
  });

  test('the link of a document is refused for any other document', async ({ createFile }) => {
    for (const uid of [randomUUID(), (await createFile('docx')).id]) {
      const url = forDocument(uid);
      expect((await fetch(url, { headers: downloadHeaders(url) })).status, uid).toBe(401);
    }
  });

  test('the token of the callback link is refused for the download', async () => {
    const url = downloadUrl.replace(/\?.*$/, `?token=${linkTokenOf(callbackUrl)}`);
    expect((await fetch(url, { headers: downloadHeaders(url) })).status).toBe(401);
  });

  test('the link token does not authenticate anywhere else in Nuxeo', async ({ nuxeo }) => {
    const token = linkTokenOf(downloadUrl);
    const me = `${nuxeo.baseUrl}/nuxeo/api/v1/me`;

    expect((await fetch(`${me}?token=${token}`)).status, 'as the token of a Nuxeo request').toBe(401);
    expect((await fetch(me, { headers: { 'X-Authentication-Token': token } })).status, 'as a Nuxeo token').toBe(401);
  });

  test('the link acts with the permissions its user has now', async ({ createFile, nuxeo, pageAs }) => {
    const own = await createFile('docx');
    const url = (await editorConfigOf(await pageAs(nuxeo.secondUser), own.id)).document.url;
    // secondUser may no longer see the document
    await nuxeo.restrictToReadOnly(own);

    expect(await serves(await fetch(url, { headers: downloadHeaders(url) }), await nuxeo.downloadFile(own))).toBe(false);
  });

  test('only GET is served', async () => {
    expect((await fetch(downloadUrl, { method: 'POST', headers: downloadHeaders(downloadUrl) })).status).toBe(401);
  });
});

test.describe('the test file of the connection check', () => {
  // Its link is made by the settings validation and handed only to Document Server; the connection
  // checks (tests/shared-settings) cover that it is served through that link
  const TEST_TXT = '/nuxeo/api/v1/onlyoffice/test-txt';

  test('is not served without its link, even to an administrator', async ({ nuxeo }) => {
    const url = `${nuxeo.baseUrl}${TEST_TXT}`;
    const nuxeoToken = { 'X-Authentication-Token': await tokenOf(nuxeo.baseUrl, nuxeo.defaultUser) };
    const basic = Buffer.from(`${nuxeo.defaultUser.username}:${nuxeo.defaultUser.password}`).toString('base64');

    expect((await fetch(url, { headers: { ...downloadHeaders(url), ...nuxeoToken } })).status, 'Nuxeo token').toBe(401);
    expect((await fetch(url, { headers: { Authorization: `Basic ${basic}` } })).status, 'Basic').toBe(401);
  });

  test('is not served with the link token of a document', async ({ createFile, nuxeo, page }) => {
    const downloadUrl = (await editorConfigOf(page, (await createFile('docx')).id)).document.url;
    const url = `${nuxeo.baseUrl}${TEST_TXT}?token=${linkTokenOf(downloadUrl)}`;

    expect((await fetch(url, { headers: downloadHeaders(url) })).status).toBe(401);
  });
});

/**
 * A Nuxeo authentication token of the user, as earlier versions of the package put into the links
 * they handed Document Server — Basic auth would take the Authorization header the JWT travels in.
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
