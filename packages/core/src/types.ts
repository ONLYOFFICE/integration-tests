import type { Page } from '@playwright/test';

export type FileType = 'docx' | 'xlsx' | 'pptx';

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
}
