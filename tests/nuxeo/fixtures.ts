import { execFileSync } from 'node:child_process';
import { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_EDITOR_CONFIG, convertWithDocumentServer, EditorConfig, TestUser, waitForEditorConfig } from '@core';
import { EDITOR_PATH, NuxeoAdapter, NuxeoDocument } from '@adapters/nuxeo';
import { test as base } from '../fixtures';

interface NuxeoFixtures {
  nuxeo: NuxeoAdapter;
  /**
   * Uploads any file as a File document in the test workspace (titled by its file name unless
   * `title` is given) and deletes it after the test.
   */
  createDocument: (fileName: string, content: Buffer, options?: { title?: string }) => Promise<NuxeoDocument>;
  /** Deletes the document with this uid after the test — for documents the package creates */
  deleteAfter: (uid: string) => void;
  /**
   * A page logged in as `user` (anonymous when null) in its own browser context, recording the
   * editor config like the openEditor fixtures do.
   */
  pageAs: (user: TestUser | null, options?: { locale?: string }) => Promise<Page>;
}

export const test = base.extend<NuxeoFixtures>({
  nuxeo: async ({ adapter }, use) => use(adapter as NuxeoAdapter),

  createDocument: async ({ nuxeo }, use) => {
    const created: string[] = [];
    await use(async (fileName, content, options = {}) => {
      const document = await nuxeo.api.uploadDocument(fileName, content, options);
      created.push(document.uid);
      return document;
    });
    for (const uid of created) {
      await nuxeo.api.deleteDocument(uid).catch(() => {});
    }
  },

  deleteAfter: async ({ nuxeo }, use) => {
    const uids: string[] = [];
    await use((uid) => {
      uids.push(uid);
    });
    for (const uid of uids) {
      await nuxeo.api.deleteDocument(uid).catch(() => {});
    }
  },

  pageAs: async ({ browser, nuxeo }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user, options = {}) => {
      const context = await browser.newContext({
        baseURL: nuxeo.baseUrl,
        storageState: undefined,
        ...(options.locale ? { locale: options.locale } : {}),
      });
      contexts.push(context);
      await context.addInitScript(CAPTURE_EDITOR_CONFIG);
      const page = await context.newPage();
      if (user) {
        await nuxeo.login(page, user);
      }
      return page;
    });
    for (const context of contexts) {
      await context.close();
    }
  },
});

export { expect } from '../fixtures';

export function uniqueName(extension: string): string {
  return `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
}

export function editorPath(uid: string): string {
  return `${EDITOR_PATH}/${uid}`;
}

/**
 * The config the editor page hands Docs. The editor frame itself is kept from loading: no editing
 * session is opened (nor the document locked by one), and Document Server isn't loaded with
 * editors nobody looks at while the other scenarios run in parallel.
 */
export async function editorConfigOf(page: Page, uid: string): Promise<EditorConfig> {
  const editorFrame = (url: URL) => url.pathname.includes('/web-apps/apps/') && url.pathname.endsWith('/index.html');
  await page.addInitScript(CAPTURE_EDITOR_CONFIG);
  await page.route(editorFrame, (route) => route.abort());
  try {
    await page.goto(editorPath(uid));
    return await waitForEditorConfig(page);
  } finally {
    await page.unroute(editorFrame);
  }
}

/**
 * A docx with `text` in it, as a file on Document Server — what Docs hands the callback when
 * saving. Made by Document Server's conversion of a text document it downloads from Nuxeo.
 */
export async function docxOnDocumentServer(
  page: Page,
  createDocument: NuxeoFixtures['createDocument'],
  text: string,
): Promise<string> {
  const source = await createDocument(uniqueName('txt'), Buffer.from(text));
  return convertWithDocumentServer((await editorConfigOf(page, source.uid)).document.url, 'txt', 'docx');
}

/** The package's /filter answer for the document — what decides the Web UI's "Edit"/"View in ONLYOFFICE" action */
export async function filterOf(page: Page, uid: string): Promise<{ mode?: string }> {
  const response = await page.request.get(`/nuxeo/api/v1/onlyoffice/filter/${uid}`);
  if (!response.ok()) {
    throw new Error(`/onlyoffice/filter/${uid}: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as { mode?: string };
}

/**
 * Runs a command in the Nuxeo container the tests started — published by tests/setup/nuxeo.ts;
 * undefined when the tests reuse an existing Nuxeo (NUXEO_URL), so callers skip then.
 */
export function standExec(): ((...args: string[]) => string) | undefined {
  const container = process.env.NUXEO_CONTAINER;
  if (!container) {
    return undefined;
  }
  return (...args) => execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8' });
}
