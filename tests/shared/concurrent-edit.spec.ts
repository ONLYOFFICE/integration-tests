import { extractText } from '@core';
import { expect, test } from '../fixtures';

test('two users editing the same file simultaneously are both saved to the host system', async ({
  adapter,
  createFile,
  openEditor,
  openEditorAs,
  page,
}) => {
  const file = await createFile('docx');
  // Capitalized: the editor's autocorrect capitalizes the start of a sentence
  const markerA = `Autotest-A-${Date.now()}`;
  const markerB = `Autotest-B-${Date.now()}`;

  const editorA = await openEditor(file);
  const editorB = await openEditorAs(adapter.secondUser, file);

  // Sequential, not literally simultaneous keystrokes — typing at the exact same instant risks
  // the two markers being interleaved character-by-character by the co-editing merge. Both
  // sessions stay open throughout, which is what actually exercises concurrent co-editing.
  await editorA.typeText(markerA);
  await editorB.typeText(markerB);

  await editorA.save();
  await editorB.save();
  // Closing the tabs ends both editing sessions —
  // Document Server sends a callback, and the plugin saves the file
  await page.close();
  await editorB.page.close();

  await expect
    .poll(
      async () => {
        const text = await extractText('docx', await adapter.downloadFile(file));
        return text.includes(markerA) && text.includes(markerB);
      },
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBe(true);
});
