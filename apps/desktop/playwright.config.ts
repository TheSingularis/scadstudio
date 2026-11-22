import { defineConfig } from '@playwright/test';

// End-to-end tests drive the *built* Electron app (out/), so run
// `npm run build` first (npm run test:e2e does both). On Linux without a
// display, wrap in `xvfb-run -a`. See TESTING.md.
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  // One Electron instance at a time: each test launches its own app, and
  // WASM renders are CPU-heavy enough that parallel apps skew timings.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results/e2e',
  use: {
    screenshot: 'only-on-failure',
    trace: 'off',
  },
});
