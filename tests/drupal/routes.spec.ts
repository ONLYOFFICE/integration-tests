import { randomUUID } from 'node:crypto';
import { downloadHeaders } from '@core';
import { expect, linkKey, test } from './fixtures';

/**
 * The routes Document Server calls without a session (download, empty file): the link key in the
 * URL and the JWT are checked independently. The shared download-security scenario covers the JWT
 * on a real link; this covers the keys the module would never hand out.
 */

test.describe('download and empty-file routes', () => {
  let downloadUrl: string;
  let fileId: string;
  let adminId: string;
  let content: Buffer;

  test.beforeEach(async ({ createFile, drupal, openEditor }) => {
    test.skip(!linkKey(['probe']), 'needs the link secret tests/setup/drupal.ts publishes for a stand it started');
    const file = await createFile('docx');
    downloadUrl = (await (await openEditor(file)).config()).document.url;
    fileId = (await drupal.api.getMedia(file.id)).fileId!;
    adminId = await drupal.api.userId(drupal.defaultUser.username);
    content = await drupal.downloadFile(file);
  });

  /** The same route with another key */
  const withKey = (key: string) => downloadUrl.replace(/[^/]+$/, key);
  const emptyFileUrl = (key: string) => downloadUrl.replace(/onlyoffice-download\/[^/]+$/, `onlyoffice-empty-file/${key}`);
  const get = (url: string, headers = downloadHeaders(url)) => fetch(url, { headers });

  test('the link Docs gets serves the file to the JWT of Document Server', async () => {
    const response = await get(downloadUrl);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(true);
  });

  test('an expired JWT is refused', async () => {
    const response = await get(downloadUrl, downloadHeaders(downloadUrl, undefined, { expiresIn: -60 }));
    expect(response.status).toBe(401);
  });

  test('keys the module did not sign, or signed for something else, are refused', async () => {
    const cases: [string, string, number][] = [
      ['a key that is no JWT at all', 'not-a-link-key', 400],
      ['a key signed with another secret', linkKey([fileId, adminId], { secret: 'not-the-drupal-link-secret' })!, 400],
      ['an expired key', linkKey([fileId, adminId], { expiresIn: -60 })!, 400],
      ['a key whose file id is not a UUID', linkKey(['not-a-uuid', adminId])!, 400],
      ['a key with one parameter', linkKey([fileId])!, 400],
      ['the key of the empty file', linkKey(['empty'])!, 400],
      ['a key for a file that does not exist', linkKey([randomUUID(), adminId])!, 404],
    ];
    for (const [label, key, status] of cases) {
      const url = withKey(key);
      expect((await get(url)).status, label).toBe(status);
    }
  });

  test('a key for an anonymous user serves a public file', async () => {
    const url = withKey(linkKey([fileId, '0'], { expiresIn: 600 })!);
    const response = await get(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(true);
  });

  test('only GET is allowed', async () => {
    expect((await fetch(downloadUrl, { method: 'POST', headers: downloadHeaders(downloadUrl) })).status).toBe(405);
  });

  test('the empty file for the connection check needs its own key and the JWT', async () => {
    const url = emptyFileUrl(linkKey(['empty'], { expiresIn: 600 })!);
    const response = await get(url);
    expect(response.status).toBe(200);
    // A docx is a zip archive
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');

    expect((await fetch(url)).status, 'without a JWT').toBe(401);
    expect((await get(emptyFileUrl(linkKey([fileId, adminId])!))).status, 'with a download key').toBe(400);
  });
});
