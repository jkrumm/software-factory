import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Cache,
  type Cell,
  type LoadModel,
  type Registry,
  type ResetEntry,
  type Sample,
  type SampleLine,
  DEFAULT_POLICY,
  buildStatus,
  emptyOverrides,
  resolveModes,
  MEASURED,
  POLICY_NAMES,
  compare,
  compareText,
  disagreement,
  dueAccounts,
  emptyCache,
  laxityHours,
  liveResults,
  loadRegistry,
  measureLoad,
  mixedPool,
  pick,
  pickWith,
  policyOfRule,
  ruleTag,
  saveSample,
  shadowLine,
  simulate,
  verdicts,
} from '../src/index.ts'

// The policy lab (packages/accounts/docs/accounts.md §The policy lab): the measured load model, the named policies, the laxity candidate,
// the simulation and the verdict, the shadow log and the live ledger rows. Nothing here asserts a candidate's result:
// on the measured model none beats v1.9 (the docs record the run), so v1.9 stays the default and no test claims a win.

const H = 3600_000
const NOW = Date.UTC(2026, 10, 19, 12)
const tmp = () => mkdtempSync(join(tmpdir(), 'lab-'))

/** A flat model: one demand level all week, so the laxity arithmetic can be checked by hand. */
const FLAT: LoadModel = {
  ...MEASURED,
  curve: { hour_of_day_utc: new Array(24).fill(1), day_of_week: new Array(7).fill(1) },
  weekly_per_session_point: { max: 0.15, ultra: null },
  mix: { interactive: 0, headless: 0, bulk: 0, homeless: 1 },
  demand: 1,
}

const REG: Registry = {
  accounts: {
    iu: {
      dir: null,
      plan: 'ultra',
      units: { session: 4, weekly: 2 },
      homeLanes: ['interactive', 'headless'],
      enabled: true,
    },
    me: { dir: '/x/.claude-me', plan: 'max', homeLanes: ['bulk'], enabled: true },
    me2: { dir: '/x/.claude-me2', plan: 'max', homeLanes: ['bulk'], enabled: true },
  },
}
const sample = (s: number | null, w: number, resetH: number): Sample => ({
  s,
  w,
  s_reset: s === null ? null : Math.round((NOW + 3 * H) / 1000),
  w_reset: Math.round((NOW + resetH * H) / 1000),
  s_ts: s === null ? null : NOW - 60_000,
  w_ts: NOW - 60_000,
  src: 'oauth',
})
const cacheOf = (samples: Record<string, Sample>): Cache => ({ ...emptyCache(), samples })

