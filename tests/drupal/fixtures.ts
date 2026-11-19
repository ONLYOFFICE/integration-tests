import { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_EDITOR_CONFIG, signJwt, TestUser } from '@core';
import type { DrupalAdapter, DrupalMedia } from '@adapters/drupal';
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
  deleteMediaNamed: (name: string) => void;
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
    const names: string[] = [];
    await use((name) => {
      names.push(name);
    });
    for (const name of names) {
      for (const media of await drupal.api.findMedia(name).catch(() => [])) {
        await drupal.api.deleteMedia(media.uuid).catch(() => {});
      }
    }
  },

  pageAs: async ({ browser, drupal }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user, options = {}) => {
      const context = await browser.newContext({
        baseURL: drupal.baseUrl,
        storageState: undefined,
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      });
      contexts.push(context);
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
  const match = html.match(/var saveAsUrl = (.*);/);
  if (!match) {
    throw new Error('No saveAsUrl on the editor page');
  }
  return JSON.parse(match[1]) as string | null;
}
