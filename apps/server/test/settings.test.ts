import { describe, expect, test } from 'bun:test'
import * as z from 'zod'
import { loadLoopSettings } from '../src/app/loops/settings.ts'
import { planningSettings } from '../src/app/planning-settings.ts'
import { parseEnv } from '../src/kernel/env.ts'
import { loadSettings } from '../src/settings.ts'

const base = { FACTORY_TOKEN: 'owner-token-0123456789', DATABASE_URL: 'x', PORT: '1' }

test('the defaults: version dev, the 45 s lock wait, no clock offset', () => {
  expect(loadSettings({ ...base, DATABASE_URL: 'postgres://x', PORT: '7793' })).toMatchObject({
    databaseUrl: 'postgres://x',
    port: 7793,
    version: 'dev',
    lockWaitMs: 45_000,
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
        FACTORY_ORCHESTRATOR_TOKEN: 'orchestrator-token-0123456789',
        FACTORY_READ_TOKEN: 'read-token-0123456789',
      }).tokens,
    ).toEqual({
      owner: 'owner-token-0123456789',
      agent: 'agent-token-0123456789',
      machine: 'door-token-0123456789',
      signal: 'signal-token-0123456789',
      orchestrator: 'orchestrator-token-0123456789',
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
    expect(() => loadSettings({ ...base, FACTORY_ORCHESTRATOR_TOKEN: base.FACTORY_TOKEN })).toThrow(
      /FACTORY_TOKEN and FACTORY_ORCHESTRATOR_TOKEN/,
    )
    expect(() => loadSettings({ ...base, FACTORY_AGENT_TOKEN: same, FACTORY_DOOR_TOKEN: same })).toThrow(
      /FACTORY_AGENT_TOKEN and FACTORY_DOOR_TOKEN/,
    )
  })
})

describe('parseEnv', () => {
  test('returns the parsed values, and names every bad key in one message', () => {
    const schema = z.object({ A: z.coerce.number().int(), B: z.string().min(2).optional() })
    expect(parseEnv(schema, { A: '3' })).toEqual({ A: 3 })
    expect(() => parseEnv(schema, { A: 'x', B: '1' })).toThrow(/^A: .*; B: /)
  })
})

describe('the loops intervals', () => {
  const every = (env: Record<string, string>) => loadLoopSettings(env).intervalMs
  test('a loop with no setting runs on the tick, a swept one never faster than its floor, a fixed one on its own cadence', () => {
    expect(every({ FACTORY_TICK_MS: '2000' })).toMatchObject({
      leads: 2000,
      friction: 2000,
      hygiene: 15 * 60_000,
      screen: 10 * 60_000,
      selfwatch: 5 * 60_000,
      host: 60_000,
      reaper: 5 * 60_000,
      desk: 15 * 60_000,
    })
    expect(every({ FACTORY_TICK_MS: '20000000' })).toMatchObject({ hygiene: 20_000_000, screen: 20_000_000 })
  })

  test('a tick of 0 turns every loop off, and a loop with its own setting keeps it', () => {
    expect(Object.values(every({ FACTORY_TICK_MS: '0' })).every((interval) => interval === 0)).toBe(true)
    expect(every({ FACTORY_TICK_MS: '0', FACTORY_LOOP_LEADS_MS: '50' }).leads).toBe(50)
    expect(every({ FACTORY_LOOP_HYGIENE_MS: '10' }).hygiene).toBe(10)
  })
})

test('the host tools default to the system ones, and a scenario points them elsewhere', () => {
  expect(planningSettings({}, { cores: 8 })).toMatchObject({
    psBin: '/bin/ps',
    lsofBin: '/usr/sbin/lsof',
    vmVolume: '/System/Volumes/VM',
  })
  expect(planningSettings({ FACTORY_PS_BIN: '/x/ps' }, { cores: 8 }).psBin).toBe('/x/ps')
})