describe('the measured load model', () => {
  test('load-model.json has the shape the simulation reads, with its date range', () => {
    const m = MEASURED
    expect(Date.parse(m.range.from)).toBeLessThan(Date.parse(m.range.to))
    expect(Date.parse(m.measured_at)).toBeGreaterThanOrEqual(Date.parse(m.range.from))
    expect(m.session_hours[0][0]).toBe(0)
    expect(m.session_hours.at(-1)![0]).toBe(1)
    for (let i = 1; i < m.session_hours.length; i++) {
      expect(m.session_hours[i][0]).toBeGreaterThan(m.session_hours[i - 1][0])
      expect(m.session_hours[i][1]).toBeGreaterThanOrEqual(m.session_hours[i - 1][1])
    }
    expect(m.units_per_session_hour).toBeGreaterThan(0)
    expect(m.weekly_per_session_point.max).toBeGreaterThan(0)
    expect(m.weekly_per_session_point.max).toBeLessThan(1)
    expect(m.demand).toBeGreaterThan(0)
    expect(m.curve.hour_of_day_utc).toHaveLength(24)
    expect(m.curve.day_of_week).toHaveLength(7)
    expect(Object.values(m.mix).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 2)
  })

  test('measureLoad reads consumption, the 5 h ratio, the curve, the lane mix and the session length from the records', () => {
    const t0 = Date.UTC(2026, 10, 2) // Monday
    const wReset = Math.round((t0 + 5 * 24 * H) / 1000)
    const line = (
      id: string,
      h: number,
      s: number | null,
      w: number,
      sReset: number | null,
      wr = wReset,
    ): SampleLine => ({
      v: 1,
      ts: t0 + h * H,
      id,
      s,
      s_reset: sReset,
      w,
      w_reset: wr,
      scoped: null,
      src: 't',
      mode: null,
      rule: null,
    })
    const win = Math.round((t0 + 15 * H) / 1000)
    const lines = [
      // me: 0 → 30 % s and 0 → 6 % w inside one window at 10:00-12:00 UTC (ratio 0.2)
      line('me', 10, 0, 0, win),
      line('me', 11, 15, 3, win),
      line('me', 12, 30, 6, win),
      // a late line still on the previous week neither resets nor adds
      line('me', 12.5, 30, 90, win, wReset - 7 * 24 * 3600),
      // iu (Ultra, 2 units): 10 → 20 % = 0.2 units at 10:00-11:00 UTC; a feed's echo a point lower adds nothing
      line('iu', 10, null, 10, null),
      line('iu', 11, null, 20, null),
      line('iu', 11.2, null, 19, null),
      line('iu', 11.4, null, 20, null),
    ]
    const m = measureLoad({
      reg: REG,
      lines,
      picks: [
        { ts: new Date(t0 + H).toISOString(), lane: 'interactive' },
        { ts: new Date(t0 + H).toISOString(), lane: 'lead' },
        { ts: new Date(t0 + H).toISOString(), lane: 'bulk' },
        { ts: new Date(t0 + H).toISOString(), lane: 'headless' },
      ],
      sessions: [
        [t0 + H, t0 + 2 * H],
        [t0 + H, t0 + 3 * H],
        [t0 + H, t0 + 1.5 * H],
      ],
      fromMs: t0,
      toMs: t0 + 7 * 24 * H,
      nowMs: t0 + 7 * 24 * H,
      sources: {},
    })
    expect(m.weekly_per_session_point).toEqual({ ultra: null, max: 0.2 })
    // 0.06 (me) + 0.2 (iu) units in a week over a pool of 4 units
    expect(m.demand).toBeCloseTo(0.26 / 4, 3)
    // session hours 0.5, 1 and 2, cut at the 95th percentile (here the middle one): 0.5 + 1 + 1
    expect(m.units_per_session_hour).toBeCloseTo(0.26 / 2.5, 4)
    expect(m.mix).toEqual({ interactive: 0.25, headless: 0.25, bulk: 0.25, homeless: 0.25 })
    expect(m.session_hours.at(-1)).toEqual([1, 1])
    const hod = m.curve.hour_of_day_utc
    expect(hod[10]).toBeGreaterThan(hod[11])
    expect(hod[3]).toBe(0)
    expect(m.curve.day_of_week[0]).toBe(7) // all of it on the Monday
  })
})

describe('policies', () => {
  test('a registry names its live policy; an unknown one is refused at load; none means v1.9', () => {
    const dir = tmp()
    const write = (body: unknown) => {
      const p = join(dir, `r-${Math.random().toString(36).slice(2)}.json`)
      writeFileSync(p, JSON.stringify(body))
      return p
    }
    expect(loadRegistry(write({ ...REG, policy: 'laxity' })).policy).toBe('laxity')
    expect(loadRegistry(write(REG)).policy).toBeUndefined()
    expect(() => loadRegistry(write({ ...REG, policy: 'v9' }))).toThrow(/policy "v9" is not one of v1.9, laxity/)
    expect(DEFAULT_POLICY).toBe('v1.9')
  })

  test('v1.9 by name is the picker as it was: the same answer on every lane and snapshot', () => {
    const caches = [
      cacheOf({ iu: sample(null, 20, 100), me: sample(10, 30, 50), me2: sample(5, 60, 150) }),
      cacheOf({ iu: sample(null, 80, 20), me: sample(85, 40, 40), me2: sample(10, 95, 30) }),
    ]
    for (const cache of caches)
      for (const lane of ['interactive', 'headless', 'bulk', 'lead'])
        expect(pickWith('v1.9', { reg: REG, cache, lane, nowMs: NOW })).toEqual(pick(REG, cache, lane, NOW))
  })

  test('the rule tag names a non-default policy, and the ledger reads it back', () => {
    expect(policyOfRule(ruleTag('v1.9'))).toBe('v1.9')
    expect(policyOfRule(ruleTag('laxity'))).toBe('laxity')
    expect(policyOfRule(null)).toBeNull()
    expect(policyOfRule('v1.10+nope')).toBeNull()
    const cache = cacheOf({ iu: sample(null, 20, 100), me: sample(10, 30, 50), me2: sample(5, 60, 150) })
    const statusRule = (reg: Registry) =>
      buildStatus({
        reg,
        cache,
        views: resolveModes(reg, emptyOverrides(), cache, NOW),
        history: {},
        nowMs: NOW,
        machine: 'mini',
      }).rule
    expect(statusRule(REG)).toBe('v1.10')
    expect(statusRule({ ...REG, policy: 'laxity' })).toBe('v1.10+laxity')
  })
})

