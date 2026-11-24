import { Page } from '@playwright/test';
import {
  ConnectionCheck,
  ConnectionSettings,
  DocsConnection,
  FileRef,
  FileType,
  HostAdapter,
  LegacyFileType,
  loadConvertTemplate,
  loadTemplate,
  TestUser,
} from '@core';
import { NUXEO_CONTEXT, NuxeoApi } from './nuxeo.api';

export interface NuxeoOptions {
  /** Nuxeo's origin, without the /nuxeo context path (e.g. http://192.168.1.10:8080) */
  baseUrl: string;
  admin: TestUser;
  secondUser: TestUser;
  readOnlyUser: TestUser;
}

/**
 * The plugin's editor page (its WebEngine module, mounted under /nuxeo/site): the URL its
 * "Open with ONLYOFFICE" Web UI button opens in a new window — navigating the current page to
 * it directly works identically. The page bootstraps Document Server's api.js into the default
 * `frameEditor` iframe, so no editorFrameSelector override is needed.
 */
export const EDITOR_PATH = `${NUXEO_CONTEXT}/site/onlyedit`;

const CONVERT_TARGETS: Record<LegacyFileType, FileType> = { odt: 'docx', ods: 'xlsx', odp: 'pptx' };
/** Editor document types the plugin's ONLYOFFICE.Create operation takes, per file type it produces */
const CREATE_TYPES: Record<FileType, 'word' | 'cell' | 'slide'> = { docx: 'word', xlsx: 'cell', pptx: 'slide' };

/** The package's settings endpoint (Administrator only) — what its Web UI settings page loads and saves */
export const SETTINGS_PATH = `${NUXEO_CONTEXT}/api/v1/onlyoffice/settings`;

