import { downloadHeaders } from '@core';
import { expect, test } from '../fixtures';

/** Whether the response actually hands out the file — a host may refuse with any status, or with a 200 error page */
async function servesFile(response: Response, file: Buffer): Promise<boolean> {
  return response.ok && Buffer.from(await response.arrayBuffer()).equals(file);
}

test('the file link handed to Document Server requires its JWT', async ({ adapter, createFile, openEditor }) => {
  const file = await createFile('docx');
  const editor = await openEditor(file);
  const { url } = (await editor.config()).document;
  const content = await adapter.downloadFile(file);

  expect(await servesFile(await fetch(url), content), 'without a JWT').toBe(false);
  expect(
    await servesFile(await fetch(url, { headers: downloadHeaders(url, 'not-the-document-server-secret-0123456789') }), content),
    'with a JWT signed by another secret',
  ).toBe(false);
  expect(await servesFile(await fetch(url, { headers: downloadHeaders(url) }), content), 'with the JWT of Document Server').toBe(
    true,
  );
});
