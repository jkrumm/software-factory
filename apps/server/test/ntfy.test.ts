import { describe, expect, test } from 'bun:test'
import { loadOwnersLine } from '../src/adapters/ntfy/ntfy.ts'
import { loadConsoleSettings } from '../src/console-settings.ts'
import { deepLink } from '../src/domains/checkpoints/page.ts'

describe("the owner's line", () => {
  test('the checkpoint link defaults to the Console listener on its own port, which serves the page at its root', () => {
    const { consoleUrl } = loadOwnersLine({})
    expect(new URL(consoleUrl).port).toBe(String(loadConsoleSettings({}).port))
    expect(deepLink(consoleUrl, 'errand_1')).toBe(`${consoleUrl}/checkpoints/errand_1`)
  })

  test('FACTORY_CONSOLE_URL overrides the default', () => {
    expect(loadOwnersLine({ FACTORY_CONSOLE_URL: 'https://factory.example.com' }).consoleUrl).toBe(
      'https://factory.example.com',
    )
  })
})
