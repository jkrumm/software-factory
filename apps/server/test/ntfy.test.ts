import { describe, expect, test } from 'bun:test'
import { loadOwnersLine } from '../src/adapters/ntfy/ntfy.ts'
import { deepLink } from '../src/domains/checkpoints/page.ts'

describe("the owner's line", () => {
  test('the checkpoint link defaults to the Console listener on its port, which serves the page at its root', () => {
    const { consoleUrl } = loadOwnersLine({})
    expect(consoleUrl).toBe('http://127.0.0.1:7795')
    expect(deepLink(consoleUrl, 'errand_1')).toBe('http://127.0.0.1:7795/checkpoints/errand_1')
  })

  test('the default follows FACTORY_CONSOLE_PORT', () => {
    expect(loadOwnersLine({ FACTORY_CONSOLE_PORT: '8080' }).consoleUrl).toBe('http://127.0.0.1:8080')
  })

  test('FACTORY_CONSOLE_URL overrides the default', () => {
    expect(
      loadOwnersLine({ FACTORY_CONSOLE_PORT: '8080', FACTORY_CONSOLE_URL: 'https://factory.example.com' }).consoleUrl,
    ).toBe('https://factory.example.com')
  })
})
