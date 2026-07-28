import { expect, test } from '../fixtures';

test('file opens in the ONLYOFFICE editor @smoke', async ({ createFile, openEditor }) => {
  const file = await createFile('docx');
  const editor = await openEditor(file);
  await expect(editor.frame.locator('#toolbar')).toBeVisible();
});
