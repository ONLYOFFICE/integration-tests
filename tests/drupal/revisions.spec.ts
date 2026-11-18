import { extractText } from '@core';
import { expect, test } from './fixtures';

test('saving writes a new file and a new revision and keeps the previous file', async ({
  createFile,
  drupal,
  openEditor,
  page,
}) => {
  const file = await createFile('docx');
  const before = await drupal.api.getMedia(file.id);
  // Capitalized: the editor's autocorrect capitalizes the start of a sentence
  const marker = `Autotest-${Date.now()}`;

  const editor = await openEditor(file);
  await editor.typeText(marker);
  await editor.save();
  await page.close();

  await expect
    .poll(async () => (await drupal.api.getMedia(file.id)).fileId, { timeout: 120_000, intervals: [2_000] })
    .not.toBe(before.fileId);

  const after = await drupal.api.getMedia(file.id);
  expect(await drupal.api.fileExists(before.fileId!), 'the previous file').toBe(true);
  expect(after.revisionUser).toBe(drupal.defaultUser.username);
  expect(await extractText('docx', await drupal.downloadFile(file))).toContain(marker);
});

test('in a shared session the revision goes to the user who changed the document, not to the last to leave', async ({
  createFile,
  drupal,
  openEditor,
  openEditorAs,
  page,
}) => {
  const file = await createFile('docx');
  const before = await drupal.api.getMedia(file.id);
  const marker = `Autotest-${Date.now()}`;

  const watcher = await openEditor(file);
  const author = await openEditorAs(drupal.secondUser, file);
  await author.typeText(marker);
  await author.save();
  await author.page.close();
  // The admin made no changes; Document Server sends the save once the last user leaves
  await watcher.page.waitForTimeout(3_000);
  await page.close();

  await expect
    .poll(async () => (await drupal.api.getMedia(file.id)).fileId, { timeout: 120_000, intervals: [2_000] })
    .not.toBe(before.fileId);
  expect((await drupal.api.getMedia(file.id)).revisionUser).toBe(drupal.secondUser.username);
});
