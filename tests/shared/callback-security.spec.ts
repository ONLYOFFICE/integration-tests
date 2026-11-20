import { extractText, signedCallbackBody } from '@core';
import { expect, test } from '../fixtures';

/** Docs API callback answer: anything but HTTP 2xx with {"error": 0} is a refusal */
async function accepted(response: Response): Promise<boolean> {
  if (!response.ok) {
    return false;
  }
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return Number(body.error) === 0;
}

test('the callback refuses requests not signed by Document Server', async ({ adapter, createFile, openEditor }) => {
  const file = await createFile('docx');
  const editor = await openEditor(file);
  const config = await editor.config();
  const callbackUrl = config.editorConfig.callbackUrl;
  expect(callbackUrl).toBeTruthy();
  const before = await extractText('docx', await adapter.downloadFile(file));

  // A save request that would replace the file with itself — had it been accepted, the host would
  // at least try to save; the content check below catches a host that saves anyway.
  const save = {
    key: config.document.key,
    status: 2,
    url: config.document.url,
    users: [config.editorConfig.user?.id],
  };
  const post = (body: string) =>
    fetch(callbackUrl!, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  expect(await accepted(await post(JSON.stringify(save))), 'without a JWT').toBe(false);
  expect(
    await accepted(await post(signedCallbackBody(save, 'not-the-document-server-secret-0123456789'))),
    'with a JWT signed by another secret',
  ).toBe(false);
  // Status 4 (closed with no changes) changes nothing — it shows the callback does accept
  // Document Server's own signature, so the refusals above aren't just a broken endpoint.
  expect(
    await accepted(await post(signedCallbackBody({ key: config.document.key, status: 4 }))),
    'status 4 with the JWT of Document Server',
  ).toBe(true);

  await expect(extractText('docx', await adapter.downloadFile(file))).resolves.toBe(before);
});
