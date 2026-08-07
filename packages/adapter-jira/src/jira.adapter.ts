import { Page } from '@playwright/test';
import { FileRef, FileType, HostAdapter, LegacyFileType, loadConvertTemplate, loadTemplate, TestUser } from '@core';
import { JiraApi } from './jira.api';

export interface JiraOptions {
  baseUrl: string;
  admin: TestUser;
  secondUser: TestUser;
  readOnlyUser: TestUser;
}

// Jira has no bare "file" content type — every attachment needs a hosting issue, so all test
// files live as attachments on issues in one dedicated project, created once during global
// setup (see tests/setup/jira.ts's ensureTestProject) — must match TEST_PROJECT_KEY there.
const TEST_PROJECT_KEY = 'OIT';

// The plugin's own "create new document" API (see JiraApi.createIssue callers) expects these
// lowercase values, unlike the query-param form used elsewhere in the plugin which is uppercase
const CREATE_DOCUMENT_TYPES: Record<FileType, string> = { docx: 'word', xlsx: 'cell', pptx: 'slide' };

// The plugin's own conversion dialog picks the default convert target itself — these are just
// the OOXML types it lands on for each source
const CONVERT_TARGETS: Record<LegacyFileType, FileType> = { odt: 'docx', ods: 'xlsx', odp: 'pptx' };

export class JiraAdapter implements HostAdapter {
  readonly name = 'jira';
  readonly baseUrl: string;
  readonly defaultUser: TestUser;
  readonly secondUser: TestUser;
  readonly readOnlyUser: TestUser;

  private readonly api: JiraApi;

  constructor(options: JiraOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultUser = options.admin;
    this.secondUser = options.secondUser;
    this.readOnlyUser = options.readOnlyUser;
    this.api = new JiraApi(this.baseUrl, options.admin);
  }

  async login(page: Page, user: TestUser): Promise<void> {
    await page.goto('/login.jsp');
    await page.fill('#login-form-username', user.username);
    await page.fill('#login-form-password', user.password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes('/login.jsp'), { timeout: 30_000 }).catch(() => {}),
      page.click('#login-form-submit'),
    ]);
  }

  async createFile(name: string, type: FileType): Promise<FileRef> {
    const fileName = `${name}.${type}`;
    const issueId = await this.api.createIssue(TEST_PROJECT_KEY, name);
    await this.api.uploadAttachment(issueId, fileName, loadTemplate(type));
    return { id: issueId, name: fileName, type };
  }

  async openInEditor(page: Page, file: FileRef): Promise<void> {
    const { id: attachmentId } = await this.api.getLatestAttachment(file.id);
    await page.goto(`/plugins/servlet/onlyoffice/doceditor?attachmentId=${attachmentId}`);
  }

  /**
   * Drives the same request the plugin's own editor page issues client-side when creating a
   * blank document (onlyoffice-create-file.js POSTs this before navigating to doceditor) —
   * navigating directly to doceditor?issueId=... does not itself create the attachment, so the
   * API call is made explicitly here, through the same browser context so it carries the
   * session cookie, then the page is navigated to the resulting attachment's editor.
   */
  async createFileViaPlugin(page: Page, type: FileType): Promise<FileRef> {
    const name = `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issueId = await this.api.createIssue(TEST_PROJECT_KEY, name);

    const response = await page.request.post('/plugins/servlet/onlyoffice/api?type=create-new', {
      data: { issueId: Number(issueId), documentType: CREATE_DOCUMENT_TYPES[type], fileName: name },
    });
    const { attachmentId } = (await response.json()) as { attachmentId: string };

    await page.goto(`/plugins/servlet/onlyoffice/doceditor?attachmentId=${attachmentId}`);
    const attachment = await this.api.getAttachment(attachmentId);
    return { id: issueId, name: attachment.name, type };
  }

  async downloadFile(file: FileRef): Promise<Buffer> {
    const { downloadUrl } = await this.api.getLatestAttachment(file.id);
    return this.api.downloadAttachment(downloadUrl);
  }

  async getModifiedAt(file: FileRef): Promise<Date> {
    return (await this.api.getLatestAttachment(file.id)).createdAt;
  }

  async waitForSave(file: FileRef, since: Date, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getModifiedAt(file)) > since) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`File ${file.name} was not saved to Jira within ${timeoutMs} ms`);
  }

  async deleteFile(file: FileRef): Promise<void> {
    await this.api.deleteIssue(file.id);
  }

  /**
   * A no-op: unlike Confluence/Alfresco, Jira has no per-issue or per-attachment "read only for
   * user X" restriction — CREATE_ATTACHMENTS/EDIT_ISSUES are granted per project, not per issue.
   * readOnlyUser is permanently excluded from the test project's "Editors" role (see
   * tests/setup/jira.ts's ensureTestProject), so every file in the project is already read-only
   * for them from the moment the project is created — there is nothing left to restrict on a
   * specific file.
   */
  async restrictToReadOnly(_file: FileRef): Promise<void> {}

  async convertLegacyFile(_page: Page, sourceType: LegacyFileType): Promise<FileRef> {
    const targetType = CONVERT_TARGETS[sourceType];
    const baseName = `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const issueId = await this.api.createIssue(TEST_PROJECT_KEY, baseName);
    const source = await this.api.uploadAttachment(issueId, `${baseName}.${sourceType}`, loadConvertTemplate(sourceType));

    const converted = await this.api.convertAttachment(issueId, source.id, baseName, targetType);
    return { id: issueId, name: converted.name, type: targetType };
  }
}