describe('laxity', () => {
  // flat demand 1 over a pool of 4 units: 4/168 units an hour, all of it movable
  const base = { nowMs: NOW, poolUnits: 4, load: FLAT }
  test('a Max absorbs the smaller of its 5 h window (0.15 units / 5 h) and the movable demand', () => {
    // pool 8: the demand (8/168 units/h) outruns the window, which lets 3 %/h through: 100 % takes 33.3 h
    const max = { ...base, poolUnits: 8, w: 0, weeklyUnits: 1, windowUnits: 0.15 }
    expect(laxityHours({ ...max, resetMs: NOW + 40 * H })).toBeCloseTo(40 - 100 / 3, 3)
    // pool 4: the demand (2.38 %/h) is the bound: 42 h, so 40 h to the reset is 2 h short (due)
    expect(laxityHours({ ...max, poolUnits: 4, resetMs: NOW + 40 * H })).toBeCloseTo(40 - 42, 3)
    expect(laxityHours({ ...base, w: 0, resetMs: NOW + 20 * H, weeklyUnits: 1, windowUnits: 0.15 })!).toBeLessThan(0)
    expect(laxityHours({ ...base, w: 100, resetMs: NOW + 20 * H, weeklyUnits: 1, windowUnits: 0.15 })).toBe(20)
    expect(laxityHours({ ...base, w: 10, resetMs: NOW - H, weeklyUnits: 1, windowUnits: 0.15 })).toBeNull()
  })
  test('an Ultra has no 5 h window: it absorbs what the demand sends, 4/168 units an hour = 1.19 % of its 2 units', () => {
    const rate = (4 / 168 / 2) * 100
    expect(laxityHours({ ...base, w: 50, resetMs: NOW + 60 * H, weeklyUnits: 2, windowUnits: null })).toBeCloseTo(
      60 - 50 / rate,
      3,
    )
  })
  test('the due account with the least slack goes first; laxity picks it where v1.9 serves the earliest reset', () => {
    // me resets in 30 h at 0 % (cannot fill: due), me2 in 20 h at 90 % (fills in hours: not due)
    const cache = cacheOf({ iu: sample(null, 20, 150), me: sample(0, 0, 30), me2: sample(0, 90, 20) })
    expect(dueAccounts(REG, cache, ['iu', 'me', 'me2'], NOW, FLAT)).toEqual(['me'])
    expect(pickWith('laxity', { reg: REG, cache, lane: 'lead', nowMs: NOW, load: FLAT })).toMatchObject({
      picked: 'me',
      reason: 'due',
    })
    expect(pickWith('v1.9', { reg: REG, cache, lane: 'lead', nowMs: NOW, load: FLAT })).toMatchObject({
      picked: 'me2',
      reason: 'expiring-capacity',
    })
    // the interactive lane keeps its home under every policy
    for (const p of POLICY_NAMES)
      expect(pickWith(p, { reg: REG, cache, lane: 'interactive', nowMs: NOW, load: FLAT }).picked).toBe('iu')
  })
})

