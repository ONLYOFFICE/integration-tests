import { expect, test } from '../fixtures';

test('a user who can edit gets the editor in edit mode with a callback', async ({ createFile, openEditor }) => {
  const editor = await openEditor(await createFile('docx'));
  const config = await editor.config();

  expect(config.editorConfig.mode ?? 'edit').toBe('edit');
  expect(config.document.permissions?.edit ?? true).toBe(true);
  expect(config.editorConfig.callbackUrl).toBeTruthy();
});

test('a user without edit rights gets the editor in view mode', async ({ adapter, createFile, openEditorAs }) => {
  const file = await createFile('docx');
  await adapter.restrictToReadOnly(file);
  const editor = await openEditorAs(adapter.readOnlyUser, file);
  const config = await editor.config();

  // Either one keeps the user from changing the document: Docs opens the file read-only when the
  // mode is view, and offers no switch to editing when the edit permission is off.
  expect(config.editorConfig.mode === 'view' || config.document.permissions?.edit === false).toBe(true);
});