export interface NuxeoSettings {
  url: string;
  innerUrl?: string;
  productInnerUrl?: string;
  security?: { key?: string; header?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Each connection check the package runs on saving its settings, by name */
export type ValidationResults = Record<string, { status?: string; error?: unknown }>;

export async function readSettings(page: Page): Promise<NuxeoSettings> {
  const response = await page.request.get(SETTINGS_PATH);
  if (!response.ok()) {
    throw new Error(`[nuxeo] GET ${SETTINGS_PATH}: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as NuxeoSettings;
}

/**
 * What to post to change `changes` over the `current` settings, as the settings page does: it
 * posts the whole form. `extra` is what the endpoint adds for the page to read (the api.js path),
 * not a setting — posted back, it would be stored as one.
 */
export function mergeSettings(current: NuxeoSettings, changes: Partial<NuxeoSettings>): NuxeoSettings {
  const { extra: _extra, ...settings } = current;
  return {
    ...settings,
    ...changes,
    security: { ...(settings.security ?? {}), ...(changes.security ?? {}) },
  };
}

export async function saveSettings(page: Page, changes: Partial<NuxeoSettings>): Promise<ValidationResults> {
  const settings = mergeSettings(await readSettings(page), changes);
  const response = await page.request.post(SETTINGS_PATH, { data: settings });
  if (!response.ok()) {
    throw new Error(`[nuxeo] POST ${SETTINGS_PATH}: ${response.status()} ${await response.text()}`);
  }
  return (((await response.json()) as { validationResults?: ValidationResults }).validationResults ?? {}) as ValidationResults;
}

export function failedChecks(results: ValidationResults): string[] {
  return Object.entries(results)
    .filter(([, result]) => String(result?.status).toLowerCase() !== 'success')
    .map(([name]) => name);
}

class NuxeoConnectionSettings implements ConnectionSettings {
  async read(page: Page): Promise<DocsConnection> {
    const settings = await readSettings(page);
    return {
      url: settings.url,
      secret: settings.security?.key ?? '',
      header: settings.security?.header || 'Authorization',
    };
  }

  async write(page: Page, connection: DocsConnection): Promise<ConnectionCheck> {
    const results = await saveSettings(page, {
      url: connection.url,
      security: { key: connection.secret, header: connection.header },
    });
    const failed = failedChecks(results);
    return {
      ok: Object.keys(results).length > 0 && failed.length === 0,
      message: failed.length ? `failed: ${failed.join(', ')} — ${JSON.stringify(results)}` : JSON.stringify(results),
    };
  }
}

function uniqueName(): string {
  return `autotest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class NuxeoAdapter implements HostAdapter {
  readonly name = 'nuxeo';
  readonly baseUrl: string;
  readonly defaultUser: TestUser;
  readonly secondUser: TestUser;
  readonly readOnlyUser: TestUser;
  readonly connectionSettings = new NuxeoConnectionSettings();

  readonly api: NuxeoApi;

  constructor(options: NuxeoOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultUser = options.admin;
    this.secondUser = options.secondUser;
    this.readOnlyUser = options.readOnlyUser;
    this.api = new NuxeoApi(this.baseUrl, options.admin);
  }

  /** The REST client acting as another user — e.g. to lock a document as that user */
  apiAs(user: TestUser): NuxeoApi {
    return new NuxeoApi(this.baseUrl, user);
  }

  /**
   * Nuxeo's form authentication (login.jsp / FormAuthenticator): user_name + user_password,
   * submitted via Enter. A rejected login lands back on login.jsp (with loginFailed=true), a
   * successful one is redirected to the requested page (Web UI) — so "no longer on login.jsp"
   * is the success criterion, and staying there is reported as a failure rather than cached
   * into the worker's storageState.
   */
  async login(page: Page, user: TestUser): Promise<void> {
    await page.goto(`${NUXEO_CONTEXT}/login.jsp`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const loginField = 'input[name="user_name"]';
    const passwordField = 'input[name="user_password"]';
    await page.waitForSelector(loginField, { timeout: 60_000 });

    await page.fill(loginField, user.username);
    await page.fill(passwordField, user.password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.endsWith('/login.jsp'), { timeout: 60_000 }).catch(() => {}),
      page.press(passwordField, 'Enter'),
    ]);

    if (new URL(page.url()).pathname.endsWith('/login.jsp')) {
      throw new Error(`[nuxeo] Login failed for ${user.username} — still on the login page`);
    }
  }

  /**
   * Uploads a blank template into the integration-tests workspace. No per-file grants: setup
   * gives secondUser ReadWrite (and readOnlyUser Read) on the whole workspace, which every
   * document created here inherits.
   */
  async createFile(name: string, type: FileType): Promise<FileRef> {
    const fileName = `${name}.${type}`;
    const document = await this.api.uploadDocument(fileName, loadTemplate(type));
    return { id: document.uid, name: fileName, type };
  }

  async openInEditor(page: Page, file: FileRef): Promise<void> {
    await page.goto(`${EDITOR_PATH}/${file.id}`);
  }

  /**
   * Drives the plugin's ONLYOFFICE.Create operation — the very call its Web UI "Create new"
   * dialog makes — then navigates to the editor for the new document, as that dialog does
   * (document.location.href = "../site/onlyedit/" + uid).
   */
  async createFileViaPlugin(page: Page, type: FileType): Promise<FileRef> {
    const title = uniqueName();
    const uid = await this.api.createViaPlugin(title, CREATE_TYPES[type]);
    await page.goto(`${EDITOR_PATH}/${uid}`);
    return { id: uid, name: `${title}.${type}`, type };
  }

  async downloadFile(file: FileRef): Promise<Buffer> {
    return this.api.downloadBlob(file.id);
  }

  async getModifiedAt(file: FileRef): Promise<Date> {
    return new Date((await this.api.getDocument(file.id)).modified);
  }

  async waitForSave(file: FileRef, since: Date, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.getModifiedAt(file)) > since) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`File ${file.name} was not saved to Nuxeo within ${timeoutMs} ms`);
  }

  async deleteFile(file: FileRef): Promise<void> {
    await this.api.deleteDocument(file.id);
  }

  /**
   * Cuts the file off from the workspace's ACL and grants readOnlyUser plain Read on it — the
   * plugin decides on edit vs. view mode by the WRITE_PROPERTIES permission (its /filter
   * endpoint), which Read doesn't carry. Explicit rather than relying on the workspace-level
   * Read the setup grants, so the scenario doesn't hinge on that ACL staying as it is.
   */
  async restrictToReadOnly(file: FileRef): Promise<void> {
    await this.api.blockPermissionInheritance(file.id);
    await this.api.addPermission(file.id, this.readOnlyUser.username, 'Read');
  }

  /**
   * The plugin's "Convert" integration (ONLYOFFICE.Convert) replaces the document's blob in
   * place once Document Server finishes — the document keeps its uid, only the blob (renamed to
   * the target extension) changes, so the source needs no separate cleanup. Each call is one
   * async convert request that DS answers with its progress; polled until endConvert.
   */
  async convertLegacyFile(_page: Page, sourceType: LegacyFileType): Promise<FileRef> {
    const targetType = CONVERT_TARGETS[sourceType];
    const baseName = uniqueName();
    const source = await this.api.uploadDocument(`${baseName}.${sourceType}`, loadConvertTemplate(sourceType));

    const deadline = Date.now() + 90_000;
    let last: unknown;
    while (Date.now() < deadline) {
      const response = await this.api.convert(source.uid);
      last = response;
      if (response.error) {
        throw new Error(`[nuxeo] Convert failed for ${source.title}: ${JSON.stringify(response)}`);
      }
      if (response.endConvert) {
        return { id: source.uid, name: `${baseName}.${targetType}`, type: targetType };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(
      `[nuxeo] Convert of ${source.title} did not finish within 90s (last response: ${JSON.stringify(last)})`,
    );
  }
}
