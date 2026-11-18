import { BrowserContext, Page } from '@playwright/test';
import { CAPTURE_EDITOR_CONFIG, TestUser } from '@core';
import type { DrupalAdapter, DrupalMedia } from '@adapters/drupal';
import { test as base } from '../fixtures';

interface DrupalFixtures {
  drupal: DrupalAdapter;
  /** Creates a Document media from any file through JSON:API and deletes it after the test */
  createMedia: (fileName: string, content: Buffer, options?: { published?: boolean }) => Promise<DrupalMedia>;
  /**
   * A page logged in as `user` (anonymous when null) in its own browser context, recording the
   * editor config like the openEditor fixtures do.
   */
  pageAs: (user: TestUser | null) => Promise<Page>;
}

export const test = base.extend<DrupalFixtures>({
  drupal: async ({ adapter }, use) => use(adapter as DrupalAdapter),

  createMedia: async ({ drupal }, use) => {
    const created: DrupalMedia[] = [];
    await use(async (fileName, content, options = {}) => {
      const media = await drupal.api.createMedia(fileName, content, options.published ?? true);
      created.push(media);
      return media;
    });
    for (const media of created) {
      await drupal.api.deleteMedia(media.uuid).catch(() => {});
    }
  },

  pageAs: async ({ browser, drupal }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user) => {
      const context = await browser.newContext({ baseURL: drupal.baseUrl, storageState: undefined });
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
