import { Page } from '@playwright/test';
import { FileRef, FileType, HostAdapter, LegacyFileType, loadConvertTemplate, loadTemplate, TestUser } from '@core';
import { LiferayApi } from './liferay.api';

export interface LiferayOptions {
  baseUrl: string;
  admin: TestUser;
  secondUser: TestUser;
  readOnlyUser: TestUser;
}

const CONVERT_TARGETS: Record<LegacyFileType, FileType> = { odt: 'docx', ods: 'xlsx', odp: 'pptx' };

// The plugin's EditorPortlet (see environments/liferay/artifacts) — display-category="category.hidden",
// so it's never placed on a page; it's only ever reached ad hoc via a portlet render URL carrying
// fileEntryId, the same URL its own "Edit with ONLYOFFICE" Documents and Media action opens (in a
// new window there — navigating the current page to it directly works identically). Exported for
// tests/setup/liferay.ts's grantEditorPortletAccess, which this resource id names its target.
export const EDITOR_PORTLET_ID = 'com_onlyoffice_liferay_docs_portlet_EditorPortlet';

export class LiferayAdapter implements HostAdapter {
  readonly name = 'liferay';
  readonly baseUrl: string;
  readonly defaultUser: TestUser;
  readonly secondUser: TestUser;
  readonly readOnlyUser: TestUser;

  private readonly api: LiferayApi;

  constructor(options: LiferayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultUser = options.admin;
    this.secondUser = options.secondUser;
    this.readOnlyUser = options.readOnlyUser;
    this.api = new LiferayApi(this.baseUrl, options.admin);
  }

  /**
   * Two separate sources of slowness/flakiness get handled differently here:
   *
   * 1. Liferay's classic theme JIT-compiles its Sass/JS bundles on the very first browser request
   *    after a fresh deploy, which can take well over Playwright's default 30s navigation timeout
   *    under load (this is a one-time, server-side cost — retrying the navigation doesn't avoid it,
   *    so this is just given a generous timeout rather than retried).
   * 2. Submitting immediately after the login form renders intermittently gets bounced back to the
   *    same login portlet (its own formDate/CSRF token appears not to always be ready the instant
   *    the fields are fillable) — since the redirect target (the guest home page) doesn't itself
   *    contain "/c/portal/login", a plain waitForURL away from that path doesn't catch this.
   *    Verified success by the login field actually disappearing, and retried a few times since
   *    re-submitting is cheap once the page itself has already loaded.
   */
  async login(page: Page, user: TestUser): Promise<void> {
    const loginField = 'input[name="_com_liferay_login_web_portlet_LoginPortlet_login"]';
    const passwordField = 'input[name="_com_liferay_login_web_portlet_LoginPortlet_password"]';

    await page.goto('/c/portal/login', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForSelector(loginField, { timeout: 90_000 });

    for (let attempt = 1; attempt <= 5; attempt++) {
      await page.fill(loginField, user.username);
      await page.fill(passwordField, user.password);
      // Same as the Alfresco adapter: the Sign In button is script-driven, so submit via Enter instead
      await page.press(passwordField, 'Enter');

      // A successful submit doesn't always do a full page reload (Liferay's theme uses Senna.js,
      // which can transition via AJAX/pushState), so the old login field can briefly linger in the
      // DOM even on success — a single post-submit count() check raced this and misread it as a
      // failure. Waiting for the field to become hidden/detached gives that transition time to
      // finish before deciding either way.
      const loggedIn = await page
        .waitForSelector(loginField, { state: 'hidden', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      if (loggedIn) {
        return;
      }
      // Genuinely bounced back to the login portlet — wait for it to be interactive before retrying
      await page.waitForSelector(loginField, { timeout: 30_000 });
    }
    throw new Error(`Liferay login as ${user.username} did not succeed after 5 attempts`);
  }

  async createFile(name: string, type: FileType): Promise<FileRef> {
    const fileName = `${name}.${type}`;
    const document = await this.api.uploadDocument(fileName, loadTemplate(type));
    const id = String(document.id);
    // The upload leaves the file editable only by admin (its owner) — secondUser needs its own
    // grant to open it for editing at all, e.g. in co-editing scenarios (see grantEditAccessFor).
    await this.api.grantEditAccessFor(id, this.secondUser.username);
    return { id, name: fileName, type };
  }

  /**
   * Navigates directly to the EditorPortlet's render URL for this document — the same URL its
   * "Edit with ONLYOFFICE" action in Documents and Media opens (there, in a new window; the
   * window is otherwise incidental to how the UI presents it, not something this URL requires).
   * p_p_auth (a CSRF token) turned out unnecessary for this GET/render request.
   */
  async openInEditor(page: Page, file: FileRef): Promise<void> {
    await page.goto(
      `/group/guest/~/control_panel/manage?p_p_id=${EDITOR_PORTLET_ID}&p_p_lifecycle=0&p_p_state=exclusive` +
        `&_${EDITOR_PORTLET_ID}_fileEntryId=${file.id}`,
    );
  }

  async downloadFile(file: FileRef): Promise<Buffer> {
    return this.api.downloadDocument(file.id);
  }

  async getModifiedAt(file: FileRef): Promise<Date> {
    return new Date((await this.api.getDocument(file.id)).dateModified);
  }

  async waitForSave(file: FileRef, since: Date, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getModifiedAt(file)) > since) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`File ${file.name} was not saved to Liferay within ${timeoutMs} ms`);
  }

