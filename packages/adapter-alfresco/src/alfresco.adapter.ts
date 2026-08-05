import { Page } from '@playwright/test';
import { FileRef, FileType, HostAdapter, loadTemplate, TestUser } from '@core';
import { AlfrescoApi } from './alfresco.api';

export interface AlfrescoOptions {
  baseUrl: string;
  admin: TestUser;
  secondUser: TestUser;
  readOnlyUser: TestUser;
}

// The plugin's own "Create" menu (see onlyoffice-config.xml's create-content entries) opens
// onlyoffice-edit?parentNodeRef=...&new=<mime> for exactly these three mime types
const CREATE_MIME_TYPES: Record<FileType, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export class AlfrescoAdapter implements HostAdapter {
  readonly name = 'alfresco';
  readonly baseUrl: string;
  readonly defaultUser: TestUser;
  readonly secondUser: TestUser;
  readonly readOnlyUser: TestUser;
  readonly editorFrameSelector = 'iframe[name="frameEditor"]';

  private readonly api: AlfrescoApi;

  constructor(options: AlfrescoOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultUser = options.admin;
    this.secondUser = options.secondUser;
    this.readOnlyUser = options.readOnlyUser;
    this.api = new AlfrescoApi(this.baseUrl, options.admin);
  }

  async login(page: Page, user: TestUser): Promise<void> {
    await page.goto('/share/page/');
    await page.fill('input[name="username"]', user.username);
    await page.fill('input[name="password"]', user.password);
    // The Sign In button is overridden by a YUI script, so we just submit the form
    await page.press('input[name="password"]', 'Enter');
    await page.waitForURL(/dashboard/, { timeout: 30_000 });
  }

  async createFile(name: string, type: FileType): Promise<FileRef> {
    const fileName = `${name}.${type}`;
    const node = await this.api.uploadFile(fileName, loadTemplate(type));
    return { id: node.id, name: fileName, type };
  }

  async openInEditor(page: Page, file: FileRef): Promise<void> {
    // The editing page added to Share by the onlyoffice-alfresco plugin
    await page.goto(`/share/page/onlyoffice-edit?nodeRef=workspace://SpacesStore/${file.id}`);
  }

  /**
   * Drives the same URL the plugin's Share "Create" menu opens (see onlyoffice-doclib-actions.js:
   * `onlyoffice-edit?parentNodeRef=...&new=<mime>`) — the plugin creates a blank file in the
   * user's home folder and redirects the page itself to `?nodeRef=<new node>`.
   */
  async createFileViaPlugin(page: Page, type: FileType): Promise<FileRef> {
    const home = await this.api.getNode('-my-');
    await page.goto(
      `/share/page/onlyoffice-edit?parentNodeRef=workspace://SpacesStore/${home.id}&new=${encodeURIComponent(CREATE_MIME_TYPES[type])}`,
    );
    await page.waitForURL((url) => url.searchParams.has('nodeRef'), { timeout: 30_000 });

    const nodeRef = new URL(page.url()).searchParams.get('nodeRef')!;
    const id = nodeRef.split('/').pop()!;
    const node = await this.api.getNode(id);
    return { id, name: node.name, type };
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

  /** Grants readOnlyUser the "Consumer" (read-only) permission on the file's node */
  async restrictToReadOnly(file: FileRef): Promise<void> {
    await this.api.setNodePermission(file.id, this.readOnlyUser.username, 'Consumer');
  }

  /**
   * Writes the Document Server URL and JWT secret into the onlyoffice-alfresco
   * plugin settings and verifies the connection via the plugin's built-in validation.
   */
  async configureDocumentServer(documentServerUrl: string, jwtSecret: string): Promise<void> {
    await this.api.postWebScript('/onlyoffice/onlyoffice-config', {
      lossyEdit: ['csv', 'otp', 'ott', 'ots', 'txt', 'odp', 'odt', 'ods'],
      url: documentServerUrl,
      innerUrl: '',
      productInnerUrl: '',
      security: { key: jwtSecret, header: '' },
      ignoreSSLCertificate: 'false',
      demo: 'false',
      customization: {
        forcesave: 'false',
        feedback: 'false',
        chat: 'true',
        help: 'true',
        compactHeader: 'false',
        review: { reviewDisplay: 'original' },
      },
      minorVersion: 'false',
      convertOriginal: 'false',
      webpreview: 'false',
    });

    await this.validateDocumentServer();
  }

  /** Creates the secondUser account, if it doesn't already exist, as a repository administrator */
  async ensureSecondUser(): Promise<void> {
    await this.api.ensurePerson(this.secondUser);
    await this.api.addToAdminGroup(this.secondUser);
  }

  /**
   * Creates the readOnlyUser account, if it doesn't already exist. Unlike secondUser, it's a
   * plain (non-admin) person — admins bypass per-node ACLs, so testing read-only access
   * requires an account that Alfresco's permission checks actually apply to.
   */
  async ensureReadOnlyUser(): Promise<void> {
    await this.api.ensurePerson(this.readOnlyUser);
  }

  /** Plugin's built-in check: DS availability, command and convert services (including JWT) */
  async validateDocumentServer(): Promise<void> {
    const { validationResults } = await this.api.getWebScript<{
      validationResults: Record<string, { status: string; message?: string }>;
    }>('/onlyoffice/onlyoffice-config-validation');

    const failed = Object.entries(validationResults).filter(([, r]) => r.status !== 'success');
    if (failed.length > 0) {
      const details = failed.map(([name, r]) => `${name}: ${r.message ?? r.status}`).join('; ');
      throw new Error(`ONLYOFFICE plugin failed to connect to Document Server — ${details}`);
    }
  }
}
