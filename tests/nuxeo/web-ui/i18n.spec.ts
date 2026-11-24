import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { NuxeoWebUi, UI_PATH } from '../web-ui';

/**
 * The package's messages, as installed into Web UI: its deployment fragment appends them to Web
 * UI's own messages-<language>.json, and Web UI shows the bare key for a message missing from the
 * file of the browser's language (it falls back to English only for a language it has no file for).
 */

/** The translations the package ships */
const PACKAGE_LANGUAGES = ['ar', 'cs', 'de', 'es', 'es-ES', 'eu', 'fr', 'he', 'id', 'it', 'ja', 'nl', 'pl', 'pt-PT', 'sv-SE', 'zh-CN'];
/** Languages Web UI 2025 has a file of its own for, which the package ships no translation for */
const WEB_UI_ONLY_LANGUAGES = ['fr-CA', 'fr-FR', 'pt', 'sv'];

/** Every error code the settings checks and the conversion report, as the pages turn them into message keys */
const ERROR_KEYS = [
  ...[
    'unknown',
    'timeout',
    'conversion',
    'downloading',
    'password',
    'database',
    'input',
    'token',
    'connection',
    'download_result',
    'ooxml_output_type',
    'size_limit_exceeded',
  ].map((code) => `onlyoffice.service.convert.error.${code}`),
  ...['no', 'key', 'callback_url', 'internal_server', 'forcesave', 'command', 'token', 'connection'].map(
    (code) => `onlyoffice.service.command.error.${code}`,
  ),
];

async function messages(page: Page, language?: string): Promise<Record<string, string>> {
  const response = await page.request.get(`${UI_PATH}i18n/messages${language ? `-${language}` : ''}.json`);
  expect(response.ok(), `messages of ${language ?? 'en'}`).toBe(true);
  return (await response.json()) as Record<string, string>;
}

function packageKeys(all: Record<string, string>): string[] {
  return Object.keys(all).filter((key) => key.includes('onlyoffice'));
}

/** The package's keys each language misses, by language — only the languages missing any */
async function missingKeys(page: Page, languages: string[]): Promise<Record<string, string[]>> {
  const expected = packageKeys(await messages(page));
  const missing: Record<string, string[]> = {};
  for (const language of languages) {
    const translated = await messages(page, language);
    const absent = expected.filter((key) => !(key in translated));
    if (absent.length) {
      missing[language] = absent;
    }
  }
  return missing;
}

test('every error the services report has a message', async ({ page }) => {
  const english = await messages(page);

  expect(ERROR_KEYS.filter((key) => !(key in english))).toEqual([]);
});

// Review 3.2 (Basque not installed) and 5.4 (a misnamed key in Dutch)
test('every translation of the package is installed with every message', async ({ page }) => {
  expect(await missingKeys(page, PACKAGE_LANGUAGES)).toEqual({});
});

// Found along with these tests: a browser in one of these languages shows message keys
test('the languages Web UI has and the package does not translate still get its messages', async ({ page }) => {
  test.fail();
  expect(await missingKeys(page, WEB_UI_ONLY_LANGUAGES)).toEqual({});
});

// Review 5.4: the Basque prefix lost its "$", so the details of a failed check went missing
test('the messages of failed checks keep the place for the details in every language', async ({ page }) => {
  const prefixes = ['onlyoffice.service.convert.check.error-prefix', 'onlyoffice.service.command.check.error-prefix'];
  const broken: string[] = [];
  for (const language of [undefined, ...PACKAGE_LANGUAGES]) {
    const translated = await messages(page, language);
    for (const key of prefixes) {
      if (key in translated && !translated[key].includes('$')) {
        broken.push(`${language ?? 'en'}: ${key}`);
      }
    }
  }

  expect(broken).toEqual([]);
});

test('Web UI in Basque shows the package in Basque', async ({ createFile, nuxeo, page, pageAs }) => {
  const file = await createFile('docx');
  const basque = await messages(page, 'eu');
  const webUi = new NuxeoWebUi(await pageAs(nuxeo.defaultUser, { locale: 'eu' }));

  await webUi.openDocument(file.id);

  await expect(webUi.editorActionLabel).toHaveText(basque['label.onlyoffice.edit']);
});