describe('simulation and compare', () => {
  test('a run is reproducible and accounts for every reset after the warm-up week', () => {
    const sc = { accts: mixedPool(3), demand: 1, model: MEASURED, policy: 'v1.9' as const, weeks: 2 }
    const a = simulate(sc)
    expect(simulate(sc)).toEqual(a)
    expect(Object.values(a.atReset).every((ws) => ws.length === 1)).toBe(true)
    expect(a.used).toBeGreaterThan(0)
    expect(a.used).toBeLessThanOrEqual(1)
  })

  test('compare runs every policy over the grid it is given and judges each candidate against v1.9', () => {
    const c = compare({ model: MEASURED, weeks: 2, demands: [1], pools: [2], seeds: [7, 11] })
    expect(c.cells).toHaveLength(POLICY_NAMES.length)
    expect(c.verdicts.map((v) => v.policy)).toEqual(POLICY_NAMES.filter((p) => p !== DEFAULT_POLICY))
    expect(compareText(c, MEASURED, [], [])).toContain('verdict against v1.9')
  })

  test('the verdict: more used beyond two standard errors, no more moved sessions, no more blocked at demand <= 1.0', () => {
    const cell = (policy: Cell['policy'], demand: number, usedBySeed: number[], moved: number, blocked = 0): Cell => ({
      policy,
      demand,
      accounts: 3,
      used: usedBySeed.reduce((s, u) => s + u, 0) / usedBySeed.length,
      usedBySeed,
      moved,
      blocked,
    })
    const v = verdicts([
      cell('v1.9', 1, [0.9, 0.91, 0.92], 10),
      cell('v1.9', 1.2, [0.95, 0.96, 0.97], 10, 0.05),
      // a clear gain, fewer moves, more blocked only above demand 1.0
      cell('laxity', 1, [0.95, 0.96, 0.97], 5),
      cell('laxity', 1.2, [0.99, 0.99, 1], 5, 0.08),
      // a gain inside the noise
      cell('laxity-pure', 1, [0.8, 0.99, 0.93], 5),
      cell('laxity-pure', 1.2, [0.97, 0.9, 1], 5),
      // a gain, but more blocked at demand 1.0
      cell('v1.9-cool', 1, [0.95, 0.96, 0.97], 5, 0.01),
      cell('v1.9-cool', 1.2, [0.99, 0.99, 1], 5),
    ])
    const by = Object.fromEntries(v.map((x) => [x.policy, x]))
    expect(by.laxity.beats).toBe(true)
    expect(by['laxity-pure']).toMatchObject({ beats: false, why: 'no more quota used at reset beyond the noise' })
    expect(by['v1.9-cool']).toMatchObject({ beats: false, why: 'more work blocked at demand 1.0 or below' })
  })
})

