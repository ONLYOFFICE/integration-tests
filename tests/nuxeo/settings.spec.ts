import { SETTINGS_PATH } from '@adapters/nuxeo';
import { expect, test } from './fixtures';

/**
 * The settings endpoint without saving anything: the stand's settings are shared by every scenario
 * running in parallel. Scenarios that do change them are in tests/nuxeo-settings.
 */

test('the settings are closed to users other than administrators', async ({ nuxeo, page }) => {
  const url = `${nuxeo.baseUrl}${SETTINGS_PATH}`;
  const basic = Buffer.from(`${nuxeo.secondUser.username}:${nuxeo.secondUser.password}`).toString('base64');
  const headers = { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
  const before = await nuxeo.connectionSettings.read(page);

  expect((await fetch(url, { headers })).status, 'reading').toBe(403);
  const write = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1:9/' }) });
  expect(write.status, 'saving').toBe(403);
  expect(await nuxeo.connectionSettings.read(page)).toEqual(before);
});

