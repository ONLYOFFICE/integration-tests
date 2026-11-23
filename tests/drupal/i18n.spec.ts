import { CAPTURE_EDITOR_CONFIG, loadTemplate, waitForEditorConfig } from '@core';
import { editorPath, expect, test, uniqueName } from './fixtures';

/**
 * The module's own Russian translation, which tests/setup/drupal.ts imports from its .po file;
 * Russian pages live under the /ru prefix.
 */

test('the media overview offers the operations in Russian', async ({ createMedia, page }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));

  await page.goto('/ru/admin/content/media');
  await expect(page.locator(`a[href^="/ru${editorPath(media)}"]`)).toHaveText('Редактировать в ONLYOFFICE');
});

test('the settings page is in Russian', async ({ page }) => {
  await page.goto('/ru/admin/config/system/onlyoffice-settings');

  await expect(page.locator('h1')).toHaveText('Настройки коннектора ONLYOFFICE');
  await expect(page.getByText('Настройки подключения', { exact: true })).toBeVisible();
});

test('the editor opens in Russian', async ({ createMedia, page }) => {
  const media = await createMedia(uniqueName('docx'), loadTemplate('docx'));
  await page.addInitScript(CAPTURE_EDITOR_CONFIG);
  await page.goto(`/ru${editorPath(media)}`);

  expect((await waitForEditorConfig(page)).editorConfig.lang).toBe('ru');
});
