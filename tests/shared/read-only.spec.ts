import { extractText } from '@core';
import { expect, test } from '../fixtures';

test('a user without edit rights can view the file but not modify it', async ({
  adapter,
  createFile,
  openEditorAs,
}) => {
  const file = await createFile('docx');
  await adapter.restrictToReadOnly(file);
  const before = await extractText('docx', await adapter.downloadFile(file));

  // Capitalized: the editor's autocorrect capitalizes the start of a sentence
  const marker = `Autotest-RO-${Date.now()}`;
  const editor = await openEditorAs(adapter.readOnlyUser, file);
  await expect(editor.frame.locator('#toolbar')).toBeVisible();
  await editor.typeText(marker);
  await editor.save();
  await editor.page.close();

  // Unlike the save scenarios, there's no "it eventually contains the marker" to poll for here —
  // a read-only session never opens for editing, so nothing will ever arrive. A grace period
  // is the only way to catch a plugin/permission regression that let the edit through anyway.
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  await expect(extractText('docx', await adapter.downloadFile(file))).resolves.toBe(before);
});
