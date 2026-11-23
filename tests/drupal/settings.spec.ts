import { SETTINGS_PATH } from '@adapters/drupal';
import { expect, test } from './fixtures';

/**
 * The settings page without saving anything: the stand's settings are shared by every scenario
 * running in parallel. Scenarios that do change them are in tests/drupal-settings.
 */

test('the settings page is closed to a user without the permission', async ({ drupal, pageAs }) => {
  const page = await pageAs(drupal.readOnlyUser);

  expect((await page.goto(SETTINGS_PATH))?.status()).toBe(403);
});

test('invalid connection settings are rejected and the saved ones are kept', async ({ page }) => {
  await page.goto(SETTINGS_PATH);
  const address = page.locator('input[name="doc_server_url"]');
  const secret = page.locator('input[name="doc_server_jwt"]');
  const header = page.locator('input[name="doc_server_jwt_header"]');
  const savedAddress = await address.inputValue();
  const savedSecret = await secret.inputValue();
  const savedHeader = await header.inputValue();

  await address.fill('http://docs.example.com/?query=1');
  await page.locator('#edit-submit').click();
  await expect(page.getByText('The address must not contain a query or a fragment.').first()).toBeVisible();

  await page.goto(SETTINGS_PATH);
  await secret.fill('short');
  await page.locator('#edit-submit').click();
  await expect(page.getByText(/The secret key must be at least \d+ characters long\./).first()).toBeVisible();

  await page.goto(SETTINGS_PATH);
  await page.locator('details:has(input[name="doc_server_jwt_header"])').evaluate((details) => {
    (details as HTMLDetailsElement).open = true;
  });
  await header.fill('Bad Header');
  await page.locator('#edit-submit').click();
  await expect(page.getByText(/The header name may contain only letters, digits/).first()).toBeVisible();

  await page.goto(SETTINGS_PATH);
  await expect(address).toHaveValue(savedAddress);
  await expect(secret).toHaveValue(savedSecret);
  await expect(header).toHaveValue(savedHeader);
});

test('the secret can be shown and hidden again', async ({ page }) => {
  await page.goto(SETTINGS_PATH);
  const secret = page.locator('input[name="doc_server_jwt"]');
  const toggle = page.locator('.onlyoffice-secret__toggle');

  await expect(secret).toHaveAttribute('type', 'password');
  await toggle.click();
  await expect(secret).toHaveAttribute('type', 'text');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(secret).toHaveAttribute('type', 'password');
});

test('the cloud banner can be closed and stays closed', async ({ page }) => {
  await page.goto(SETTINGS_PATH);
  const banner = page.locator('[data-onlyoffice-banner]');

  await expect(banner).toBeVisible();
  await banner.locator('.onlyoffice-banner__close').click();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(banner).toBeHidden();
});

test('the status report has nothing to say about a long enough secret', async ({ page }) => {
  await page.goto('/admin/reports/status');

  await expect(page.locator('h1')).toBeVisible();
  await expect(page.getByText('ONLYOFFICE Docs secret key')).toHaveCount(0);
});
