import { BrowserContext, test as base, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { EditorPage } from '../editor/editor.page';
import { FileRef, FileType, HostAdapter, TestUser } from '../types';

export type AdapterFactory = () => HostAdapter;

const registry = new Map<string, AdapterFactory>();

/**
 * Associates a Playwright project name with a host system adapter.
 * Called from tests/fixtures.ts when tests are loaded.
 */
export function registerAdapter(projectName: string, factory: AdapterFactory): void {
  registry.set(projectName, factory);
}

interface TestFixtures {
  /** Creates a file via the API and deletes it after the test */
  createFile: (type?: FileType) => Promise<FileRef>;
  /** Opens the file in the editor and waits for it to fully load */
  openEditor: (file: FileRef) => Promise<EditorPage>;
  /**
   * Opens the file in the editor as a given user, in its own independent browser session —
   * for scenarios that need more than one simultaneous editing session (e.g. co-editing).
   */
  openEditorAs: (user: TestUser, file: FileRef) => Promise<EditorPage>;
}

interface WorkerFixtures {
  adapter: HostAdapter;
  workerStorageState: string;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  adapter: [
    async ({}, use, workerInfo) => {
      const factory = registry.get(workerInfo.project.name);
      if (!factory) {
        throw new Error(
          `No adapter registered for project "${workerInfo.project.name}" — ` +
            'add a registerAdapter() call in tests/fixtures.ts',
        );
      }
      await use(factory());
    },
    { scope: 'worker' },
  ],

  // UI login runs once per worker, then the session
  // is reused by all tests via storageState
  workerStorageState: [
    async ({ browser, adapter }, use, workerInfo) => {
      const statePath = path.join(
        workerInfo.project.outputDir,
        '.auth',
        `${adapter.name}-worker-${workerInfo.workerIndex}.json`,
      );
      if (!fs.existsSync(statePath)) {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        const page = await browser.newPage({ baseURL: adapter.baseUrl });
        await adapter.login(page, adapter.defaultUser);
        await page.context().storageState({ path: statePath });
        await page.close();
      }
      await use(statePath);
    },
    { scope: 'worker' },
  ],

  storageState: ({ workerStorageState }, use) => use(workerStorageState),

  // The stack address is determined in global.setup (process.env.ALFRESCO_URL),
  // so baseURL is taken from the adapter in the worker, not from playwright.config
  baseURL: ({ adapter }, use) => use(adapter.baseUrl),

  createFile: async ({ adapter }, use) => {
    const created: FileRef[] = [];
    await use(async (type: FileType = 'docx') => {
      const name = `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const file = await adapter.createFile(name, type);
      created.push(file);
      return file;
    });
    for (const file of created) {
      await adapter.deleteFile(file).catch(() => {
        // the file may have been deleted by the test itself — don't fail teardown
      });
    }
  },

  openEditor: async ({ page, adapter }, use) => {
    await use(async (file: FileRef) => {
      await adapter.openInEditor(page, file);
      return EditorPage.attach(page, adapter.editorFrameSelector);
    });
  },

  openEditorAs: async ({ browser, adapter }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user: TestUser, file: FileRef) => {
      // browser.newContext() defaults to the test's active `storageState` fixture (the admin
      // session captured above) unless told otherwise — without this override, the "independent"
      // session here would silently start out already authenticated as the primary user
      const context = await browser.newContext({ baseURL: adapter.baseUrl, storageState: undefined });
      contexts.push(context);
      const page = await context.newPage();
      await adapter.login(page, user);
      await adapter.openInEditor(page, file);
      return EditorPage.attach(page, adapter.editorFrameSelector);
    });
    for (const context of contexts) {
      await context.close();
    }
  },
});

export { expect };
