import { Page } from '@playwright/test';
import {
  ConnectionCheck,
  ConnectionSettings,
  DocsConnection,
  FileRef,
  FileType,
  HostAdapter,
  LegacyFileType,
  loadTemplate,
  TestUser,
} from '@core';
import { DrupalApi } from './drupal.api';

export const SETTINGS_PATH = '/admin/config/system/onlyoffice-settings';

export interface DrupalOptions {
  baseUrl: string;
  admin: TestUser;
  secondUser: TestUser;
  readOnlyUser: TestUser;
  /** Can create documents and edit only its own (tests/setup/drupal.ts) */
  ownerUser: TestUser;
}

/**
 * The module's settings form. The JWT header sits in the collapsed "Advanced server settings",
 * which is opened before filling it in.
 */
class DrupalConnectionSettings implements ConnectionSettings {
  async read(page: Page): Promise<DocsConnection> {
    await page.goto(SETTINGS_PATH);
    return {
      url: await page.locator('input[name="doc_server_url"]').inputValue(),
      secret: await page.locator('input[name="doc_server_jwt"]').inputValue(),
      header: (await page.locator('input[name="doc_server_jwt_header"]').inputValue()) || 'Authorization',
    };
  }

  async write(page: Page, connection: DocsConnection): Promise<ConnectionCheck> {
    await page.goto(SETTINGS_PATH);
    await page.locator('details:has(input[name="doc_server_jwt_header"])').evaluate((details) => {
      (details as HTMLDetailsElement).open = true;
    });
    await page.locator('input[name="doc_server_url"]').fill(connection.url);
    await page.locator('input[name="doc_server_jwt"]').fill(connection.secret);
    await page.locator('input[name="doc_server_jwt_header"]').fill(connection.header);
    await Promise.all([page.waitForLoadState('load'), page.locator('#edit-submit').click()]);

    // The form always saves valid settings and reports the check in a status or warning message
    const message = (await page.locator('[data-drupal-messages]').innerText().catch(() => '')).trim();
    return { ok: message.includes('connection check succeeded'), message };
  }
}

export class DrupalAdapter implements HostAdapter {
  readonly name = 'drupal';
  readonly baseUrl: string;
  readonly defaultUser: TestUser;
  readonly secondUser: TestUser;
  readonly readOnlyUser: TestUser;
  readonly ownerUser: TestUser;
  readonly connectionSettings = new DrupalConnectionSettings();

  readonly api: DrupalApi;

  constructor(options: DrupalOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultUser = options.admin;
    this.secondUser = options.secondUser;
    this.readOnlyUser = options.readOnlyUser;
    this.ownerUser = options.ownerUser;
    this.api = new DrupalApi(this.baseUrl, options.admin);
  }

  /** The JSON:API client acting as another user — e.g. to create media that user owns */
  apiAs(user: TestUser): DrupalApi {
    return new DrupalApi(this.baseUrl, user);
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
