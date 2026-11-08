import { test as base } from '@playwright/test'

export { expect } from '@playwright/test'

function fromEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set: the global setup starts the server`)
  return value
}

/**
 * `baseURL` and `consoleUrl` are the Console listener itself (no header is needed: the perimeter is the tailnet ACL);
 * `apiUrl` is the main port, where the tests read the truth and file new things.
 */
export const test = base.extend<{ apiUrl: string; consoleUrl: string }>({
  baseURL: async ({}, use) => use(fromEnv('E2E_CONSOLE_URL')),
  consoleUrl: async ({}, use) => use(fromEnv('E2E_CONSOLE_URL')),
  apiUrl: async ({}, use) => use(fromEnv('E2E_API_URL')),
})
