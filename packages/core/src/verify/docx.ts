import JSZip from 'jszip';

/** Extracts visible text from a .docx (content of all <w:t> elements) */
export async function extractDocxText(content: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(content);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) {
    throw new Error('word/document.xml not found — the file is not a docx');
  }
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
}
