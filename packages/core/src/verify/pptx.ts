import JSZip from 'jszip';

/** Extracts visible text from a .pptx (content of all <a:t> elements across all slides) */
export async function extractPptxText(content: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(content);
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const slides = await Promise.all(slideNames.map((name) => zip.file(name)!.async('string')));
  return slides.map((xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).join('');
}