describe('shadow log and the live ledger', () => {
  test('a shadow line replays the live draws, so only a policy that decides otherwise differs', () => {
    const cache = cacheOf({ iu: sample(null, 20, 150), me: sample(0, 0, 30), me2: sample(0, 90, 20) })
    const draws = [0.3]
    const live = pick(REG, cache, 'lead', NOW, () => draws[0])
    const l = shadowLine(REG, cache, 'lead', NOW, live, draws)
    expect(l.policy).toBe('v1.9')
    expect(l.shadowed).toEqual(POLICY_NAMES.filter((p) => p !== 'v1.9'))
    expect(Object.keys(l.differs).every((p) => l.shadowed.includes(p as never))).toBe(true)
    const calm = cacheOf({ iu: sample(null, 20, 150), me: sample(0, 20, 150), me2: sample(0, 20, 150) })
    expect(shadowLine(REG, calm, 'interactive', NOW, pick(REG, calm, 'interactive', NOW), []).differs).toEqual({})
    expect(disagreement([l, { ...l, differs: {} }, 'junk'])).toContainEqual({
      policy: 'laxity-pure',
      picks: 2,
      differs: 'laxity-pure' in l.differs ? 1 : 0,
      rate: 'laxity-pure' in l.differs ? 0.5 : 0,
    })
  })

  test('the ledger is grouped by the policy each week ran under, capacity-weighted', () => {
    const e = (id: string, weekly: number, rule: string | null): ResetEntry => ({
      v: 1,
      id,
      key: `${id}:${weekly}`,
      at: NOW,
      reset_at: null,
      weekly,
      scoped: null,
      modes: [],
      rule,
      closed_hours: 2,
      manual: false,
    })
    const rows = liveResults(
      [e('iu', 100, null), e('me', 70, null), e('me', 90, 'v1.10'), e('me2', 80, 'v1.10+laxity')],
      REG,
    )
    expect(rows).toEqual([
      { policy: 'unrecorded', resets: 2, used: (2 * 1 + 0.7) / 3, closedHours: 2 },
      { policy: 'v1.9', resets: 1, used: 0.9, closedHours: 2 },
      { policy: 'laxity', resets: 1, used: 0.8, closedHours: 2 },
    ])
  })

  test('a live pick writes a shadow line beside picks.jsonl, whose shape stays as it was', () => {
    const home = tmp()
    const bin = join(home, 'bin')
    mkdirSync(bin)
    for (const [name, body] of [
      ['claude', 'exit 0'],
      ['security', 'exit 44'],
      ['ssh', 'exit 255'],
    ]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    const registry = join(home, 'registry.json')
    writeFileSync(registry, JSON.stringify(REG))
    const cache = join(home, 'cache')
    const now = Date.now()
    const fresh = (s: number | null, w: number, resetH: number): Sample => ({
      s,
      w,
      s_reset: s === null ? null : Math.round((now + 3 * H) / 1000),
      w_reset: Math.round((now + resetH * H) / 1000),
      s_ts: s === null ? null : now - 60_000,
      w_ts: now - 60_000,
      src: 't',
    })
    saveSample('iu', fresh(null, 20, 150), cache)
    saveSample('me', fresh(0, 0, 30), cache)
    saveSample('me2', fresh(0, 90, 20), cache)
    const env = {
      ...(process.env as Record<string, string>),
      HOME: home,
      CLAUDE_ACCOUNTS_REGISTRY: registry,
      CLAUDE_ACCOUNTS_CACHE_DIR: cache,
      CLAUDE_ACCOUNTS_PICKS: join(home, 'picks.jsonl'),
      CLAUDE_ACCOUNTS_SECURITY_BIN: join(bin, 'security'),
      CLAUDE_ACCOUNTS_SSH: join(bin, 'ssh'),
      PATH: `${bin}:${process.env.PATH}`,
    }
    delete (env as Record<string, string | undefined>).CLAUDE_CONFIG_DIR
    const CLI = join(import.meta.dir, '..', 'bin', 'claude-account.ts')
    const r = Bun.spawnSync(['bun', CLI, 'pick', '--lane', 'lead'], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode).toBe(0)
    const pickLine = JSON.parse(readFileSync(join(home, 'picks.jsonl'), 'utf8'))
    expect(Object.keys(pickLine)).toEqual(['ts', 'lane', 'picked', 'reason', 'stale', 'iu', 'me', 'me2'])
    const shadow = JSON.parse(readFileSync(join(home, 'shadow.jsonl'), 'utf8'))
    expect(shadow).toMatchObject({ lane: 'lead', policy: 'v1.9', picked: pickLine.picked })
    expect(shadow.shadowed).toEqual(POLICY_NAMES.filter((p) => p !== 'v1.9'))
    // --dry writes neither
    Bun.spawnSync(['bun', CLI, 'pick', '--lane', 'lead', '--dry'], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(readFileSync(join(home, 'shadow.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    // simulate answers on the measured model
    const sim = Bun.spawnSync(['bun', CLI, 'simulate', '--accounts', '2', '--weeks', '2', '--json'], {
      env,
      stdout: 'pipe',
    })
    expect(sim.exitCode).toBe(0)
    expect(JSON.parse(sim.stdout.toString())).toMatchObject({
      policy: 'v1.9',
      demand: 1,
      result: { blocked: expect.any(Number) },
    })
  })
})
