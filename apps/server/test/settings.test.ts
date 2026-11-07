import { describe, expect, test } from 'bun:test'
import { loadSettings } from '../src/settings.ts'

const base = { FACTORY_TOKEN: 'owner-token-0123456789', DATABASE_URL: 'x', PORT: '1' }

test('the defaults: version dev, the 45 s lock wait, the 30 s shutdown deadline, no clock offset', () => {
  expect(loadSettings({ ...base, DATABASE_URL: 'postgres://x', PORT: '7793' })).toMatchObject({
    databaseUrl: 'postgres://x',
    port: 7793,
    version: 'dev',
    lockWaitMs: 45_000,
    shutdownDeadlineMs: 30_000,
    clockOffsetMs: 0,
  })
})

describe('the test clock', () => {
  test('is honored only together with FACTORY_TEST_MODE=1', () => {
    expect(loadSettings({ ...base, FACTORY_TEST_MODE: '1', FACTORY_TEST_CLOCK_OFFSET_MS: '5000' }).clockOffsetMs).toBe(
      5000,
    )
  })

  test('an offset without the mode refuses the start, naming both keys', () => {
    for (const mode of [{}, { FACTORY_TEST_MODE: '0' }]) {
      expect(() => loadSettings({ ...base, ...mode, FACTORY_TEST_CLOCK_OFFSET_MS: '5000' })).toThrow(
        /FACTORY_TEST_CLOCK_OFFSET_MS.*FACTORY_TEST_MODE=1/,
      )
    }
  })
})

test('a bad or missing key refuses the start, naming the key', () => {
  expect(() => loadSettings({ PORT: '70000' })).toThrow(/FACTORY_TOKEN.*DATABASE_URL.*PORT/)
})

describe('the tokens', () => {
  test('the owner token is required and every token is at least 16 characters', () => {
    expect(() => loadSettings({ DATABASE_URL: 'x', PORT: '1' })).toThrow(/FACTORY_TOKEN/)
    expect(() => loadSettings({ ...base, FACTORY_READ_TOKEN: 'short' })).toThrow(/FACTORY_READ_TOKEN.*16/)
  })

  test('an absent token means that caller does not exist', () => {
    expect(loadSettings(base).tokens).toEqual({ owner: 'owner-token-0123456789' })
    expect(
      loadSettings({
        ...base,
        FACTORY_AGENT_TOKEN: 'agent-token-0123456789',
        FACTORY_DOOR_TOKEN: 'door-token-0123456789',
        FACTORY_SIGNAL_TOKEN: 'signal-token-0123456789',
        FACTORY_READ_TOKEN: 'read-token-0123456789',
      }).tokens,
    ).toEqual({
      owner: 'owner-token-0123456789',
      agent: 'agent-token-0123456789',
      machine: 'door-token-0123456789',
      signal: 'signal-token-0123456789',
      read: 'read-token-0123456789',
    })
  })

  test('two callers sharing a token refuse the start, naming both keys', () => {
    expect(() => loadSettings({ ...base, FACTORY_READ_TOKEN: base.FACTORY_TOKEN })).toThrow(
      /FACTORY_TOKEN and FACTORY_READ_TOKEN/,
    )
    const same = 'shared-token-0123456789'
    expect(() => loadSettings({ ...base, FACTORY_SIGNAL_TOKEN: base.FACTORY_TOKEN })).toThrow(
      /FACTORY_TOKEN and FACTORY_SIGNAL_TOKEN/,
    )
    expect(() => loadSettings({ ...base, FACTORY_AGENT_TOKEN: same, FACTORY_DOOR_TOKEN: same })).toThrow(
      /FACTORY_AGENT_TOKEN and FACTORY_DOOR_TOKEN/,
    )
  })
})
