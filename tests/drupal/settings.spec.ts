import { expect, test } from './fixtures';

const SETTINGS_PATH = '/admin/config/system/onlyoffice-settings';

test('the settings page is closed to a user without the permission', async ({ drupal, pageAs }) => {
  const page = await pageAs(drupal.readOnlyUser);

  expect((await page.goto(SETTINGS_PATH))?.status()).toBe(403);
});

/**
 * Only values the form must reject: the stand's settings are shared by every scenario running in
 * parallel, so a value that got saved would break them.
 */
test('invalid connection settings are rejected and the saved ones are kept', async ({ page }) => {
  await page.goto(SETTINGS_PATH);
  const address = page.locator('input[name="doc_server_url"]');
  const secret = page.locator('input[name="doc_server_jwt"]');
  const savedAddress = await address.inputValue();
  const savedSecret = await secret.inputValue();

  await address.fill('http://docs.example.com/?query=1');
  await page.locator('#edit-submit').click();
  await expect(page.getByText('The address must not contain a query or a fragment.').first()).toBeVisible();

  await page.goto(SETTINGS_PATH);
  await secret.fill('short');
  await page.locator('#edit-submit').click();
  await expect(page.getByText(/The secret key must be at least \d+ characters long\./).first()).toBeVisible();

  await page.goto(SETTINGS_PATH);
  await expect(address).toHaveValue(savedAddress);
  await expect(secret).toHaveValue(savedSecret);
});
