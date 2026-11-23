// Runs before every Vitest test file.
//
// scadParser.ts loads its two .wasm files from `${import.meta.env.BASE_URL}`
// with fetch(), exactly as the renderer does under Electron. Pointing
// BASE_URL at the renderer's public/ folder and letting fetch() read local
// files means the tests exercise the app's real parser loader, not a copy.
import { readFile } from 'node:fs/promises';
import { vi } from 'vitest';
import { PUBLIC_DIR } from './paths';

vi.stubEnv('BASE_URL', `${PUBLIC_DIR}/`);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(PUBLIC_DIR)) return new Response(await readFile(url));
  return realFetch(input, init);
}) as typeof fetch;
