import type { Page } from '@playwright/test';

export type FileType = 'docx' | 'xlsx' | 'pptx';

/** Legacy OpenDocument formats the plugin's "Convert" integration turns into FileType */
export type LegacyFileType = 'odt' | 'ods' | 'odp';

export interface TestUser {
  username: string;
  password: string;
}

export interface FileRef {
  /** File identifier in the host system (nodeId, contentId, etc.) */
  id: string;
  name: string;
  type: FileType;
}

/** The plugin's settings for reaching Document Server */
export interface DocsConnection {
  /** Document Server address the browser loads the editor from */
  url: string;
  /** JWT secret; empty disables JWT in the plugin */
  secret: string;
  /** Header the JWT travels in between Document Server and the host */
  header: string;
}

export interface ConnectionCheck {
  /** Whether the plugin's own connection check passed */
  ok: boolean;
  /** What the plugin reported */
  message: string;
}

/**
 * Changing the plugin's connection settings the way an administrator does, for the serial
 * scenarios in tests/shared-settings. Every call opens the settings in `page` (logged in as the
 * default user).
 */
export interface ConnectionSettings {
  read(page: Page): Promise<DocsConnection>;
  /** Saves the settings and returns the result of the check the plugin runs on saving */
  write(page: Page, connection: DocsConnection): Promise<ConnectionCheck>;
}

/**
 * Host system contract. Every connector (Alfresco, Confluence, ...)
 * implements this interface — shared scenarios in tests/shared are
 * written only against it.
 */
export interface HostAdapter {
  readonly name: string;
  readonly baseUrl: string;
  /** The user used for the default login */
  readonly defaultUser: TestUser;
  /** A second, independent account — used by scenarios that need two simultaneous editing sessions */
  readonly secondUser: TestUser;
  /** A third, independent account with no edit rights by default — used by read-only scenarios */
  readonly readOnlyUser: TestUser;
  /** Selector for the editor iframe on the host system page */
  readonly editorFrameSelector?: string;
  /**
   * Only adapters that implement it get the tests/shared-settings scenarios — see the settings
   * option of system() in playwright.config.ts.
   */
  readonly connectionSettings?: ConnectionSettings;

  /** UI login; the result is cached by fixtures via storageState */
  login(page: Page, user: TestUser): Promise<void>;

  /** Creates a file via the host system's REST API (not via UI) */
  createFile(name: string, type: FileType): Promise<FileRef>;

  /**
   * Creates a new blank file through the plugin's own "Create new document" integration
   * (not via the host's REST API) and leaves `page` navigated to it in the editor —
   * used by scenarios that verify this specific plugin↔host integration point.
   */
  createFileViaPlugin(page: Page, type: FileType): Promise<FileRef>;

  /** Navigates to the file's editing page in ONLYOFFICE */
  openInEditor(page: Page, file: FileRef): Promise<void>;

  downloadFile(file: FileRef): Promise<Buffer>;

  /** Last modified date according to the host system */
  getModifiedAt(file: FileRef): Promise<Date>;

  /**
   * Waits for Document Server to deliver changes to the host system
   * (the callback arrives asynchronously, after the editing session closes).
   */
  waitForSave(file: FileRef, since: Date, timeoutMs?: number): Promise<void>;

  deleteFile(file: FileRef): Promise<void>;

  /**
   * Restricts the file so that `readOnlyUser` can view but not edit it —
   * used by scenarios that verify the editor's read-only/view mode.
   */
  restrictToReadOnly(file: FileRef): Promise<void>;

  /**
   * Creates a legacy-format file (odt/ods/odp) and converts it to the matching OOXML type
   * through the plugin's own "Convert" integration (Document Server's Convert API) — not by
   * opening it in the editor — and returns the resulting docx/xlsx/pptx file. The caller is
   * responsible for deleting the returned file (same as createFile).
   */
  convertLegacyFile(page: Page, sourceType: LegacyFileType): Promise<FileRef>;
}
