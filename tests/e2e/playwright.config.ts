import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * Run as `bunx --bun playwright test -c tests/e2e/playwright.config.ts` (`make e2e`). The global setup boots the server and
 * seeds it; the tests reach it through `E2E_CONSOLE_URL` (see fixtures.ts). `*.e2e.ts` keeps `bun test ./tests` away.
 */
export default defineConfig({
  testDir: import.meta.dir,
  testMatch: '**/*.e2e.ts',
  outputDir: join(import.meta.dir, 'out', 'results'),
  globalSetup: './global-setup.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
