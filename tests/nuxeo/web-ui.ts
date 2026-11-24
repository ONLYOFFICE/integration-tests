import { Locator, Page } from '@playwright/test';
import { WORKSPACE_PATH } from '@adapters/nuxeo';

/**
 * Nuxeo Web UI (/nuxeo/ui) and the elements the package adds to it. They live in the shadow DOM
 * of Web UI's own elements, which Playwright's CSS locators pierce.
 */

/**
 * Web UI holds its start back while navigator.webdriver is set until it gets an `automation-ready`
 * event or finds window.automationReady (a hook for Nuxeo's own functional tests), so under
 * Playwright it shows its loading screen forever without this.
 */
const AUTOMATION_READY = 'window.automationReady = true;';

/**
 * Records every message the page asks Web UI to show as a toast. Web UI opens a toast of its own for
 * each commandId and stacks them, but closes each after a few seconds, so the screen alone can't
 * tell whether a message was shown once it closed.
 */
const RECORD_NOTIFICATIONS = `
  window.__notifications = [];
  document.addEventListener('notify', (event) => window.__notifications.push(String(event.detail && event.detail.message)), true);
`;

const prepared = new WeakSet<Page>();

/** Document Server's editor frame, kept from loading where only the way to it is under test */
export const EDITOR_FRAME = (url: URL) => url.pathname.includes('/web-apps/apps/') && url.pathname.endsWith('/index.html');

export const UI_PATH = '/nuxeo/ui/';

export class NuxeoWebUi {
  constructor(readonly page: Page) {}

  private async prepare(): Promise<void> {
    if (!prepared.has(this.page)) {
      prepared.add(this.page);
      await this.page.addInitScript(AUTOMATION_READY);
      await this.page.addInitScript(RECORD_NOTIFICATIONS);
      // Logging in lands on Web UI, which the scripts came too late for, and going to a route of it
      // from there only changes the hash, without loading it again
      if (this.page.url().includes(UI_PATH)) {
        await this.page.goto('about:blank');
      }
    }
  }

  async goto(route: string): Promise<void> {
    await this.prepare();
    await this.page.goto(`${UI_PATH}#!/${route}`);
  }

  /**
   * Opens the document's page in a freshly loaded Web UI and waits for what the package's actions
   * decide on: its /filter answer (the editor action) and the formats (the convert action). Their
   * absence is only meaningful after both.
   */
  async openDocument(uid: string): Promise<void> {
    // The formats are requested once per element, so only a fresh load is sure to ask for them;
    // a change of the hash alone keeps the elements
    if (this.page.url().includes(UI_PATH)) {
      await this.page.goto('about:blank');
    }
    const filter = this.page.waitForResponse((response) => response.url().endsWith(`/onlyoffice/filter/${uid}`));
    const formats = this.page.waitForResponse((response) => response.url().endsWith('/onlyoffice/formats'));
    await this.goto(`doc/${uid}`);
    await Promise.all([filter, formats]);
  }

  async openWorkspace(): Promise<void> {
    await this.goto(`browse${WORKSPACE_PATH}`);
  }

  async openSettings(): Promise<void> {
    const loaded = this.page.waitForResponse(
      (response) => response.url().endsWith('/onlyoffice/settings') && response.request().method() === 'GET',
    );
    await this.goto('admin/onlyoffice-settings');
    await loaded;
  }

  get editorAction(): Locator {
    return this.page.locator('onlyoffice-editor-button .action');
  }

  get editorActionLabel(): Locator {
    return this.page.locator('onlyoffice-editor-button .label');
  }

  /** The convert action of the main file (file:content), shown in the document's viewer */
  get convertAction(): Locator {
    return this.page.locator('nuxeo-document-viewer onlyoffice-convert-button .action');
  }

  /** The convert actions of the attachments (files:files) */
  get attachmentConvertActions(): Locator {
    return this.page.locator('nuxeo-document-attachments onlyoffice-convert-button .action');
  }

  get convertDialog(): Locator {
    return this.page.locator('nuxeo-document-viewer onlyoffice-convert-button #convertDialog');
  }

  async isConvertDialogOpen(): Promise<boolean> {
    return this.convertDialog.evaluate((dialog) => Boolean((dialog as unknown as { opened: boolean }).opened));
  }

  get settingsMenuItem(): Locator {
    return this.page.locator('nuxeo-menu-item[name="onlyoffice-settings"]');
  }

  settingsInput(name: 'doc-url' | 'jwt-secret' | 'jwt-header' | 'doc-inner-url' | 'nuxeo-inner-url'): Locator {
    return this.page.locator(`onlyoffice-settings nuxeo-input[name="${name}"] input`);
  }

  get settingsSaveButton(): Locator {
    return this.page.locator('onlyoffice-settings #saveButton');
  }

  /** Opens the "New" popup on the ONLYOFFICE tab — the page must show a folder */
  async openCreateDialog(): Promise<Locator> {
    await this.page.locator('nuxeo-document-create-button #createBtn').click();
    await this.page.locator('nuxeo-document-create-popup paper-tab[name="onlyofficeCreate"]').click();
    const dialog = this.page.locator('onlyoffice-create');
    await dialog.locator('nuxeo-input#title input').waitFor();
    return dialog;
  }

  /** The messages of the toasts open on screen now, one per commandId the page notified with */
  async openToasts(): Promise<string[]> {
    return this.page
      .locator('mwc-snackbar')
      .evaluateAll((toasts) =>
        toasts
          .map((toast) => toast as unknown as { open: boolean; labelText: string })
          .filter((toast) => toast.open)
          .map((toast) => toast.labelText),
      );
  }

  /** Every message shown as a toast since the page loaded, in order */
  async notifications(): Promise<string[]> {
    return this.page.evaluate(() => (window as unknown as { __notifications: string[] }).__notifications.slice());
  }

  /** How many requests of the package's ONLYOFFICE.Convert operation were sent from now on */
  recordConvertRequests(): { count: number } {
    const sent = { count: 0 };
    this.page.on('request', (request) => {
      if (request.url().endsWith('/automation/ONLYOFFICE.Convert')) {
        sent.count++;
      }
    });
    return sent;
  }
}

/** An Automation operation's answer the way Nuxeo wraps a string result — ONLYOFFICE.Convert serializes its own into it */
export function operationString(value: unknown): { status: number; contentType: string; body: string } {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ 'entity-type': 'string', value: JSON.stringify(value) }),
  };
}
