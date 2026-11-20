import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_EDITOR_CONFIG, signJwt, TestUser } from '@core';
import { DrupalAdapter, DrupalMedia, DrupalMediaType, DrupalNode, PDF_FORM } from '@adapters/drupal';
import { test as base } from '../fixtures';

interface DrupalFixtures {
  drupal: DrupalAdapter;
  /**
   * Creates a Document media from any file through JSON:API, owned by `owner` (the admin by
   * default), and deletes it after the test.
   */
  createMedia: (
    fileName: string,
    content: Buffer,
    options?: { published?: boolean; owner?: TestUser },
  ) => Promise<DrupalMedia>;
  /** Deletes the media with this name after the test — for media the module creates, such as copies */
  deleteMediaNamed: (name: string, type?: DrupalMediaType) => void;
  /** Creates an ONLYOFFICE PDF form media (the blank form by default) and deletes it after the test */
  createForm: (name?: string, content?: Buffer) => Promise<DrupalMedia>;
  /** Creates a page showing `form` in its ONLYOFFICE form field and deletes it after the test */
  createFormPage: (form: DrupalMedia) => Promise<DrupalNode>;
  /**
   * A page logged in as `user` (anonymous when null) in its own browser context, recording the
   * editor config like the openEditor fixtures do.
   */
  pageAs: (user: TestUser | null, options?: { userAgent?: string }) => Promise<Page>;
}

export const test = base.extend<DrupalFixtures>({
  drupal: async ({ adapter }, use) => use(adapter as DrupalAdapter),

  createMedia: async ({ drupal }, use) => {
    const created: DrupalMedia[] = [];
    await use(async (fileName, content, options = {}) => {
      const api = options.owner ? drupal.apiAs(options.owner) : drupal.api;
      const media = await api.createMedia(fileName, content, options.published ?? true);
      created.push(media);
      return media;
    });
    for (const media of created) {
      await drupal.api.deleteMedia(media.uuid).catch(() => {});
    }
  },

  deleteMediaNamed: async ({ drupal }, use) => {
    const names: { name: string; type?: DrupalMediaType }[] = [];
    await use((name, type) => {
      names.push({ name, type });
    });
    for (const { name, type } of names) {
      for (const media of await drupal.api.findMedia(name, type).catch(() => [])) {
        await drupal.api.deleteMedia(media.uuid, type).catch(() => {});
      }
    }
  },

  createForm: async ({ drupal }, use) => {
    const created: DrupalMedia[] = [];
    await use(async (name = uniqueName('pdf'), content = loadBlankForm()) => {
      const form = await drupal.api.createMedia(name, content, true, PDF_FORM);
      created.push(form);
      return form;
    });
    for (const form of created) {
      await drupal.api.deleteMedia(form.uuid, PDF_FORM).catch(() => {});
    }
  },

  createFormPage: async ({ drupal }, use) => {
    const created: DrupalNode[] = [];
    await use(async (form) => {
      const node = await drupal.api.createNode(`Form page ${form.name}`, form.mid);
      created.push(node);
      return node;
    });
    for (const node of created) {
      await drupal.api.deleteNode(node.uuid).catch(() => {});
    }
  },

  pageAs: async ({ browser, drupal, editorTraffic }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user, options = {}) => {
      const context = await browser.newContext({
        baseURL: drupal.baseUrl,
        storageState: undefined,
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      });
      contexts.push(context);
      editorTraffic.watchContext(context, user?.username ?? 'anonymous');
      await context.addInitScript(CAPTURE_EDITOR_CONFIG);
      const page = await context.newPage();
      if (user) {
        await drupal.login(page, user);
      }
      return page;
    });
    for (const context of contexts) {
      await context.close();
    }
  },
});

export { expect } from '../fixtures';

/** The blank PDF form of ONLYOFFICE's document templates — what the module creates a blank form from */
export function loadBlankForm(): Buffer {
  return fs.readFileSync(path.resolve(__dirname, '..', '..', 'resources', 'files', 'blank', 'blank.pdf'));
}

export function uniqueName(extension: string): string {
  return `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
}

export function editorPath(media: { mid: number }, query = ''): string {
  return `/admin/media/${media.mid}/onlyoffice-editor${query}`;
}

/**
 * A link key as the module signs it (OnlyofficeUrlHelper::createLinkToken()), with the secret
 * tests/setup/drupal.ts publishes — for keys the module would never hand out. Undefined when the
 * tests reuse an existing Drupal, which publishes no secret; callers skip then.
 */
export function linkKey(params: unknown[], options: { expiresIn?: number; secret?: string } = {}): string | undefined {
  const secret = options.secret ?? process.env.DRUPAL_LINK_SECRET;
  return secret ? signJwt({ params }, secret, { expiresIn: options.expiresIn }) : undefined;
}

/**
 * The "Save copy as" URL of the editor page, with its CSRF token — the page passes it to its own
 * script only, so it is read from the HTML. Null when the user may not save a copy.
 */
export async function saveAsUrl(page: Page, media: { mid: number }): Promise<string | null> {
  const html = await (await page.request.get(editorPath(media))).text();
  const match = html.match(/var saveAsUrl = ("(?:[^"\\]|\\.)*"|null);/);
  if (!match) {
    throw new Error('No saveAsUrl on the editor page');
  }
  return JSON.parse(match[1]) as string | null;
}