  async deleteFile(file: FileRef): Promise<void> {
    await this.api.deleteDocument(file.id);
  }

  /** Grants readOnlyUser VIEW+DOWNLOAD (but not UPDATE) on this one file — see LiferayApi.setReadOnlyFor */
  async restrictToReadOnly(file: FileRef): Promise<void> {
    await this.api.setReadOnlyFor(file.id, this.readOnlyUser.username);
  }

  /**
   * The plugin's "Create new document" integration is a plain MVC action on Liferay's own
   * Document Library portlet (mvc.command.name=/document_library/create_onlyoffice on
   * com_liferay_document_library_web_portlet_DLPortlet), rendering a form (create.jsp) rather
   * than exposing a REST endpoint — so, unlike the other adapters' createFileViaPlugin, this
   * one drives that form instead of a single goto/POST. Reached via the same ad hoc
   * control_panel/manage rendering used by openInEditor (see EDITOR_PORTLET_ID above); folderId
   * and redirect are hidden fields the action requires, not just render params. On success the
   * action's render phase includes a script that navigates the page straight to the EditorPortlet
   * URL for the new file — the same URL openInEditor itself navigates to.
   */
  async createFileViaPlugin(page: Page, type: FileType): Promise<FileRef> {
    const portletId = 'com_liferay_document_library_web_portlet_DLPortlet';
    const name = `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await page.goto(
      `/group/guest/~/control_panel/manage?p_p_id=${portletId}&p_p_lifecycle=0` +
        `&_${portletId}_mvcRenderCommandName=%2Fdocument_library%2Fcreate_onlyoffice` +
        `&_${portletId}_folderId=0&_${portletId}_redirect=%2Fweb%2Fguest%2Fhome`,
    );
    await page.selectOption(`#_${portletId}_type`, type);
    await page.fill(`#_${portletId}_title`, name);

    const fileEntryIdParam = `_${EDITOR_PORTLET_ID}_fileEntryId`;
    await Promise.all([
      page.waitForURL((url) => url.searchParams.has(fileEntryIdParam), { timeout: 30_000 }),
      page.click(`#_${portletId}_saveButton`),
    ]);

    const id = new URL(page.url()).searchParams.get(fileEntryIdParam)!;
    return { id, name: `${name}.${type}`, type };
  }

  /**
   * The plugin's "Convert" integration (see LiferayApi.convertDocument) creates a new
   * DLFileEntry rather than replacing the source in place, so the source is uploaded under its
   * own name and cleaned up here once the converted result — looked up by the title the plugin
   * derives for it — is in hand (same shape as Alfresco/Jira's convertLegacyFile).
   */
  async convertLegacyFile(_page: Page, sourceType: LegacyFileType): Promise<FileRef> {
    const targetType = CONVERT_TARGETS[sourceType];
    const baseName = `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const source = await this.api.uploadDocument(`${baseName}.${sourceType}`, loadConvertTemplate(sourceType));

    await this.api.convertDocument(source.id);

    const convertedName = `${baseName}.${targetType}`;
    const converted = await this.api.findDocumentByTitle(convertedName);

    await this.api.deleteDocument(String(source.id)).catch(() => {
      // best-effort — the important cleanup is the converted result, tracked by the caller
    });
    return { id: String(converted.id), name: convertedName, type: targetType };
  }
}
