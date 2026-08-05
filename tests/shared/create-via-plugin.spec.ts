import { EditorPage, extractText, FileType } from '@core';
import { expect, test } from '../fixtures';

const FILE_TYPES: FileType[] = ['docx', 'xlsx', 'pptx'];

for (const type of FILE_TYPES) {
  const title = `the plugin's own "create new document" flow produces an editable file (${type})${type === 'docx' ? ' @smoke' : ''}`;

  test(title, async ({ adapter, createFileViaPlugin, page }) => {
    const file = await createFileViaPlugin(type);
    const editor = await EditorPage.attach(page, adapter.editorFrameSelector);
    await expect(editor.frame.locator('#toolbar')).toBeVisible();

    // Capitalized: the editor's autocorrect capitalizes the start of a sentence
    const marker = `Autotest-${Date.now()}`;
    await editor.typeText(marker);
    await editor.save();
    // Closing the tab ends the editing session —
    // Document Server sends a callback, and the plugin saves the file
    await page.close();

    await expect
      .poll(async () => extractText(type, await adapter.downloadFile(file)), {
        timeout: 120_000,
        intervals: [2_000],
      })
      .toContain(marker);
  });
}
