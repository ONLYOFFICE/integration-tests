import { extractDocxText } from '@core';
import { expect, test } from '../fixtures';

test('typed text is saved to the host system @smoke', async ({ adapter, createFile, openEditor, page }) => {
  const file = await createFile('docx');
  const marker = `autotest-${Date.now()}`;
  const baseline = await adapter.getModifiedAt(file);

  const editor = await openEditor(file);
  await editor.typeText(marker);
  await editor.save();
  // Closing the tab ends the editing session —
  // Document Server sends a callback, and the plugin saves the file
  await page.close();

  await adapter.waitForSave(file, baseline);
  const text = await extractDocxText(await adapter.downloadFile(file));
  expect(text).toContain(marker);
});
