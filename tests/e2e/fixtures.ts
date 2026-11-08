import { test as base } from '@playwright/test'

export { expect } from '@playwright/test'

function fromEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set: the global setup starts the server`)
  return value
}

/**
 * `baseURL` is the app as the owner reaches it (the listener behind a login-adding proxy); `consoleUrl` is the listener itself, where
 * a request without a login arrives as it is; `apiUrl` is the main port, where the tests read the truth and file new things.
 */
export const test = base.extend<{ apiUrl: string; consoleUrl: string }>({
  baseURL: async ({}, use) => use(fromEnv('E2E_APP_URL')),
  consoleUrl: async ({}, use) => use(fromEnv('E2E_CONSOLE_URL')),
  apiUrl: async ({}, use) => use(fromEnv('E2E_API_URL')),
})
