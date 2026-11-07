import { expect, test } from 'bun:test'
import { loadSettings } from '../src/settings.ts'

test('the defaults: version dev, the 45 s lock wait, no internal test routes', () => {
  expect(loadSettings({ DATABASE_URL: 'postgres://x', PORT: '7793' })).toEqual({
    databaseUrl: 'postgres://x',
    port: 7793,
    version: 'dev',
    lockWaitMs: 45_000,
    internalTestRoutes: false,
  })
  expect(loadSettings({ DATABASE_URL: 'x', PORT: '1', FACTORY_INTERNAL_TEST_ROUTES: '1' }).internalTestRoutes).toBe(
    true,
  )
  expect(() => loadSettings({ DATABASE_URL: 'x', PORT: '1', FACTORY_INTERNAL_TEST_ROUTES: 'yes' })).toThrow(
    /FACTORY_INTERNAL_TEST_ROUTES/,
  )
})

test('a bad or missing key refuses the start, naming the key', () => {
  expect(() => loadSettings({ PORT: '70000' })).toThrow(/DATABASE_URL.*PORT/)
})
