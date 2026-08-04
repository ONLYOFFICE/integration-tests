import { extractText, FileType } from '@core';
import { expect, test } from '../fixtures';

const FILE_TYPES: FileType[] = ['docx', 'xlsx', 'pptx'];

for (const type of FILE_TYPES) {
  // Only docx is tagged @smoke — it exercises the same save path as xlsx/pptx,
  // so the smoke suite doesn't need all three to catch a broken integration.
  const title = `typed text is saved to the host system (${type})${type === 'docx' ? ' @smoke' : ''}`;

  test(title, async ({ adapter, createFile, openEditor, page }) => {
    const file = await createFile(type);
    // Capitalized: the editor's autocorrect capitalizes the start of a sentence
    const marker = `Autotest-${Date.now()}`;

    const editor = await openEditor(file);
    await editor.typeText(marker);
    await editor.save();
    // Closing the tab ends the editing session —
    // Document Server sends a callback, and the plugin saves the file
    // The modified date is unreliable (it changes on open already due to the lock aspect),
    // so we wait for the text to appear in the file content itself.
    await page.close();

    await expect
      .poll(async () => extractText(type, await adapter.downloadFile(file)), {
        timeout: 120_000,
        intervals: [2_000],
      })
      .toContain(marker);
  });
}
