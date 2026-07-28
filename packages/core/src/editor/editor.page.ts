import { expect, FrameLocator, Page } from '@playwright/test';

/** iframe that Document Server's api.js creates inside the host system page */
const DEFAULT_FRAME_SELECTOR = 'iframe[name="frameEditor"]';

/**
 * Wrapper around the ONLYOFFICE editor. The toolbar and panels are regular DOM
 * inside the iframe, while the document area is a canvas: input is keyboard-only,
 * and results are verified by downloading the file and parsing its content.
 */
export class EditorPage {
  private constructor(
    readonly page: Page,
    readonly frame: FrameLocator,
  ) {}

  static async attach(page: Page, frameSelector: string = DEFAULT_FRAME_SELECTOR): Promise<EditorPage> {
    const editor = new EditorPage(page, page.frameLocator(frameSelector));
    await editor.waitUntilLoaded();
    return editor;
  }

  async waitUntilLoaded(): Promise<void> {
    await expect(this.frame.locator('#toolbar')).toBeVisible({ timeout: 90_000 });
    await expect(this.frame.locator('.asc-loadmask')).toHaveCount(0, { timeout: 90_000 });
  }

  async typeText(text: string): Promise<void> {
    await this.frame.locator('#editor_sdk').click();
    await this.page.keyboard.type(text, { delay: 30 });
  }

  async save(): Promise<void> {
    await this.page.keyboard.press('Control+s');
  }
}
