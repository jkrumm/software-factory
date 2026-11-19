// The library face (src/read.ts): the status as a value, the mode override a caller sets and clears, the wall reset, and the KPI
// "quota used at reset" over the reset ledger.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountPaths,
  type ResetEntry,
  clearModeOverride,
  liveAccounts,
  loadRegistry,
  quotaUsedAtReset,
  quotaUsedAtResetIn,
  readQuotaAtResetIn,
  readStatus,
  setModeOverride,
  wallResetAt,
} from '../src/index.ts'

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)
const H = 3600_000
const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function fixture(): AccountPaths {
  const dir = mkdtempSync(join(tmpdir(), 'read-'))
  dirs.push(dir)
  const paths = {
    registry: join(dir, 'registry.json'),
    cacheDir: join(dir, 'cache'),
    modes: join(dir, 'modes.json'),
    history: join(dir, 'history'),
  }
  mkdirSync(paths.cacheDir, { recursive: true })
  mkdirSync(paths.history, { recursive: true })
  const accounts = {
    iu: { dir: null, plan: 'max5x', homeLanes: ['interactive'], enabled: false },
    a: { dir: join(dir, 'a'), plan: 'max20x', homeLanes: ['bulk'], enabled: true },
    b: { dir: join(dir, 'b'), plan: 'max5x', homeLanes: ['bulk'], enabled: true },
  }
  writeFileSync(paths.registry, JSON.stringify({ version: 2, accounts, fable: null, drain: null }))
  for (const id of ['a', 'b']) {
    writeFileSync(
      join(paths.cacheDir, `${id}.sample.json`),
      JSON.stringify({
        s: 10,
        s_reset: (NOW + 2 * H) / 1000,
        s_ts: NOW - 60_000,
        w: 30,
        w_reset: (NOW + 96 * H) / 1000,
        w_ts: NOW - 60_000,
        src: 'statusline',
      }),
    )
  }
  return paths
}

describe('readStatus', () => {
  test('is the status of every account of the registry, with or without the history', () => {
    const paths = fixture()
    const full = readStatus({ nowMs: NOW, paths, machine: 'mini' })
    expect(full.machine).toBe('mini')
    expect(full.accounts.map((a) => a.id).sort()).toEqual(['a', 'b', 'iu'])
    expect(full.accounts.find((a) => a.id === 'a')?.lanes.bulk).toMatchObject({ open: true })
    expect(full.accounts.find((a) => a.id === 'iu')?.lanes.bulk).toMatchObject({ open: false, closed: 'disabled' })
    const light = readStatus({ nowMs: NOW, paths, history: false, machine: 'mini' })
    expect(light.accounts.find((a) => a.id === 'a')?.resets).toEqual([])
  })
})

describe('a mode override from a caller', () => {
  test('is the one claude-account reads, and a clear restores the registry mode', () => {
    const paths = fixture()
    const record = setModeOverride(
      'a',
      { kind: 'paused', until: new Date(NOW + 24 * H).toISOString(), why: 'x' },
      { nowMs: NOW, paths, machine: 'mini' },
    )
    expect(record).toMatchObject({ kind: 'paused', set_on: 'mini', set_at: NOW })
    const views = liveAccounts(loadRegistry(paths.registry), NOW, paths).views
    expect(views.a?.mode.kind).toBe('paused')
    expect(
      readStatus({ nowMs: NOW, paths, history: false }).accounts.find((x) => x.id === 'a')?.lanes.bulk,
    ).toMatchObject({
      open: false,
      closed: 'paused',
    })
    clearModeOverride('a', { nowMs: NOW + 1000, paths, machine: 'mini' })
    expect(liveAccounts(loadRegistry(paths.registry), NOW + 1000, paths).views.a?.source).toBe('registry')
  })

  test('refuses what the CLI refuses, in the CLI words', () => {
    const paths = fixture()
    const set = (id: string, req: Parameters<typeof setModeOverride>[1]) => () =>
      setModeOverride(id, req, { nowMs: NOW, paths, machine: 'mini' })
    expect(set('nope', { kind: 'paused' })).toThrow("unknown account 'nope'")
    expect(set('a', { kind: 'sleep' })).toThrow('<mode> must be one of')
    expect(set('a', { kind: 'reserve' })).toThrow('reserve needs --for')
    expect(set('a', { kind: 'paused', for: 'fable' })).toThrow('--for belongs to reserve only')
    expect(set('a', { kind: 'paused', until: 'tomorrow' })).toThrow('must be reset or an ISO time')
    expect(set('a', { kind: 'paused', until: new Date(NOW - H).toISOString() })).toThrow('already past')
  })

  test('drain without an end lasts to the weekly reset', () => {
    const paths = fixture()
    const record = setModeOverride('a', { kind: 'drain' }, { nowMs: NOW, paths, machine: 'mini' })
    expect(record).toMatchObject({ kind: 'drain', until: 'reset', baseline_w_reset: (NOW + 96 * H) / 1000 })
  })
})

