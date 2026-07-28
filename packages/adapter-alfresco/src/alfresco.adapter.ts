import { Page } from '@playwright/test';
import { createBlankDocx, FileRef, FileType, HostAdapter, TestUser } from '@core';
import { AlfrescoApi } from './alfresco.api';

export interface AlfrescoOptions {
  baseUrl: string;
  admin: TestUser;
}

export class AlfrescoAdapter implements HostAdapter {
  readonly name = 'alfresco';
  readonly baseUrl: string;
  readonly defaultUser: TestUser;
  readonly editorFrameSelector = 'iframe[name="frameEditor"]';

  private readonly api: AlfrescoApi;

  constructor(options: AlfrescoOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultUser = options.admin;
    this.api = new AlfrescoApi(this.baseUrl, options.admin);
  }

  async login(page: Page, user: TestUser): Promise<void> {
    await page.goto('/share/page/');
    await page.fill('input[name="username"]', user.username);
    await page.fill('input[name="password"]', user.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard/, { timeout: 30_000 });
  }

  async createFile(name: string, type: FileType): Promise<FileRef> {
    if (type !== 'docx') {
      throw new Error(`Type "${type}" is not supported yet — add a template generator in packages/core/src/verify`);
    }
    const fileName = `${name}.${type}`;
    const node = await this.api.uploadFile(fileName, await createBlankDocx());
    return { id: node.id, name: fileName, type };
  }

  async openInEditor(page: Page, file: FileRef): Promise<void> {
    // The editing page added to Share by the onlyoffice-alfresco plugin
    await page.goto(`/share/page/onlyoffice-edit?nodeRef=workspace://SpacesStore/${file.id}`);
  }

  async downloadFile(file: FileRef): Promise<Buffer> {
    return this.api.downloadContent(file.id);
  }

  async getModifiedAt(file: FileRef): Promise<Date> {
    return new Date((await this.api.getNode(file.id)).modifiedAt);
  }

  async waitForSave(file: FileRef, since: Date, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getModifiedAt(file)) > since) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`File ${file.name} was not saved to Alfresco within ${timeoutMs} ms`);
  }

  async deleteFile(file: FileRef): Promise<void> {
    await this.api.deleteNode(file.id);
  }
}
