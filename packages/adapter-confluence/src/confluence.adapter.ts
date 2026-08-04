import { Page } from '@playwright/test';
import { FileRef, FileType, HostAdapter, loadTemplate, TestUser } from '@core';
import { ConfluenceApi } from './confluence.api';

export interface ConfluenceOptions {
  baseUrl: string;
  admin: TestUser;
}

// Confluence has no bare "file" content type — every attachment needs a hosting page,
// so all test files live as attachments on pages in one dedicated space.
const TEST_SPACE_KEY = 'OITEST';
const TEST_SPACE_NAME = 'Integration Tests';

export class ConfluenceAdapter implements HostAdapter {
  readonly name = 'confluence';
  readonly baseUrl: string;
  readonly defaultUser: TestUser;

  private readonly api: ConfluenceApi;
  private ensureSpacePromise: Promise<void> | null = null;

  constructor(options: ConfluenceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultUser = options.admin;
    this.api = new ConfluenceApi(this.baseUrl, options.admin);
  }

  /** file.id encodes both ids — the attachment holds the content, the page owns it */
  private parseId(id: string): { pageId: string; attachmentId: string } {
    const [pageId, attachmentId] = id.split(':');
    return { pageId, attachmentId };
  }

  private async ensureTestSpace(): Promise<void> {
    if (!this.ensureSpacePromise) {
      this.ensureSpacePromise = this.api.ensureSpace(TEST_SPACE_KEY, TEST_SPACE_NAME);
    }
    await this.ensureSpacePromise;
  }

  /**
   * Multiple Playwright workers logging in as the same admin user at nearly the same time
   * (right after the stand boots) occasionally race on Confluence's side: the login POST
   * succeeds, but the session it creates isn't valid yet, and the next navigation bounces
   * back to /login.action with `permissionViolation=true`. A few attempts clear it reliably.
   */
  async login(page: Page, user: TestUser): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await page.goto('/login.action');
      await page.fill('#username-field', user.username);
      await page.fill('#password-field', user.password);
      await Promise.all([
        page.waitForURL((url) => !url.pathname.includes('/login.action'), { timeout: 30_000 }).catch(() => {}),
        page.click('button[type="submit"]'),
      ]);
      if (!page.url().includes('/login.action')) {
        return;
      }
    }
    throw new Error(`[confluence] Login did not complete after ${maxAttempts} attempts (stuck on ${page.url()})`);
  }

  async createFile(name: string, type: FileType): Promise<FileRef> {
    await this.ensureTestSpace();

    const fileName = `${name}.${type}`;
    const pageId = await this.api.createPage(TEST_SPACE_KEY, name);
    const attachment = await this.api.uploadAttachment(pageId, fileName, loadTemplate(type));
    return { id: `${pageId}:${attachment.id}`, name: fileName, type };
  }

  async openInEditor(page: Page, file: FileRef): Promise<void> {
    // The link the plugin itself renders on an attachment's "Edit" web-item
    const { attachmentId } = this.parseId(file.id);
    await page.goto(`/plugins/servlet/onlyoffice/doceditor?attachmentId=${attachmentId}`);
  }

  async downloadFile(file: FileRef): Promise<Buffer> {
    const { attachmentId } = this.parseId(file.id);
    const { downloadUrl } = await this.api.getAttachment(attachmentId);
    return this.api.downloadAttachment(downloadUrl);
  }

  async getModifiedAt(file: FileRef): Promise<Date> {
    const { attachmentId } = this.parseId(file.id);
    return (await this.api.getAttachment(attachmentId)).modifiedAt;
  }

  async waitForSave(file: FileRef, since: Date, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getModifiedAt(file)) > since) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`File ${file.name} was not saved to Confluence within ${timeoutMs} ms`);
  }

  async deleteFile(file: FileRef): Promise<void> {
    // Deleting the page cascades to its attachments — no need to delete the attachment separately
    const { pageId } = this.parseId(file.id);
    await this.api.deleteContent(pageId);
  }
}
