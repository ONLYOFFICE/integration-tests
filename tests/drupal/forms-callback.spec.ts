import { convertWithDocumentServer, signedCallbackBody, waitForEditorConfig } from '@core';
import { APIRequestContext } from '@playwright/test';
import type { DrupalMedia } from '@adapters/drupal';
import { expect, test } from './fixtures';
import { listSubmissions, waitForSubmissions } from './forms';

/**
 * The form callback Document Server calls when a visitor submits a form (status 6 with
 * forcesavetype 3), called here directly, as Document Server does. Its URL is taken from the form
 * on its page, and the submitted file is a real one: the form as Document Server's conversion
 * service returns it.
 */

let callbackUrl: string;
let fileUrl: string;
let form: DrupalMedia;

test.beforeEach(async ({ createForm, createFormPage, drupal, pageAs }) => {
  form = await createForm();
  const node = await createFormPage(form);
  const page = await pageAs(drupal.defaultUser);
  await page.goto(`/node/${node.nid}`);
  const config = await waitForEditorConfig(page);
  callbackUrl = config.editorConfig.callbackUrl as string;
  fileUrl = await convertWithDocumentServer(config.document.url, 'pdf');
});

/** Posts a callback request: an object is signed as Document Server signs it, a string goes as it is */
async function callback(request: APIRequestContext, body: Record<string, unknown> | string) {
  const response = await request.post(callbackUrl, {
    headers: { 'Content-Type': 'application/json' },
    data: typeof body === 'string' ? body : signedCallbackBody(body),
  });
  return {
    status: response.status(),
    json: await response.json().catch(() => null),
  };
}

test('a submission is saved for the user Document Server names', async ({ drupal, page }) => {
  const userId = await drupal.api.userId(drupal.secondUser.username);
  const answer = await callback(page.request, {
    key: 'autotest',
    status: 6,
    forcesavetype: 3,
    url: fileUrl,
    actions: [{ type: 0, userid: userId }],
  });

  expect(answer).toEqual({ status: 200, json: { error: 0 } });
  const [submission] = await waitForSubmissions(page, form, 1);
  expect(submission.submitter).toBe(drupal.secondUser.username);
});

test('other force saves of a form being filled in are not submissions', async ({ page }) => {
  for (const forcesavetype of [0, 1, 2, undefined]) {
    const answer = await callback(page.request, {
      key: 'autotest',
      status: 6,
      forcesavetype,
      url: fileUrl,
    });
    expect(answer, `forcesavetype ${forcesavetype}`).toEqual({
      status: 200,
      json: { error: 0 },
    });
  }
  expect(await listSubmissions(page, form)).toEqual([]);
});

test('editing, closing and not found statuses are answered without saving', async ({ page }) => {
  for (const status of [1, 2, 3, 4]) {
    const answer = await callback(page.request, {
      key: 'autotest',
      status,
      url: fileUrl,
    });
    expect(answer, `status ${status}`).toEqual({
      status: 200,
      json: { error: 0 },
    });
  }
  expect(await listSubmissions(page, form)).toEqual([]);
});

test('an unknown status is refused', async ({ page }) => {
  expect((await callback(page.request, { key: 'autotest', status: 42 })).status).toBe(400);
});

test('a submission without a file URL, or with one Drupal cannot download, is refused', async ({ page }) => {
  expect(
    (
      await callback(page.request, {
        key: 'autotest',
        status: 6,
        forcesavetype: 3,
      })
    ).status,
  ).toBe(400);
  const unreachable = {
    key: 'autotest',
    status: 6,
    forcesavetype: 3,
    url: `${new URL(fileUrl).origin}/missing.pdf`,
  };
  expect((await callback(page.request, unreachable)).status).toBe(400);
  expect(await listSubmissions(page, form)).toEqual([]);
});

test('a request without a valid token is refused', async ({ page }) => {
  const body = { key: 'autotest', status: 6, forcesavetype: 3, url: fileUrl };
  expect((await callback(page.request, JSON.stringify(body))).status).toBe(401);
  expect((await callback(page.request, JSON.stringify({ ...body, token: 'not.a.token' }))).status).toBe(401);
  expect((await callback(page.request, signedCallbackBody(body, 'a-foreign-secret-of-32-characters'))).status).toBe(
    401,
  );
  expect(await listSubmissions(page, form)).toEqual([]);
});

test('a request with a broken link key or without a body is refused', async ({ page }) => {
  const broken = await page.request.post(callbackUrl.replace(/[^/]+$/, 'garbage'), {
    headers: { 'Content-Type': 'application/json' },
    data: signedCallbackBody({ key: 'autotest', status: 4 }),
  });
  expect(broken.status()).toBe(400);
  expect((await callback(page.request, '')).status).toBe(400);
  expect((await page.request.get(callbackUrl)).status()).toBe(405);
});
