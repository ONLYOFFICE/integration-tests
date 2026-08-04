import { FileType } from '@core';
import { expect, test } from '../fixtures';

const FILE_TYPES: FileType[] = ['docx', 'xlsx', 'pptx'];

for (const type of FILE_TYPES) {
  const title = `file opens in the ONLYOFFICE editor (${type})${type === 'docx' ? ' @smoke' : ''}`;

  test(title, async ({ createFile, openEditor }) => {
    const file = await createFile(type);
    const editor = await openEditor(file);
    await expect(editor.frame.locator('#toolbar')).toBeVisible();
  });
}
