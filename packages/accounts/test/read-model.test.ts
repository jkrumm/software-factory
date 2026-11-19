// The read model (docs/accounts.md §History and §status): the sample log and the reset ledger, the forecast, closure against
// rank, and `status --json` against its schema.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Account,
  type Cache,
  type Registry,
  type Sample,
  type SampleLine,
  CLOSED_CODES,
  defaultAccountId,
  FORECAST_METHOD,
  STATUS_SCHEMA,
  buildStatus,
  closure,
  emptyCache,
  forecastWeekly,
  importLines,
  readLedger,
  readSampleLines,
  rank,
  replayAccount,
  replayResets,
  resolveModes,
  saveSample,
  statusLanes,
  statusLine,
  weeklyCeiling,
  emptyOverrides,
} from '../src/index.ts'
import { validate } from './schema.ts'

const H = 3600
const HMS = H * 1000
const T0 = Date.UTC(2026, 10, 12, 18, 0, 0) // a Thursday 18:00 UTC: the week's start
const tmp = () => mkdtempSync(join(tmpdir(), 'read-model-'))
const L = (
  id: string,
  atH: number,
  w: number | null,
  wResetH: number | null,
  o: Partial<SampleLine> = {},
): SampleLine => ({
  v: 1,
  ts: T0 + atH * HMS,
  id,
  s: null,
  s_reset: null,
  w,
  w_reset: wResetH === null ? null : (T0 + wResetH * HMS) / 1000,
  scoped: null,
  src: 'statusline',
  mode: null,
  rule: 'v1.10',
  ...o,
})

