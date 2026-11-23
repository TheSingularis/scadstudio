import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));

export const DESKTOP_DIR = resolve(here, '../..');
export const REPO_ROOT = resolve(DESKTOP_DIR, '../..');
export const PUBLIC_DIR = resolve(DESKTOP_DIR, 'src/renderer/public');
export const FIXTURES_DIR = resolve(DESKTOP_DIR, 'test/fixtures');
export const SPIKE_FIXTURES_DIR = resolve(REPO_ROOT, 'spikes/fixtures');
