import { FileType } from '../types';
import { extractDocxText } from './docx';
import { extractPptxText } from './pptx';
import { extractXlsxText } from './xlsx';

/** Extracts visible text from a file, dispatching by its type */
export function extractText(type: FileType, content: Buffer): Promise<string> {
  switch (type) {
    case 'docx':
      return extractDocxText(content);
    case 'xlsx':
      return extractXlsxText(content);
    case 'pptx':
      return extractPptxText(content);
  }
}