describe('the reset ledger', () => {
  const R1 = 100 // the first reset, hours after T0
  const WEEK = 168
  const week = (id: string) => [
    L(id, 0, 10, R1),
    L(id, 20, 50, R1),
    L(id, 60, 97, R1),
    L(id, 101, 3, R1 + WEEK), // the first sample after the scheduled reset
    L(id, 130, 20, R1 + WEEK),
  ]

  test('a scheduled reset is one ledger line with the last percent before it and the hours closed at the ceiling', () => {
    const [r, ...more] = replayAccount('me2', week('me2')).resets
    expect(more).toEqual([])
    expect(r).toMatchObject({ id: 'me2', weekly: 97, reset_at: (T0 + R1 * HMS) / 1000, manual: false, rule: 'v1.10' })
    expect(r.at).toBe(T0 + R1 * HMS)
    expect(r.closed_hours).toBe(16) // 97 % stood at the 95 % ceiling from h60 to h76, when the ceiling rose to 98
  })

  test('a manual reset (the percent falls first, the reset time follows) is one line, marked manual', () => {
    const lines = [
      L('me', 0, 10, R1),
      L('me', 40, 90, R1, { mode: 'drain' }),
      L('me', 50, 2, R1),
      L('me', 51, 3, R1 + WEEK),
      L('me', 70, 12, R1 + WEEK),
    ]
    const { resets } = replayAccount('me', lines)
    expect(resets).toHaveLength(1)
    expect(resets[0]).toMatchObject({ weekly: 90, manual: true, modes: ['drain'] })
    expect(resets[0].at).toBe(T0 + 50 * HMS)
    expect(resets[0].closed_hours).toBe(0) // a drain's ceiling is 100
  })

  test('a reset time that moves by seconds, a repeated line and a shuffled order add no reset', () => {
    const jitter = week('me2').map((l, i) =>
      l.w_reset === null ? l : { ...l, w_reset: l.w_reset + (i % 2 ? 0.4 : -0.3) },
    )
    const noisy = [...jitter, ...week('me2'), ...week('me2')].sort(() => 0.5 - Math.random())
    expect(replayAccount('me2', noisy).resets).toHaveLength(1)
  })

  test('two accounts and two weeks give one line per account and week, oldest first', () => {
    const second = [
      L('me', 0, 10, R1),
      L('me', 99, 99, R1),
      L('me', 105, 1, R1 + WEEK),
      L('me', 260, 98, R1 + WEEK),
      L('me', 270, 0, R1 + 2 * WEEK),
    ]
    const all = replayResets([...week('me2'), ...second])
    expect(all.map((e) => [e.id, e.weekly])).toEqual([
      ['me2', 97],
      ['me', 99],
      ['me', 98],
    ])
    expect(new Set(all.map((e) => e.key)).size).toBe(3)
  })

  describe('through the files: saveSample writes the log and the ledger', () => {
    const sampleAt = (atH: number, w: number, wResetH: number, src = 'statusline'): Sample => ({
      s: null,
      s_reset: null,
      s_ts: null,
      w,
      w_reset: (T0 + wResetH * HMS) / 1000,
      w_ts: T0 + atH * HMS,
      src,
    })
    const feed = (dir: string, cache: string, steps: [number, number, number, string?][]) => {
      for (const [atH, w, wResetH, src] of steps)
        saveSample('me2', sampleAt(atH, w, wResetH, src), cache, false, T0 + atH * HMS, { dir, mode: () => 'drain' })
    }

    test('a replayed series gives exactly one ledger line per reset, a peer echo and a manual reset included', () => {
      const dir = tmp()
      const cache = tmp()
      feed(dir, cache, [
        [0, 10, R1],
        [0, 10, R1], // the same sample twice: no line
        [20, 50, R1],
        [20.5, 50, R1, 'peer'], // the peer's echo of the same numbers
        [60, 97, R1],
        [101, 3, R1 + WEEK],
        [101.2, 3, R1 + WEEK, 'peer'],
        [120, 30, R1 + WEEK],
        [150, 90, R1 + WEEK], // 90 % ...
        [160, 2, R1 + WEEK], // ... and a manual reset: the percent falls, the time stays
        [161, 4, R1 + 2 * WEEK], // the time follows a sample later
        [162, 4, R1 + 2 * WEEK, 'peer'],
      ])
      const ledger = readLedger(dir)
      expect(ledger.map((e) => [e.weekly, e.manual])).toEqual([
        [97, false],
        [90, true],
      ])
      expect(ledger[0].modes).toEqual(['drain'])
      const lines = readSampleLines(dir)
      expect(lines.map((l) => l.w)).toEqual([10, 50, 97, 3, 30, 90, 2, 4]) // changes only
      expect(readFileSync(join(dir, 'resets.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
    })

    test('the log rotates by month and the first write after the history was switched on still gets its reset', () => {
      const dir = tmp()
      const cache = tmp()
      const day = 24
      // the cache holds a state the log never saw: the reset writes it first
      saveSample('me2', sampleAt(0, 95, R1), cache, false, T0)
      saveSample('me2', sampleAt(R1 + 1, 2, R1 + WEEK), cache, false, T0 + (R1 + 1) * HMS, { dir })
      expect(readLedger(dir).map((e) => e.weekly)).toEqual([95])
      saveSample('me2', sampleAt(R1 + 40 * day, 5, R1 + 40 * day + 100), cache, false, T0 + (R1 + 40 * day) * HMS, {
        dir,
      })
      expect(
        readdirSync(dir)
          .filter((n) => n.startsWith('samples-'))
          .sort(),
      ).toEqual(['samples-2026-11.jsonl', 'samples-2026-12.jsonl'])
    })

    test('a record is never a gate: an unwritable history directory leaves the sample written', () => {
      const cache = tmp()
      const blocker = join(tmp(), 'file')
      writeFileSync(blocker, 'x')
      expect(() => saveSample('me2', sampleAt(0, 5, R1), cache, false, T0, { dir: join(blocker, 'sub') })).not.toThrow()
      expect(existsSync(join(cache, 'me2.sample.json'))).toBe(true)
    })
  })

  describe('the history import', () => {
    test('seeds the log and the ledger once, a second run adds nothing, a torn line is skipped', () => {
      const dir = tmp()
      const lines = week('me2')
      const a = importLines(dir, lines)
      expect(a).toMatchObject({ added: 5, duplicates: 0 })
      expect(a.resets).toHaveLength(1)
      const b = importLines(dir, [...lines, L('me2', 140, 25, R1 + WEEK)])
      expect(b).toMatchObject({ added: 1, duplicates: 5 })
      expect(readLedger(dir)).toHaveLength(1)
      writeFileSync(
        join(dir, 'samples-2026-11.jsonl'),
        `${readFileSync(join(dir, 'samples-2026-11.jsonl'), 'utf8')}{"ts": 17`,
      )
      expect(readSampleLines(dir)).toHaveLength(6)
    })
  })
})

describe('forecast (burn-rate-24h-v1)', () => {
  const NOW = T0 + 60 * HMS
  const at = (hoursAgo: number, w: number) => ({ ts: NOW - hoursAgo * HMS, w })
  const fc = (o: Partial<Parameters<typeof forecastWeekly>[0]> & { w: number }) =>
    forecastWeekly({ nowMs: NOW, wReset: (NOW + 50 * HMS) / 1000, weeklyUnits: 1, series: [], ...o })!

  test('steady burn: the last 24 h held to the reset', () => {
    const f = fc({ w: 40, series: [at(48, 5), at(26, 14), at(24, 16), at(10, 30), at(0, 40)] })
    expect(f).toMatchObject({
      method: FORECAST_METHOD,
      weekly_at_reset: 90,
      full_at: null,
      waste_percent: 10,
      waste_units: 0.1,
      burn_per_hour: 1,
    })
  })

  test('steady burn past 100: the time it gets full, capped at 100, nothing wasted', () => {
    const f = fc({ w: 60, series: [at(24, 12), at(0, 60)] })
    expect(f).toMatchObject({ weekly_at_reset: 100, waste_percent: 0, waste_units: 0 })
    expect(f.full_at).toBe(NOW + 20 * HMS)
  })

  test('no burn: the percent stays, the rest is waste', () => {
    expect(fc({ w: 70, series: [at(30, 70), at(0, 70)] })).toMatchObject({
      weekly_at_reset: 70,
      full_at: null,
      waste_percent: 30,
      burn_per_hour: 0,
    })
  })

  test('no history: flat, with no basis', () => {
    expect(fc({ w: 33 })).toMatchObject({ weekly_at_reset: 33, burn_per_hour: 0, basis_hours: 0 })
  })

  test('already full: 100 at the reset, the time it filled, no waste', () => {
    const f = fc({ w: 100, series: [at(30, 80), at(7, 100), at(0, 100)] })
    expect(f).toMatchObject({ weekly_at_reset: 100, waste_percent: 0 })
    expect(f.full_at).toBe(NOW - 7 * HMS)
  })

  test('a young window is never projected from a few minutes: the span is at least 3 h', () => {
    expect(fc({ w: 10, series: [at(0.1, 5), at(0, 10)] }).burn_per_hour).toBeCloseTo(5 / 3, 1)
  })

  test('waste counts in capacity units, so an Ultra weighs double a Max', () => {
    const series = [at(24, 20), at(0, 20)]
    expect(fc({ w: 20, series, weeklyUnits: 1 }).waste_units).toBe(0.8)
    expect(fc({ w: 20, series, weeklyUnits: 2 }).waste_units).toBe(1.6)
  })

  test('no weekly percent or a reset in the past: no forecast', () => {
    expect(forecastWeekly({ nowMs: NOW, w: null, wReset: (NOW + HMS) / 1000, weeklyUnits: 1, series: [] })).toBeNull()
    expect(forecastWeekly({ nowMs: NOW, w: 10, wReset: (NOW - HMS) / 1000, weeklyUnits: 1, series: [] })).toBeNull()
  })
})

// ── closure against rank, status against its schema ─────────────────────────────────────────────────────────────

const NOW = T0 + 50 * HMS
const acc = (dir: string | null, plan: string, homeLanes: string[], o: Partial<Account> = {}): Account => ({
  dir,
  plan,
  homeLanes,
  enabled: true,
  ...o,
})
const reg3 = (o: Partial<Registry> = {}): Registry => ({
  accounts: {
    iu: acc(null, 'ultra', ['interactive', 'headless']),
    me: acc('/home/x/.claude-me', 'max', ['bulk']),
    me2: acc('/home/x/.claude-me2', 'max', ['bulk']),
  },
  ...o,
})
const smp = (s: number | null, w: number, wResetH = 100, o: Partial<Sample> = {}): Sample => ({
  s,
  w,
  s_reset: s === null ? null : (NOW + 3 * HMS) / 1000,
  w_reset: (NOW + wResetH * HMS) / 1000,
  s_ts: s === null ? null : NOW - 60_000,
  w_ts: NOW - 60_000,
  src: 'statusline',
  ...o,
})
const fableLimits = (weekly: number, scoped: number, used: number, ageMs = 60_000): Partial<Sample> => ({
  limits: [
    { kind: 'weekly_all', percent: weekly, scope: null },
    { kind: 'weekly_scoped', percent: scoped, scope: { model: { display_name: 'Fable', id: null } } },
  ],
  scoped_shares: [{ limit_index: 1, used_percent_of_weekly: used, allowance_percent_of_weekly: 50 }],
  limits_ts: NOW - ageMs,
})
const cacheOf = (samples: Record<string, Sample>, o: Partial<Cache> = {}): Cache => ({ ...emptyCache(), samples, ...o })
const status = (reg: Registry, cache: Cache, history = {}) =>
  buildStatus({
    reg,
    cache,
    views: resolveModes(reg, emptyOverrides(), cache, NOW),
    history,
    nowMs: NOW,
    machine: 'mini',
  })

describe('closure', () => {
  const closedOf = (reg: Registry, cache: Cache, id = 'me2') => closure(reg, cache, id, NOW)

  test('names the reason and when it opens, check by check', () => {
    const ok = { iu: smp(null, 10), me: smp(10, 10) }
    expect(closedOf(reg3(), cacheOf({ ...ok, me2: smp(10, 10) }))).toBeNull()
    expect(
      closedOf(
        reg3({ accounts: { ...reg3().accounts, me2: acc('/x', 'max', ['bulk'], { enabled: false }) } }),
        cacheOf(ok),
      ),
    ).toMatchObject({ closed: 'disabled' })
    expect(closedOf(reg3(), cacheOf({ ...ok, me2: smp(10, 10) }, { auth_failed: { me2: true } }))).toMatchObject({
      closed: 'auth',
    })
    expect(closedOf(reg3(), cacheOf(ok))).toMatchObject({ closed: 'no-sample' })
    expect(
      closedOf(
        reg3({ accounts: { ...reg3().accounts, me2: acc('/x', 'max', ['bulk'], { mode: { kind: 'paused' } }) } }),
        cacheOf({ ...ok, me2: smp(10, 10) }),
      ),
    ).toMatchObject({ closed: 'paused' })
    const s = closedOf(reg3(), cacheOf({ ...ok, me2: smp(91, 10) }))
    expect(s).toMatchObject({ closed: 'session-max', opens_at: NOW + 3 * HMS })
    const w = closedOf(reg3(), cacheOf({ ...ok, me2: smp(10, 96, 100) }))
    expect(w).toMatchObject({ closed: 'weekly-ceiling', opens_at: NOW + 100 * HMS - 24 * HMS * 1 }) // the ceiling rises to 98 in the last 24 h
    expect(
      closedOf(reg3(), cacheOf({ ...ok, me2: smp(10, 10) }, { exhausted: { me2: (NOW + 2 * HMS) / 1000 } })),
    ).toMatchObject({ closed: 'exhausted', opens_at: NOW + 2 * HMS })
  })

  test('a reserve account whose unused allowance fills the ceiling is closed until the allowance is released', () => {
    const reg = reg3({
      accounts: {
        ...reg3().accounts,
        me2: acc('/x', 'max', ['bulk'], { mode: { kind: 'reserve', for: 'fable', hold: 'allowance' } }),
      },
    })
    const cache = cacheOf({ iu: smp(null, 10), me: smp(10, 10), me2: smp(10, 60, 100, fableLimits(60, 2, 1)) })
    expect(closure(reg, cache, 'me2', NOW)).toMatchObject({ closed: 'reserve-budget' }) // 60 + 49 unused ≥ 95
    expect(closure(reg, cache, 'me2', NOW)!.opens_at).toBe(NOW + 76 * HMS) // released 24 h before the reset
  })

  test('closure is null exactly for the accounts rank lists, over random registries of 1 to 8 accounts', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32
    const pickOf = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(rnd() * 8)
      const accounts: Record<string, Account> = {}
      const samples: Record<string, Sample> = {}
      const cache = emptyCache()
      for (let i = 0; i < n; i++) {
        const id = `a${i}`
        const mode = pickOf([
          undefined,
          undefined,
          { kind: 'drain' as const },
          { kind: 'paused' as const },
          { kind: 'reserve' as const, for: 'fable' },
        ])
        accounts[id] = acc(
          i === 0 ? null : `/x/${id}`,
          pickOf(['max', 'ultra']),
          pickOf([['interactive', 'headless'], ['bulk'], ['bulk', 'headless']]),
          {
            enabled: rnd() > 0.1,
            ...(mode ? { mode } : {}),
          },
        )
        if (rnd() > 0.15) {
          const age = rnd() > 0.2 ? rnd() * 5 * HMS : 7 * HMS
          const w = Math.round(rnd() * 100)
          samples[id] = smp(accounts[id].plan === 'ultra' ? null : Math.round(rnd() * 100), w, rnd() * 170 - 5, {
            s_ts: NOW - age,
            w_ts: NOW - age,
            ...(rnd() > 0.4 ? fableLimits(w, Math.round(rnd() * 100), Math.round(rnd() * 50), rnd() * 8 * HMS) : {}),
          })
        }
        if (rnd() > 0.9) cache.auth_failed[id] = true
        if (rnd() > 0.9) cache.exhausted[id] = (NOW + rnd() * 5 * HMS) / 1000
      }
      cache.samples = samples
      const reg: Registry = { accounts }
      for (const lane of statusLanes(reg)) {
        const listed = new Set(rank({ reg, cache, lane, nowMs: NOW }).map((e) => e.account))
        const open = Object.keys(accounts).filter((id) => closure(reg, cache, id, NOW) === null)
        // one quirk of the rule, kept as it was: with nobody left the interactive lane lands on the default account, which rank
        // lists as <model>-reserve when that account is a reserve, whatever its sample says
        const fallback = lane === 'interactive' && listed.has(defaultAccountId(reg)) ? [defaultAccountId(reg)] : []
        expect([...listed].sort()).toEqual([...new Set([...open, ...fallback])].sort())
      }
    }
  })
})

describe('status', () => {
  const reg = reg3({ drain: ['me2'] })
  const cache = cacheOf({ iu: smp(null, 30), me: smp(40, 20), me2: smp(10, 92, 100) }, {})
  const hist = {
    me2: {
      week: [
        { ts: NOW - 30 * HMS, w: 60, w_reset: null, scoped: null, mode: 'drain', rule: 'v1.10' },
        { ts: NOW - 20 * HMS, w: 80, w_reset: null, scoped: null, mode: 'drain', rule: 'v1.10' },
        { ts: NOW - 1 * HMS, w: 92, w_reset: null, scoped: null, mode: 'drain', rule: 'v1.10' },
      ],
      resets: [
        {
          v: 1 as const,
          id: 'me2',
          key: 'me2:1',
          at: NOW - 100 * HMS,
          reset_at: null,
          weekly: 99,
          scoped: 12,
          modes: ['drain'],
          rule: 'v1.10',
          closed_hours: 3.5,
          manual: false,
        },
      ],
    },
  }

  test('validates against its schema and gives every lane the order rank gives', () => {
    const s = status(reg, cache, hist)
    expect(validate(s, STATUS_SCHEMA as never)).toEqual([])
    expect(s.lanes).toEqual(['interactive', 'bulk', 'headless', 'other'])
    for (const lane of s.lanes) {
      const fromStatus = s.accounts
        .filter((a) => a.lanes[lane].open)
        .sort((a, b) => a.lanes[lane].position! - b.lanes[lane].position!)
        .map((a) => [a.id, a.lanes[lane].reason])
      expect(fromStatus).toEqual(rank({ reg, cache, lane, nowMs: NOW }).map((e) => [e.account, e.reason]))
    }
    expect(s.accounts.find((a) => a.id === 'me2')!.lanes.bulk).toMatchObject({
      open: true,
      position: 1,
      reason: 'drain',
    })
  })

  test('a closed account says why in plain words and when it opens, per lane', () => {
    const s = status(reg, cacheOf({ iu: smp(null, 30), me: smp(95, 20), me2: smp(10, 92) }))
    const me = s.accounts.find((a) => a.id === 'me')!
    expect(me.lanes.bulk).toMatchObject({
      open: false,
      position: null,
      closed: 'session-max',
      opens_at: new Date(NOW + 3 * HMS).toISOString(),
    })
    expect(me.lanes.bulk.why).toBe('its 5 h window is at 95 % (limit 90)')
    expect(me.closed).toMatchObject({ closed: 'session-max' })
    expect(CLOSED_CODES).toContain(me.lanes.interactive.closed!)
  })

  test('the account row carries mode, limits with age, forecast and the last resets', () => {
    const s = status(
      reg,
      cacheOf({ iu: smp(null, 30), me: smp(40, 20), me2: smp(10, 92, 100, fableLimits(92, 6, 3, 900_000)) }),
      hist,
    )
    const a = s.accounts.find((x) => x.id === 'me2')!
    expect(a.mode).toMatchObject({ kind: 'drain', source: 'registry', expired: false })
    expect(a.limits.map((l) => l.kind)).toEqual(['session', 'weekly_all', 'weekly_scoped'])
    expect(a.limits[2]).toMatchObject({
      model: 'Fable',
      percent: 6,
      age_s: 900,
      used_percent_of_weekly: 3,
      allowance_percent_of_weekly: 50,
    })
    expect(a.forecast).toMatchObject({ method: FORECAST_METHOD })
    expect(a.resets).toEqual([
      {
        at: new Date(NOW - 100 * HMS).toISOString(),
        weekly: 99,
        scoped: 12,
        modes: ['drain'],
        rule: 'v1.10',
        closed_hours: 3.5,
        manual: false,
      },
    ])
    expect(validate(s, STATUS_SCHEMA as never)).toEqual([])
  })

  test('an account without a 5 h window has no session limit and a forecast in two units', () => {
    const a = status(reg3(), cacheOf({ iu: smp(null, 20), me: smp(40, 20), me2: smp(10, 20) })).accounts.find(
      (x) => x.id === 'iu',
    )!
    expect(a.limits.map((l) => l.kind)).toEqual(['weekly_all'])
    expect(a.forecast).toMatchObject({ weekly_at_reset: 20, waste_units: 1.6 })
  })

  test('the plain line leads with the forecast, as the example says', () => {
    const s = status(reg, cache, hist)
    const line = statusLine(
      s.accounts.find((a) => a.id === 'me2')!,
      NOW,
    )
    expect(line).toMatch(
      /^me2 drain · weekly 92 % · (full \w{3} \d\d:\d\d|ends at [\d.]+ % \([\d.]+ units unused\)) · resets \w{3} \d\d:\d\d$/,
    )
  })

  test('a weekly ceiling that is the same one rank uses', () => {
    expect(weeklyCeiling((NOW + 50 * HMS) / 1000, NOW)).toBe(95)
    expect(weeklyCeiling((NOW + 20 * HMS) / 1000, NOW)).toBe(98)
    expect(weeklyCeiling((NOW + 2 * HMS) / 1000, NOW)).toBe(100)
    expect(weeklyCeiling((NOW + 50 * HMS) / 1000, NOW, true)).toBe(100)
  })
})

describe('the CLI', () => {
  const CLI = join(import.meta.dir, '..', 'bin', 'claude-account.ts')
  const machine = () => {
    const home = tmp()
    const registry = join(home, 'registry.json')
    writeFileSync(registry, JSON.stringify(reg3({ drain: ['me2'] })))
    const env = {
      ...(process.env as Record<string, string>),
      HOME: home,
      TZ: 'UTC',
      CLAUDE_ACCOUNTS_REGISTRY: registry,
      CLAUDE_ACCOUNTS_CACHE_DIR: join(home, 'cache'),
      CLAUDE_ACCOUNTS_PICKS: join(home, 'picks.jsonl'),
      CLAUDE_ACCOUNTS_MODES: join(home, 'modes.json'),
      CLAUDE_ACCOUNTS_HISTORY: join(home, 'history'),
      CLAUDE_ACCOUNTS_SECURITY_BIN: '/usr/bin/false',
      CLAUDE_ACCOUNTS_SSH: '/usr/bin/false',
    }
    delete (env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR
    const cli = (args: string[]) => {
      const r = Bun.spawnSync(['bun', CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
      return { rc: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
    }
    return { home, env, cli }
  }
  const seed = (m: ReturnType<typeof machine>) => {
    const now = Date.now()
    const live = (s: number | null, w: number): Sample => ({
      s,
      w,
      s_reset: s === null ? null : Math.round(now / 1000) + 3 * H,
      w_reset: Math.round(now / 1000) + 40 * H,
      s_ts: s === null ? null : now,
      w_ts: now,
      src: 'statusline',
    })
    saveSample('iu', live(null, 30), m.env.CLAUDE_ACCOUNTS_CACHE_DIR, false)
    saveSample('me', live(40, 20), m.env.CLAUDE_ACCOUNTS_CACHE_DIR)
    saveSample('me2', live(10, 92), m.env.CLAUDE_ACCOUNTS_CACHE_DIR)
  }

  test('status --json validates against its schema and every lane matches rank --json; plain status is a line per account', () => {
    const m = machine()
    seed(m)
    const r = m.cli(['status', '--json'])
    expect(r.rc).toBe(0)
    const s = JSON.parse(r.out)
    expect(validate(s, STATUS_SCHEMA as never)).toEqual([])
    expect(s.machine).toBeString()
    for (const lane of s.lanes) {
      const fromStatus = s.accounts
        .filter((a: { lanes: Record<string, { open: boolean }> }) => a.lanes[lane].open)
        .sort(
          (a: { lanes: Record<string, { position: number }> }, b: { lanes: Record<string, { position: number }> }) =>
            a.lanes[lane].position - b.lanes[lane].position,
        )
        .map((a: { id: string }) => a.id)
      const ranked = JSON.parse(m.cli(['rank', '--lane', lane, '--json']).out).order.map(
        (e: { account: string }) => e.account,
      )
      expect(fromStatus).toEqual(ranked)
    }
    const plain = m.cli(['status'])
    expect(plain.rc).toBe(0)
    const lines = plain.out.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.find((l) => l.startsWith('me2'))).toMatch(/^me2 drain · weekly 92 % · .* · resets /)
  })

  test('the sample writes of one machine make the ledger: a statusline record across a reset, then history lists it', () => {
    const m = machine()
    const now = Date.now()
    const w = Math.round(now / 1000) + 2 * H
    expect(m.cli(['record', '--account', 'me', '--s', '10', '--w', '96', '--w-reset', String(w)]).rc).toBe(0)
    expect(m.cli(['record', '--account', 'me', '--s', '10', '--w', '96', '--w-reset', String(w)]).rc).toBe(0) // unchanged: no line
    expect(m.cli(['record', '--account', 'me', '--s', '1', '--w', '2', '--w-reset', String(w + 7 * 86400)]).rc).toBe(0)
    const h = JSON.parse(m.cli(['history', '--json']).out)
    expect(h.resets).toHaveLength(1)
    expect(h.resets[0]).toMatchObject({ id: 'me', weekly: 96, manual: true })
    expect(h.samples).toBe(2)
    expect(m.cli(['history']).out).toMatch(/^me\s+reset .*\(manual\)\s+weekly 96 %/)
  })

  test('history import seeds the past weeks from a file, once', () => {
    const m = machine()
    const dir = tmp()
    const file = join(dir, 'seed.jsonl')
    const day = Date.now() - 20 * 86400_000
    const rows = [
      { ts: day, id: 'me2', w: 40, w_reset: (day + 2 * 86400_000) / 1000 },
      { ts: day + 1.9 * 86400_000, id: 'me2', w: 99, w_reset: (day + 2 * 86400_000) / 1000 },
      { ts: day + 2.1 * 86400_000, id: 'me2', w: 1, w_reset: (day + 9 * 86400_000) / 1000 },
      { ts: day, id: 'ghost', w: 5, w_reset: null },
    ]
    writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`)
    const first = m.cli(['history', 'import', file])
    expect(first.out).toContain('3 lines added')
    expect(first.out).toContain('2 skipped')
    expect(m.cli(['history', 'import', file]).out).toContain('0 lines added, 3 already there')
    const ledger = JSON.parse(m.cli(['history', '--json', '--days', '30']).out).resets
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ id: 'me2', weekly: 99 })
  })
})
