import { join } from 'node:path'
import { patient } from '../scenarios/patience.ts'
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
  // stretched by the host's load when the run starts (Issue 719): a screenshot that takes 3 s idle took 35 s at load 40
  timeout: patient(30_000),
  expect: { timeout: patient(10_000) },
  // `factory slot run` sets FACTORY_JUNIT_DIR and posts what is left there as the run's test results.
  reporter: process.env.FACTORY_JUNIT_DIR
    ? [['list'], ['junit', { outputFile: `${process.env.FACTORY_JUNIT_DIR}/e2e.xml` }]]
    : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1800, height: 1200 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
