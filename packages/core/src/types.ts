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
  /** Selector for the editor iframe on the host system page */
  readonly editorFrameSelector?: string;

  /** UI login; the result is cached by fixtures via storageState */
  login(page: Page, user: TestUser): Promise<void>;

  /** Creates a file via the host system's REST API (not via UI) */
  createFile(name: string, type: FileType): Promise<FileRef>;

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
}
