import { CAPTURE_EDITOR_CONFIG, convertWithDocumentServer, documentServer, loadTemplate, waitForEditorConfig } from '@core';
import { Page } from '@playwright/test';
import { editorPath, expect, saveAsUrl, test, uniqueName } from './fixtures';

/**
 * "Save copy as": the editor hands the page a URL of the copy on Document Server, and the page
 * posts it to the module's save-as route — which these scenarios post to directly, the way the
 * page's script does. A real copy URL comes from Document Server's conversion of the document.
 */

interface Answer {
  status: number;
  error?: number;
  message?: string;
}

async function saveAs(page: Page, url: string, data: Record<string, unknown>): Promise<Answer> {
  const response = await page.request.post(url, { data });
  const json = (await response.json().catch(() => ({}))) as { error?: number; message?: string };
  return { status: response.status(), ...json };
}

/** The media name a successful answer reports ("The copy was saved as <name>.") */
function savedName(answer: Answer): string {
  const name = answer.message?.match(/saved as (.+)\.$/)?.[1];
  if (!name) {
    throw new Error(`No copy name in ${JSON.stringify(answer)}`);
  }
  return name;
}

test.describe('save copy as', () => {
  let url: string;
  let copyUrl: string;
  let fileType: string;

  test.beforeEach(async ({ createMedia, page }) => {
    const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
    await page.addInitScript(CAPTURE_EDITOR_CONFIG);
    await page.goto(editorPath(media));
    const config = await waitForEditorConfig(page);
    fileType = config.document.fileType;
    copyUrl = await convertWithDocumentServer(config.document.url, fileType);
    url = (await saveAsUrl(page, media))!;
    expect(url).toBeTruthy();
  });

  test('saves the copy as a new unpublished media of the same type', async ({ deleteMediaNamed, drupal, page }) => {
    const title = uniqueName('docx');
    deleteMediaNamed(title);

    const answer = await saveAs(page, url, { title, fileType, url: copyUrl });
    expect(answer).toMatchObject({ status: 200, error: 0 });
    expect(savedName(answer)).toBe(title);

    const [copy] = await drupal.api.findMedia(title);
    expect(copy.published).toBe(false);
    const saved = Buffer.from(await (await fetch(`${drupal.baseUrl}${copy.fileUrl}`)).arrayBuffer());
    expect(saved.equals(Buffer.from(await (await fetch(copyUrl)).arrayBuffer()))).toBe(true);
  });

  test('adds the extension to a title without it and strips a path from the title', async ({ deleteMediaNamed, page }) => {
    const base = uniqueName('docx').replace(/\.docx$/, '');
    deleteMediaNamed(`${base}.docx`);
    deleteMediaNamed(`${base}-path.docx`);

    expect(savedName(await saveAs(page, url, { title: base, fileType, url: copyUrl }))).toBe(`${base}.docx`);
    expect(savedName(await saveAs(page, url, { title: `../../etc/${base}-path.docx`, fileType, url: copyUrl }))).toBe(
      `${base}-path.docx`,
    );
  });

  test('keeps both copies saved under the same name, in different files', async ({ deleteMediaNamed, drupal, page }) => {
    const title = uniqueName('docx');
    deleteMediaNamed(title);

    expect(await saveAs(page, url, { title, fileType, url: copyUrl })).toMatchObject({ error: 0 });
    expect(await saveAs(page, url, { title, fileType, url: copyUrl })).toMatchObject({ error: 0 });
    const copies = await drupal.api.findMedia(title);
    expect(copies).toHaveLength(2);
    expect(copies[0].fileUrl).not.toBe(copies[1].fileUrl);
  });

  test('refuses file URLs outside Document Server', async ({ page }) => {
    const docs = new URL(documentServer().url);
    const cases: [string, string][] = [
      ['another host', 'http://example.com/output.docx'],
      ['dot segments under the Docs address', `${docs.origin}/cache/../../etc/passwd`],
      ['a host that only starts with the Docs host', `${docs.protocol}//${docs.host}.evil.example.com/output.docx`],
    ];
    for (const [label, fileUrl] of cases) {
      expect(await saveAs(page, url, { title: uniqueName('docx'), fileType, url: fileUrl }), label).toMatchObject({
        status: 400,
        error: 1,
        message: 'The file URL does not match the ONLYOFFICE Docs address.',
      });
    }
  });

  test('refuses an invalid or disallowed file type', async ({ page }) => {
    expect(await saveAs(page, url, { title: 'copy', fileType: 'do cx', url: copyUrl }), 'invalid').toMatchObject({
      status: 400,
      message: 'Invalid request.',
    });
    // Not among the extensions the Document media field allows
    expect(await saveAs(page, url, { title: 'copy', fileType: 'exe', url: copyUrl }), 'disallowed').toMatchObject({
      status: 400,
      error: 1,
    });
  });

  test('reports a copy Document Server cannot hand out', async ({ page }) => {
    const missing = `${documentServer().url}cache/files/data/autotest-missing/output.docx`;

    expect(await saveAs(page, url, { title: uniqueName('docx'), fileType, url: missing })).toMatchObject({
      status: 500,
      message: 'Failed to download the copy from ONLYOFFICE Docs.',
    });
  });

  test('takes only POST with the CSRF token of the page', async ({ page }) => {
    expect((await page.request.get(url)).status(), 'GET').toBe(405);
    const withoutToken = url.replace(/\?.*$/, '');
    expect((await saveAs(page, withoutToken, { title: 'copy', fileType, url: copyUrl })).status, 'no token').toBe(403);
  });
});
