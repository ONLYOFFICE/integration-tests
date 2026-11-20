import { errors, expect, FrameLocator, Page, test } from '@playwright/test';
import type { EditorConfig } from './editor-config';

/**
 * The config the page handed to Docs' api.js, without waiting for the editor to load — for pages
 * where it can't (e.g. while the host is set up with a JWT Document Server doesn't accept). The
 * page must carry CAPTURE_EDITOR_CONFIG, added before it loaded.
 */
export async function waitForEditorConfig(page: Page, timeoutMs = 30_000): Promise<EditorConfig> {
  const handle = await page
    .waitForFunction(() => (window as unknown as { __oitEditorConfig?: EditorConfig }).__oitEditorConfig, undefined, {
      timeout: timeoutMs,
    })
    .catch((error: unknown) => {
      if (!(error instanceof errors.TimeoutError)) {
        throw error;
      }
      throw new Error(
        `No editor config was recorded within ${timeoutMs / 1000}s — was CAPTURE_EDITOR_CONFIG added to the page ` +
          'before it loaded, and did the page create the editor?',
        { cause: error },
      );
    });
  return (await handle.jsonValue()) as EditorConfig;
}

/** iframe that Document Server's api.js creates inside the host system page */
const DEFAULT_FRAME_SELECTOR = 'iframe[name="frameEditor"]';

const STATE_SETTLE_MS = 1_000;

/** What CAPTURE_EDITOR_CONFIG keeps on the host page's window */
interface DocumentState {
  __oitCaptureInstalled?: boolean;
  __oitDocumentModified?: boolean;
  __oitDocumentModifiedCount?: number;
}

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
    if (!(await this.toolbarOrBroken())) {
      // Known bug of Docs 10.0: web-apps/apps/common/main/lib/component/ColorPaletteExt.js is a
      // module declared without dependencies (define([], …)) that extends Common.UI.BaseView right
      // away; when RequireJS runs it before BaseView.js, the editor never starts. The presentation
      // editor loads it, ~2 of 120 openings under load. Another load orders the modules anew.
      try {
        test.info().annotations.push({ type: 'known bug', description: 'Docs editor reloaded after the ColorPaletteExt.js module race' });
      } catch {}
      await this.page.reload();
      if (!(await this.toolbarOrBroken())) {
        throw new Error('The Docs editor broke on the ColorPaletteExt.js module race twice in a row');
      }
    }
    await expect(this.frame.locator('.asc-loadmask')).toHaveCount(0, { timeout: 90_000 });
  }

  /** True once the toolbar shows, false if the editor broke on the known module race (see above) */
  private async toolbarOrBroken(timeoutMs = 90_000): Promise<boolean> {
    const toolbar = this.frame.locator('#toolbar');
    let state = 'loading' as 'loading' | 'ready' | 'broken';
    // Two signals in different frames — the toolbar in Docs' iframe, the breakage on the host
    // page's window — so neither a locator assertion nor waitForFunction can wait for both
    await expect
      .poll(
        async () => {
          if (await toolbar.isVisible().catch(() => false)) {
            return (state = 'ready');
          }
          const broken = await this.page
            .evaluate(() => Boolean((window as unknown as { __oitEditorBroken?: string }).__oitEditorBroken))
            .catch(() => false);
          return (state = broken ? 'broken' : 'loading');
        },
        { message: 'The Docs editor toolbar did not show', timeout: timeoutMs },
      )
      .not.toBe('loading');
    return state === 'ready';
  }

  /**
   * The config the host system's page handed to Docs' api.js. Recorded by CAPTURE_EDITOR_CONFIG,
   * which the openEditor/openEditorAs fixtures install before the page loads.
   */
  async config(): Promise<EditorConfig> {
    // Already recorded by now, but the check runs in the renderer the just-loaded editor still keeps busy
    return waitForEditorConfig(this.page, 10_000);
  }

  /**
   * Types into the document and, in an editor that can edit, waits until it reports holding the
   * change — otherwise save() could see the state from before the typing and return at once.
   */
  async typeText(text: string, timeoutMs = 30_000): Promise<void> {
    await this.assertCaptureInstalled('typeText');
    const before = await this.page.evaluate(() => (window as unknown as DocumentState).__oitDocumentModifiedCount ?? 0);
    await this.frame.locator('#editor_sdk').click();
    await this.page.keyboard.type(text, { delay: 30 });
    if (!(await this.canEdit())) {
      return;
    }
    await this.page
      .waitForFunction(
        (count) => {
          const state = window as unknown as DocumentState;
          // Already true before the typing and still so: no new event comes, the change joins the pending ones
          return (state.__oitDocumentModifiedCount ?? 0) > count || state.__oitDocumentModified === true;
        },
        before,
        { timeout: timeoutMs },
      )
      .catch(() => {
        throw new Error(`The editor didn't report the typed change within ${timeoutMs / 1000}s`);
      });
  }

  /**
   * Saves and waits until Document Server has every change: the editor hands them over in a
   * round trip on its socket after Ctrl+S, and a page closed before it ends loses them — the
   * session then closes "without changes" and no save ever reaches the host. A viewer never
   * holds changes, so this returns at once there.
   */
  async save(timeoutMs = 60_000): Promise<void> {
    await this.assertCaptureInstalled('save');
    await this.page.keyboard.press('Control+s');
    const deadline = Date.now() + timeoutMs;
    // The state crosses from the editor's frame in messages; a false seen here may be an earlier
    // one with the true for the latest change still on its way, so it must hold for a while
    for (;;) {
      await this.page
        .waitForFunction(() => (window as unknown as DocumentState).__oitDocumentModified !== true, undefined, {
          timeout: Math.max(deadline - Date.now(), 1),
        })
        .catch(() => {
          throw new Error(`The editor still holds unsaved changes ${timeoutMs / 1000}s after Ctrl+S`);
        });
      await this.page.waitForTimeout(STATE_SETTLE_MS);
      if (!(await this.page.evaluate(() => (window as unknown as DocumentState).__oitDocumentModified === true))) {
        return;
      }
    }
  }

  private async canEdit(): Promise<boolean> {
    const config = await this.config();
    return config.editorConfig.mode !== 'view' && config.document.permissions?.edit !== false;
  }

  private async assertCaptureInstalled(method: string): Promise<void> {
    if (!(await this.page.evaluate(() => (window as unknown as DocumentState).__oitCaptureInstalled))) {
      throw new Error(`EditorPage.${method}() needs CAPTURE_EDITOR_CONFIG on the page, added before it loaded`);
    }
  }
}
