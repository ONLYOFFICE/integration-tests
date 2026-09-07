import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import type { MattermostAdapter } from '@adapters/mattermost';

const CHANNEL_URL = '/integration-tests/channels/integration-tests';

async function dismissOnboardingChecklist(page: Page): Promise<void> {
  const noThanks = page.getByText(/No thanks,? I.ll figure it out myself/i);
  const overlay = page.locator('[data-cy="onboarding-task-list-overlay"]');
  await Promise.race([
    noThanks.waitFor({ state: 'visible', timeout: 5_000 }),
    overlay.waitFor({ state: 'visible', timeout: 5_000 }),
  ]).catch(() => {});

  if (await noThanks.isVisible().catch(() => false)) {
    await noThanks.click();
    await overlay.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    return;
  }

  const toggle = page.locator('[data-cy="onboarding-task-list-action-button"]');
  for (let attempt = 0; attempt < 10 && (await overlay.count()) > 0; attempt++) {
    await toggle.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function openPermissionsModal(page: Page, fileId: string, fileName: string): Promise<void> {
  await page.getByText(fileName, { exact: true }).hover();
  await page.locator(`#file_action_button_${fileId}`).click({ force: true });
  await page.getByText('Change access rights', { exact: true }).click();
}

test('changing a file\'s default access rights makes the ONLYOFFICE bot reply on its post', async ({
  adapter,
  createFile,
  page,
}) => {
  const file = await createFile('docx');

  await page.goto(CHANNEL_URL);
  await dismissOnboardingChecklist(page);
  await openPermissionsModal(page, file.id, file.name);

  const modal = page.locator('#onlyoffice-permissions-modal');
  await expect(modal.getByText('Default access rights for chat members')).toBeVisible();
  await modal.locator('.onlyoffice-permissions__permission-select').click();
  await page.getByRole('option', { name: 'Edit', exact: true }).click();
  await modal.getByRole('button', { name: 'Save', exact: true }).click();

  await expect
    .poll(async () => (adapter as MattermostAdapter).getBotReply(file), { timeout: 30_000, intervals: [1_000] })
    .toBe(`${file.name} permissions have been changed to "edit"`);
});
