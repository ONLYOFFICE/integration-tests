import { NuxeoSettings, readSettings, saveSettings, SETTINGS_PATH } from '@adapters/nuxeo';
import { documentServer } from '@core';
import { editorConfigOf, editorPath, expect, standExec, test } from '../nuxeo/fixtures';

/**
 * Package settings beyond the connection itself (tests/shared-settings covers that), changed for
 * the whole stand — so these run one at a time before the nuxeo project (playwright.config.ts)
 * and put the settings they found back after each scenario.
 */

let original: NuxeoSettings;

test.beforeEach(async ({ page }) => {
  original = await readSettings(page);
});

test.afterEach(async ({ page }) => {
  await saveSettings(page, {
    url: original.url,
    innerUrl: original.innerUrl ?? '',
    productInnerUrl: original.productInnerUrl ?? '',
    security: original.security,
  });
  expect(await readSettings(page)).toMatchObject({ url: original.url, security: original.security });
});

test('the address for requests from Document Server is used in the links handed to it, not in the way back', async ({
  createFile,
  nuxeo,
  page,
}) => {
  const internal = 'http://nuxeo.internal.example:8080/';
  await saveSettings(page, { productInnerUrl: internal });
  const config = await editorConfigOf(page, (await createFile('docx')).id);

  expect(config.document.url.startsWith('http://nuxeo.internal.example:8080/nuxeo/api/v1/onlyoffice/download/')).toBe(true);
  expect(config.editorConfig.callbackUrl!.startsWith('http://nuxeo.internal.example:8080/nuxeo/api/v1/onlyoffice/callback/')).toBe(
    true,
  );
  const goback = (config.editorConfig.customization as { goback?: { url?: string } }).goback;
  expect(goback?.url?.startsWith(`${nuxeo.baseUrl}/nuxeo/ui/`)).toBe(true);
});

test('with an address for requests from the server, the browser and the server reach Document Server separately', async ({
  createFile,
  page,
}) => {
  const results = await saveSettings(page, { url: 'http://docs.public.example/', innerUrl: documentServer().url });

  // The checks run from the server, through the internal address, so they pass…
  expect(results.commandService?.status, JSON.stringify(results)).toBe('success');
  expect(results.convertService?.status, JSON.stringify(results)).toBe('success');
  // …while the browser is pointed at the public one (which doesn't exist, so no editor loads)
  await page.goto(editorPath((await createFile('docx')).id));
  const sources = await page.locator('script[src*="api/documents/api.js"]').evaluateAll((scripts) =>
    scripts.map((script) => (script as HTMLScriptElement).src),
  );
  expect(sources.map((source) => new URL(source).origin)).toEqual(['http://docs.public.example']);
});

test('settings with special characters are written so that Nuxeo reads them back unchanged', async ({ page }) => {
  const exec = standExec();
  test.skip(!exec, 'reading the settings file needs the container of a stand the tests started');

  const secret = 'Aa1 =:#!\\ \tπ-secret-0123456789';
  await saveSettings(page, { security: { key: secret } });

  expect((await readSettings(page)).security?.key).toBe(secret);
  // What a restart loads: the file the package keeps its settings in
  const stored = parseProperties(exec!('cat', '/opt/nuxeo/server/nxserver/config/onlyoffice.properties'));
  expect(stored['onlyoffice.security.key']).toBe(secret);
});

test('the data the settings page gets along with the settings is not stored as a setting', async ({ page }) => {
  const exec = standExec();
  test.skip(!exec, 'reading the settings file needs the container of a stand the tests started');

  // The page posts back the whole object it read, extra (the api.js path) included
  const settings = await readSettings(page);
  expect(settings.extra).toBeTruthy();
  const response = await page.request.post(SETTINGS_PATH, { data: settings });
  expect(response.ok()).toBe(true);

  const stored = parseProperties(exec!('cat', '/opt/nuxeo/server/nxserver/config/onlyoffice.properties'));
  expect(stored['onlyoffice.url']).toBe(settings.url);
  expect(Object.keys(stored).filter((key) => key.startsWith('onlyoffice.extra'))).toEqual([]);
});

/** java.util.Properties.load() for the lines Properties.store() writes: no continuations, escapes in keys and values */
function parseProperties(text: string): Record<string, string> {
  const unescape = (value: string) =>
    value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escaped: string) => {
      if (escaped.length === 5) {
        return String.fromCharCode(parseInt(escaped.slice(1), 16));
      }
      return { t: '\t', n: '\n', r: '\r', f: '\f' }[escaped] ?? escaped;
    });
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#!]/.test(line)) {
      continue;
    }
    let end = 0;
    while (end < line.length && line[end] !== '=' && line[end] !== ':') {
      end += line[end] === '\\' ? 2 : 1;
    }
    result[unescape(line.slice(0, end).trim())] = unescape(line.slice(end + 1).replace(/^\s+/, ''));
  }
  return result;
}
