import { defineConfig } from 'vitest/config';

// Unit + integration tests (Node). The Electron end-to-end suite lives in
// test/e2e and runs under Playwright, not Vitest. See TESTING.md.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', '**/node_modules/**'],
    setupFiles: ['test/helpers/setup.ts'],
    // openscad-wasm instantiates a ~13 MB module per render; give the
    // integration tests room on slow CI runners.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
