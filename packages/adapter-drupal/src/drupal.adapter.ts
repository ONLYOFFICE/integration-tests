import { Page } from '@playwright/test';
import { FileRef, FileType, HostAdapter, LegacyFileType, loadTemplate, TestUser } from '@core';
import { DrupalApi } from './drupal.api';

export interface DrupalOptions {
  baseUrl: string;
  admin: TestUser;
  secondUser: TestUser;
  readOnlyUser: TestUser;
}

export class DrupalAdapter implements HostAdapter {
  readonly name = 'drupal';
  readonly baseUrl: string;
  readonly defaultUser: TestUser;
  readonly secondUser: TestUser;
  readonly readOnlyUser: TestUser;

  private readonly api: DrupalApi;

  constructor(options: DrupalOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultUser = options.admin;
    this.secondUser = options.secondUser;
    this.readOnlyUser = options.readOnlyUser;
    this.api = new DrupalApi(this.baseUrl, options.admin);
  }

  /**
   * Drupal's login form. A successful login redirects to the user's page, a rejected one renders
   * the form again on /user/login — reported as a failure rather than cached into the worker's
   * storageState.
   */
  async login(page: Page, user: TestUser): Promise<void> {
    await page.goto('/user/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const form = page.locator('#user-login-form');
    await form.locator('input[name="name"]').fill(user.username);
    await form.locator('input[name="pass"]').fill(user.password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith('/user/login'), { timeout: 60_000 }).catch(() => {}),
      form.locator('input[name="pass"]').press('Enter'),
    ]);

    if (new URL(page.url()).pathname.startsWith('/user/login')) {
      throw new Error(`[drupal] Login failed for ${user.username} — still on the login page`);
    }
  }

  async createFile(name: string, type: FileType): Promise<FileRef> {
    const fileName = `${name}.${type}`;
    const media = await this.api.createMedia(fileName, loadTemplate(type));
    return { id: media.uuid, name: fileName, type };
  }

  async openInEditor(page: Page, file: FileRef): Promise<void> {
    const { mid } = await this.api.getMedia(file.id);
    await page.goto(`/admin/media/${mid}/onlyoffice-editor`);
  }

  /** The module has no "create new document" flow — the scenario is excluded in playwright.config.ts */
  async createFileViaPlugin(): Promise<FileRef> {
    throw new Error('[drupal] The module has no "create new document" flow');
  }

  async downloadFile(file: FileRef): Promise<Buffer> {
    return this.api.downloadFile(file.id);
  }

  async getModifiedAt(file: FileRef): Promise<Date> {
    return new Date((await this.api.getMedia(file.id)).changed);
  }

  async waitForSave(file: FileRef, since: Date, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getModifiedAt(file)) > since) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`File ${file.name} was not saved to Drupal within ${timeoutMs} ms`);
  }

  async deleteFile(file: FileRef): Promise<void> {
    await this.api.deleteMedia(file.id);
  }

  /**
   * Nothing to do per file: Drupal grants media access by role, not per entity, and
   * tests/setup/drupal.ts gives readOnlyUser a role that can view media but not edit it.
   */
  async restrictToReadOnly(): Promise<void> {}

  /** The module has no conversion flow — the scenario is excluded in playwright.config.ts */
  async convertLegacyFile(_page: Page, _sourceType: LegacyFileType): Promise<FileRef> {
    throw new Error('[drupal] The module has no file conversion flow');
  }
}
