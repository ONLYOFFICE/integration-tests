import { extractText, FileType, LegacyFileType } from '@core';
import { expect, test } from '../fixtures';

const CONVERSIONS: { source: LegacyFileType; target: FileType }[] = [
  { source: 'odt', target: 'docx' },
  { source: 'ods', target: 'xlsx' },
  { source: 'odp', target: 'pptx' },
];

for (const { source, target } of CONVERSIONS) {
  const title = `the plugin converts a legacy file to ${target}${target === 'docx' ? ' @smoke' : ''}`;

  test(title, async ({ adapter, convertLegacyFile }) => {
    const file = await convertLegacyFile(source);

    // resources/files/convert/convert.<source> all contain this text — it should survive
    // the round trip through Document Server's Convert API
    await expect
      .poll(async () => extractText(target, await adapter.downloadFile(file)), {
        timeout: 120_000,
        intervals: [2_000],
      })
      .toContain('Hello world');
  });
}
