import { extractText } from '@core';
import { expect, test } from '../fixtures';

test('force save persists changes to the host system without closing the editing session', async ({
  adapter,
  createFile,
  openEditor,
}) => {
  const file = await createFile('docx');
  // Capitalized: the editor's autocorrect capitalizes the start of a sentence
  const marker = `Autotest-FS-${Date.now()}`;

  const editor = await openEditor(file);
  await editor.typeText(marker);
  // With Force Save enabled (see tests/setup/*.ts, per-system), this Ctrl+S makes Document
  // Server send a callback immediately — unlike the regular save path, the tab/session stays
  // open throughout.
  await editor.save();

  await expect
    .poll(async () => extractText('docx', await adapter.downloadFile(file)), {
      timeout: 120_000,
      intervals: [2_000],
    })
    .toContain(marker);
});
