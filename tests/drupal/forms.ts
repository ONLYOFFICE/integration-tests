import { expect, Page } from '@playwright/test';
import type { DrupalMedia } from '@adapters/drupal';

export const FORMS_PATH = '/admin/content/onlyoffice-form';
export const SUBMISSIONS_PATH = `${FORMS_PATH}/submissions`;

export function submissionsPath(form: { mid: number }): string {
  return `${SUBMISSIONS_PATH}/${form.mid}`;
}

export function submissionPath(submission: { id: number }, operation: 'view' | 'download' | 'delete'): string {
  return `${FORMS_PATH}/submission/${submission.id}/${operation}`;
}

export interface Submission {
  id: number;
  /** The file name without its extension */
  title: string;
  submitter: string;
}

/** The submissions of `form`, newest first, as its submissions tab lists them for a forms administrator */
export async function listSubmissions(page: Page, form: { mid: number }): Promise<Submission[]> {
  await page.goto(submissionsPath(form));
  const rows = page.locator('table.onlyoffice-form-submissions tbody tr:has(a[href$="/view"])');
  const submissions: Submission[] = [];
  for (const row of await rows.all()) {
    const link = row.locator('td').first().locator('a');
    const id = Number((await link.getAttribute('href'))?.match(/submission\/(\d+)\/view/)?.[1]);
    const submitter = (await row.locator('td').nth(4).innerText()).trim();
    submissions.push({ id, title: (await link.innerText()).trim(), submitter });
  }
  return submissions;
}

/** Waits until `form` has `count` submissions and returns them, newest first */
export async function waitForSubmissions(page: Page, form: { mid: number }, count: number): Promise<Submission[]> {
  let submissions: Submission[] = [];
  await expect
    .poll(async () => (submissions = await listSubmissions(page, form)).length, { timeout: 60_000 })
    .toBe(count);
  return submissions;
}

/**
 * Presses "Complete & Submit" in the form embedded in the page — Document Server then force saves
 * the filled form to the module's form callback.
 */
export async function submitForm(page: Page): Promise<void> {
  // Tall enough to show the whole form without scrolling: scrolled down, the theme's sticky header
  // keeps shifting the page, and the click never finds the button stable.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page
    .frameLocator('iframe[name="frameEditor"]')
    .getByRole('button', { name: 'Complete & Submit' })
    .click({ timeout: 90_000 });
}

/**
 * Where the submission's file lies: the module writes it next to the form, under
 * onlyoffice_forms/submissions/<form UUID>/, named after its title.
 */
export function submissionFileUrl(form: DrupalMedia, submission: Submission, scheme: 'public' | 'private'): string {
  const root = scheme === 'public' ? '/sites/default/files' : '/system/files';
  return `${root}/onlyoffice_forms/submissions/${form.uuid}/${submission.title}.pdf`;
}