describe('wallResetAt', () => {
  const limits = (s: number | null, w: number | null, sIn = 2, wIn = 96) => [
    ...(s === null ? [] : [{ kind: 'session', percent: s, resets_at: new Date(NOW + sIn * H).toISOString() }]),
    ...(w === null ? [] : [{ kind: 'weekly_all', percent: w, resets_at: new Date(NOW + wIn * H).toISOString() }]),
  ]
  const row = (s: number | null, w: number | null, kind: 'normal' | 'drain' = 'normal', sIn?: number, wIn?: number) =>
    ({ limits: limits(s, w, sIn, wIn), mode: { kind } }) as Parameters<typeof wallResetAt>[0]

  test('is the reset of the window nearest its ceiling when within ten points of it', () => {
    expect(wallResetAt(row(85, 40), NOW)).toBe(NOW + 2 * H) // 5 h: ceiling 90
    expect(wallResetAt(row(20, 90), NOW)).toBe(NOW + 96 * H) // week: ceiling 95
    expect(wallResetAt(row(null, 88), NOW)).toBe(NOW + 96 * H)
  })

  test('is null for a throttle far from any window, a reset that is past, and no sample', () => {
    expect(wallResetAt(row(50, 60), NOW)).toBeNull()
    expect(wallResetAt(row(88, 40, 'normal', -1), NOW)).toBeNull()
    expect(wallResetAt(row(null, null), NOW)).toBeNull()
  })

  test("follows the rule's ceilings: a drain account's week runs to 100", () => {
    expect(wallResetAt(row(20, 90), NOW)).toBe(NOW + 96 * H) // normal: 5 points left of 95
    expect(wallResetAt(row(20, 85, 'drain'), NOW)).toBeNull() // drain: 15 left of 100
    expect(wallResetAt(row(20, 92, 'drain'), NOW)).toBe(NOW + 96 * H)
  })
})

describe('quota used at reset', () => {
  const entry = (id: string, atH: number, weekly: number | null): ResetEntry => ({
    v: 1,
    id,
    key: `${id}-${atH}`,
    at: NOW - atH * H,
    reset_at: null,
    weekly,
    scoped: null,
    modes: [],
    rule: null,
    closed_hours: 0,
    manual: false,
  })

  test('is the capacity-weighted mean of the weekly percent at each reset in the span', () => {
    const entries = [entry('big', 10, 100), entry('small', 20, 50), entry('small', 24 * 30, 0)]
    const found = quotaUsedAtResetIn({ entries, weeklyUnits: { big: 3, small: 1 }, from: NOW - 7 * 24 * H, to: NOW })
    expect(found).toEqual({ percent: (3 * 100 + 1 * 50) / 4, resets: 2 })
  })

  test('leaves out a reset with no weekly percent and an account with no capacity; none is no figure', () => {
    const entries = [entry('a', 5, null), entry('ghost', 5, 90)]
    expect(quotaUsedAtResetIn({ entries, weeklyUnits: { a: 1 }, from: NOW - 24 * H, to: NOW })).toEqual({
      percent: null,
      resets: 0,
    })
  })

  test('per week: the last block ends at now, the oldest comes first', () => {
    const entries = [entry('a', 24, 80), entry('a', 24 * 9, 40)]
    const weeks = quotaUsedAtReset({ entries, weeklyUnits: { a: 1 }, nowMs: NOW, weeks: 2 })
    expect(weeks.map((w) => w.percent)).toEqual([40, 80])
    expect(weeks[1]?.to).toBe(NOW)
  })

  test('reads the ledger of the history directory and the capacity of the registry', () => {
    const paths = fixture()
    const lines = [entry('a', 10, 90), entry('b', 10, 60)].map((e) => JSON.stringify(e)).join('\n')
    writeFileSync(join(paths.history as string, 'resets.jsonl'), `${lines}\n`)
    const found = readQuotaAtResetIn({ from: NOW - 7 * 24 * H, to: NOW, paths })
    // max20x weighs more than max5x
    expect(found.resets).toBe(2)
    expect(found.percent).toBeGreaterThan(75)
    expect(found.percent).toBeLessThan(90)
  })
})
