import { loadConvertTemplate } from '@core';
import { expect, test, uniqueName } from '../fixtures';
import { NuxeoWebUi, operationString } from '../web-ui';

/** The "Convert using ONLYOFFICE" action on a file of a document's page (onlyoffice-convert-button) */

const CONVERT_OPERATION = '**/automation/ONLYOFFICE.Convert';

async function startConversion(webUi: NuxeoWebUi): Promise<void> {
  await webUi.convertAction.click();
  await webUi.convertDialog.locator('paper-button.primary').click();
}

test('convert is offered for a format the package converts, not for one it edits', async ({
  createDocument,
  createFile,
  webUi,
}) => {
  const docx = await createFile('docx');
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));

  await webUi.openDocument(odt.uid);
  await expect(webUi.convertAction).toBeVisible();

  await webUi.openDocument(docx.id);
  await expect(webUi.editorAction).toBeVisible();
  await expect(webUi.convertAction).toHaveCount(0);
});

// Review 3.1: the conversion always replaces the main file, whichever file's action was used
test('convert is offered for the main file only, not for attachments', async ({ createDocument, nuxeo, webUi }) => {
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));
  await nuxeo.api.attachFile(odt.uid, 'attachment.odt', loadConvertTemplate('odt'));

  await webUi.openDocument(odt.uid);
  await expect(webUi.convertAction).toBeVisible();
  await expect(webUi.page.locator('nuxeo-document-attachments onlyoffice-convert-button')).toHaveCount(1);
  await expect(webUi.attachmentConvertActions).toHaveCount(0);
});

test('converting replaces the file with the converted one and says so', async ({ createDocument, nuxeo, webUi }) => {
  const name = uniqueName();
  const odt = await createDocument(`${name}.odt`, loadConvertTemplate('odt'));
  await webUi.openDocument(odt.uid);

  await webUi.convertAction.click();
  await expect(webUi.convertDialog.locator('.info')).toHaveText(`Convert ${name}.odt to ${name}.docx`);
  await webUi.convertDialog.locator('paper-button.primary').click();

  await expect.poll(() => webUi.notifications(), { timeout: 90_000 }).toContainEqual(
    expect.stringMatching(/was successfully converted$/),
  );
  expect(await webUi.isConvertDialogOpen()).toBe(false);
  const document = await nuxeo.api.getDocument(odt.uid);
  expect(document.fileName).toBe(`${name}.docx`);
  expect(document.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('an error of the conversion service is shown with its description', async ({ createDocument, page, webUi }) => {
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));
  await page.route(CONVERT_OPERATION, (route) => route.fulfill(operationString({ error: 'SIZE_LIMIT_EXCEEDED' })));
  await webUi.openDocument(odt.uid);

  await startConversion(webUi);

  await expect
    .poll(() => webUi.notifications())
    .toEqual(['Failed to convert document, Document Conversion Service returned error (The file is too large to be converted)']);
  expect(await webUi.isConvertDialogOpen()).toBe(false);
});

test('a failed request is reported as an undefined error', async ({ createDocument, page, webUi }) => {
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));
  await page.route(CONVERT_OPERATION, (route) => route.fulfill({ status: 500, body: '{}' }));
  await webUi.openDocument(odt.uid);

  await startConversion(webUi);

  await expect.poll(() => webUi.notifications()).toEqual(['Failed to convert document (Undefined error)']);
  expect(await webUi.isConvertDialogOpen()).toBe(false);
});

// Review 3.4: the dialog closed with Esc keeps polling and opens itself again once it ends
test('closing the dialog with Esc while converting stops the conversion', async ({ createDocument, page, webUi }) => {
  test.fail();
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));
  await page.route(CONVERT_OPERATION, (route) => route.fulfill(operationString({ endConvert: false, percent: 10 })));
  const sent = webUi.recordConvertRequests();
  await webUi.openDocument(odt.uid);

  await startConversion(webUi);
  await expect.poll(() => sent.count).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => webUi.isConvertDialogOpen()).toBe(false);
  const sentBeforeClosing = sent.count;
  await page.waitForTimeout(3_000);

  expect(sent.count, 'requests after the dialog was closed').toBeLessThanOrEqual(sentBeforeClosing + 1);
});

// Review 3.4: Convert → Cancel → Convert while the first request is out. Starting the operation
// again aborts that request, whose failure handler then reports an error and stops the new
// conversion too; were the request answered instead, both polling chains would go on at once.
test('converting again right after cancelling goes on as one conversion', async ({ createDocument, page, webUi }) => {
  test.fail();
  const odt = await createDocument(uniqueName('odt'), loadConvertTemplate('odt'));
  await page.route(CONVERT_OPERATION, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    // The page may have aborted the request meanwhile
    await route.fulfill(operationString({ endConvert: false, percent: 10 })).catch(() => {});
  });
  const sent = webUi.recordConvertRequests();
  await webUi.openDocument(odt.uid);

  await startConversion(webUi);
  await expect.poll(() => sent.count).toBe(1);
  await webUi.convertDialog.locator('paper-button.secondary').click();
  await startConversion(webUi);
  const restartedWith = sent.count;
  await page.waitForTimeout(8_000);

  expect(await webUi.notifications(), 'messages').toEqual([]);
  expect(await webUi.isConvertDialogOpen(), 'the dialog of the conversion is open').toBe(true);
  expect(sent.count, 'the conversion keeps asking').toBeGreaterThan(restartedWith + 1);
});
