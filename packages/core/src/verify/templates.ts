import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileType } from '../types';

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'files', 'blank');

/** Loads the static blank template for the given type (resources/files/blank/blank.<type>) */
export function loadTemplate(type: FileType): Buffer {
  return fs.readFileSync(path.join(TEMPLATES_DIR, `blank.${type}`));
}
