import JSZip from 'jszip';

/**
 * Extracts visible text from a .xlsx: cell text ends up either in xl/sharedStrings.xml
 * (referenced by index) or inline in the worksheet itself (t="inlineStr") — both use
 * the same <t> tag, so collecting it across both sources covers either case.
 */
export async function extractXlsxText(content: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(content);
  const partNames = Object.keys(zip.files).filter(
    (name) => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  );
  const parts = await Promise.all(partNames.map((name) => zip.file(name)!.async('string')));
  return parts.map((xml) => [...xml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join('')).join('');
}
