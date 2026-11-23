import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const serverRoot = join(here, '..');
export const dataDir = process.env.YARD_DATA_DIR || join(serverRoot, 'data');
export const samplesDir = join(serverRoot, 'samples');
export const webDist = join(serverRoot, '..', 'web', 'dist');
