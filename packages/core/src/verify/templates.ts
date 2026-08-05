import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileType, LegacyFileType } from '../types';

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'files', 'blank');
const CONVERT_TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'files', 'convert');

/** Loads the static blank template for the given type (resources/files/blank/blank.<type>) */
export function loadTemplate(type: FileType): Buffer {
  return fs.readFileSync(path.join(TEMPLATES_DIR, `blank.${type}`));
}

/** Loads the static legacy-format template used by convert scenarios (resources/files/convert/convert.<type>) */
export function loadConvertTemplate(type: LegacyFileType): Buffer {
  return fs.readFileSync(path.join(CONVERT_TEMPLATES_DIR, `convert.${type}`));
}
