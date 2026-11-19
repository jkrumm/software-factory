// Registry v2 (docs/accounts.md §Modes): modes with an expiry, overrides that reach the other machine, the reserve budget.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Account,
  type Cache,
  type ModeKind,
  type OverrideRecord,
  type Registry,
  type Sample,
  SESSION_SOFT_MAX,
  SPILL,
  defaultAccountId,
  eligible,
  emptyCache,
  fableAccount,
  hasSessionLimit,
  launchAccount,
  loadCache,
  loadOverrides,
  loadRegistry,
  modeOf,
  observedReset,
  parseMode,
  pick,
  rank,
  reserveBudget,
  reserveHold,
  resolveModes,
  applyModes,
  runRefresh,
  sampleFromOAuthUsage,
  saveSample,
} from '../src/index.ts'

const NOW = 1_800_000_000_000
const H = 3600
const D = 24 * H
const tmp = () => mkdtempSync(join(tmpdir(), 'modes-'))

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
const sample = (s: number | null, w: number, wResetS = NOW / 1000 + 100 * H, o: Partial<Sample> = {}): Sample => ({
  s,
  w,
  s_reset: s === null ? null : NOW / 1000 + 3 * H,
  w_reset: wResetS,
  s_ts: s === null ? null : NOW - 60_000,
  w_ts: NOW - 60_000,
  src: 't',
  ...o,
})
const cacheOf = (samples: Record<string, Sample>, o: Partial<Cache> = {}): Cache => ({ ...emptyCache(), samples, ...o })

/** The endpoint's limit set for one account: weekly_all, a Fable scoped limit and its share of the weekly limit. */
const fable = (weekly: number, scoped: number, used: number, o: { allowance?: number; ageMs?: number } = {}) => ({
  limits: [
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: weekly,
      severity: 'normal',
      resets_at: null,
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: scoped,
      severity: 'normal',
      resets_at: null,
      scope: { model: { display_name: 'Fable', id: null } },
      is_active: true,
    },
  ],
  scoped_shares: [{ limit_index: 1, used_percent_of_weekly: used, allowance_percent_of_weekly: o.allowance ?? 50 }],
  limits_ts: NOW - (o.ageMs ?? 60_000),
})

describe('samples keep the endpoint limits', () => {
  test('sampleFromOAuthUsage keeps limits[] and weekly_scoped_shares[] with the fetch time', () => {
    const f = fable(15, 6, 3)
    const s = sampleFromOAuthUsage(
      {
        five_hour: null,
        seven_day: { utilization: 15, resets_at: '2027-01-15T18:00:00Z' },
        limits: f.limits,
        weekly_scoped_shares: f.scoped_shares,
      },
      NOW,
    )
    expect(s).toMatchObject({ w: 15, limits: f.limits, scoped_shares: f.scoped_shares, limits_ts: NOW, src: 'oauth' })
  })
  test('a statusline sample keeps the stored limits; a later endpoint answer replaces them', () => {
    const dir = tmp()
    saveSample('iu', { ...sample(null, 15), ...fable(15, 6, 3) }, dir, false, NOW)
    saveSample('iu', { ...sample(null, 18), w_ts: NOW }, dir, false, NOW)
    expect(loadCache(dir).samples.iu).toMatchObject({ w: 18, limits_ts: NOW - 60_000 })
    saveSample('iu', { ...sample(null, 19), w_ts: NOW + 1, ...fable(19, 8, 4), limits_ts: NOW + 1 }, dir, false, NOW)
    expect(loadCache(dir).samples.iu.scoped_shares).toEqual(fable(19, 8, 4).scoped_shares)
    rmSync(dir, { recursive: true })
  })
})

describe('hold: allowance, the reserve budget', () => {
  const reg = () =>
    reg3({
      accounts: {
        ...reg3().accounts,
        iu: { ...reg3().accounts.iu, mode: { kind: 'reserve', for: 'fable', hold: 'allowance' } },
      },
    })
  const others = { me: sample(10, 20, NOW / 1000 + 120 * H), me2: sample(10, 20, NOW / 1000 + 130 * H) }
  test('inside its budget the reserve account takes its normal place: iu is home for interactive again', () => {
    const c = cacheOf({ iu: { ...sample(null, 15), ...fable(15, 6, 3) }, ...others })
    expect(reserveBudget(reg(), c, 'iu', NOW)).toMatchObject({
      known: true,
      unused: 47,
      weekly: 15,
      ceiling: 95,
      open: true,
    })
    expect(pick(reg(), c, 'interactive', NOW)).toMatchObject({ picked: 'iu', reason: 'home' })
    expect(rank({ reg: reg(), cache: c, lane: 'interactive', nowMs: NOW })[0].account).toBe('iu')
  })
  test('the weight offers only the room the unused allowance leaves', () => {
    const c = cacheOf({ iu: { ...sample(null, 15), ...fable(15, 6, 3) }, ...others })
    const plain = cacheOf({ iu: sample(null, 15), ...others })
    const w = (cache: Cache) =>
      rank({ reg: reg3(), cache, lane: 'lead', nowMs: NOW }).find((e) => e.account === 'iu')!.weight!
    const r = rank({ reg: reg(), cache: c, lane: 'lead', nowMs: NOW }).find((e) => e.account === 'iu')!.weight!
    expect(r).toBeCloseTo((w(plain) * (95 - 15 - 47)) / (95 - 15), 6)
  })
  test('once weekly plus the unused allowance reaches the ceiling, other work is refused (not even the last resort)', () => {
    const c = cacheOf({ iu: { ...sample(null, 48), ...fable(48, 6, 3) }, ...others })
    expect(reserveBudget(reg(), c, 'iu', NOW)).toMatchObject({ open: false, unused: 47 })
    for (const lane of ['interactive', 'headless', 'bulk', 'lead'])
      expect(pick(reg(), c, lane, NOW).picked).not.toBe('iu')
    expect(rank({ reg: reg(), cache: c, lane: 'interactive', nowMs: NOW }).map((e) => e.account)).not.toContain('iu')
    const walled = cacheOf({ iu: c.samples.iu, me: sample(95, 20), me2: sample(95, 20) })
    expect(pick(reg(), walled, 'bulk', NOW).picked).toBe(SPILL)
    expect(pick(reg(), walled, 'interactive', NOW)).toMatchObject({ picked: 'iu', reason: 'interactive-fallback' })
  })
  test('in the final 24 h the unused allowance is released (spec choice A)', () => {
    const resetSoon = NOW / 1000 + 20 * H
    const c = cacheOf({ iu: { ...sample(null, 60, resetSoon), ...fable(60, 6, 3) }, ...others })
    expect(reserveBudget(reg(), c, 'iu', NOW)).toMatchObject({ released: true, unused: 0, ceiling: 98, open: true })
    expect(pick(reg(), c, 'interactive', NOW)).toMatchObject({ picked: 'iu' })
  })
  test('without a fresh scoped sample the budget is unknown: the v1 last resort (spec choice B)', () => {
    for (const iu of [sample(null, 15), { ...sample(null, 15), ...fable(15, 6, 3, { ageMs: 7 * H * 1000 }) }]) {
      const c = cacheOf({ iu, ...others })
      expect(reserveBudget(reg(), c, 'iu', NOW)).toMatchObject({ known: false })
      expect(pick(reg(), c, 'interactive', NOW).picked).not.toBe('iu')
      const only = cacheOf({ iu, me: sample(95, 20), me2: sample(95, 20) })
      expect(pick(reg(), only, 'bulk', NOW)).toMatchObject({ picked: 'iu', reason: 'fable-reserve' })
    }
  })
  test('a reserve is due for one endpoint GET when its scoped sample is older than 30 min', async () => {
    const { dueIds } = await import('../src/index.ts')
    const fresh = cacheOf({ iu: { ...sample(null, 15), ...fable(15, 6, 3) }, ...others })
    const old = cacheOf({ iu: { ...sample(null, 15), ...fable(15, 6, 3, { ageMs: 31 * 60_000 }) }, ...others })
    expect(dueIds(reg(), fresh, NOW)).toEqual([])
    expect(dueIds(reg(), old, NOW)).toEqual(['iu'])
    expect(dueIds(reg3(), old, NOW)).toEqual([]) // not a reserve: the statusline keeps it fresh enough
  })
})

describe('hold: account (the default, and what the v1 fable key means)', () => {
  const others = { me: sample(10, 20, NOW / 1000 + 120 * H), me2: sample(10, 20, NOW / 1000 + 130 * H) }
  const open = cacheOf({ iu: { ...sample(null, 15), ...fable(15, 6, 3) }, ...others })
  const regs: [string, Registry][] = [
    ['the v1 fable key', reg3({ fable: 'iu' })],
    [
      'a registry mode without hold',
      reg3({
        accounts: {
          ...reg3().accounts,
          iu: acc(null, 'ultra', ['interactive', 'headless'], { mode: { kind: 'reserve', for: 'fable' } }),
        },
      }),
    ],
    [
      'hold: account',
      reg3({
        accounts: {
          ...reg3().accounts,
          iu: acc(null, 'ultra', ['interactive', 'headless'], {
            mode: { kind: 'reserve', for: 'fable', hold: 'account' },
          }),
        },
      }),
    ],
  ]
  for (const [name, reg] of regs)
    test(`${name}: iu is the last resort in every lane whatever its open budget says, reason fable-reserve`, () => {
      expect(modeOf(reg, 'iu', NOW)).toMatchObject({ kind: 'reserve', for: 'fable' })
      expect(reserveHold(modeOf(reg, 'iu', NOW))).toBe('account')
      expect(reserveBudget(reg, open, 'iu', NOW)).toBeNull()
      for (const lane of ['interactive', 'headless', 'bulk', 'lead']) {
        expect(pick(reg, open, lane, NOW).picked, lane).not.toBe('iu')
        const order = rank({ reg, cache: open, lane, nowMs: NOW })
        expect(order.at(-1), lane).toMatchObject({ account: 'iu', reason: 'fable-reserve' })
      }
      const only = cacheOf({ iu: open.samples.iu, me: sample(95, 20), me2: sample(95, 20) })
      expect(pick(reg, only, 'bulk', NOW)).toMatchObject({ picked: 'iu', reason: 'fable-reserve' })
      expect(fableAccount(reg, open, NOW)).toBe('iu')
    })
  test('a reserve inside the last 24 h and over its budget is still held, not released or refused', () => {
    const reg = reg3({ fable: 'iu' })
    const c = cacheOf({ iu: { ...sample(null, 60, NOW / 1000 + 20 * H), ...fable(60, 6, 3) }, ...others })
    expect(rank({ reg, cache: c, lane: 'interactive', nowMs: NOW }).at(-1)).toMatchObject({
      account: 'iu',
      reason: 'fable-reserve',
    })
    const full = cacheOf({ iu: { ...sample(null, 48), ...fable(48, 6, 3) }, ...others })
    expect(rank({ reg, cache: full, lane: 'bulk', nowMs: NOW }).at(-1)).toMatchObject({
      account: 'iu',
      reason: 'fable-reserve',
    })
  })
  test('a hold other than account or allowance is refused in the registry; hold belongs to reserve', () => {
    expect(parseMode({ kind: 'reserve', for: 'fable', hold: 'allowance' })).toEqual({
      kind: 'reserve',
      for: 'fable',
      hold: 'allowance',
    })
    expect(parseMode({ kind: 'reserve', for: 'fable', hold: 'half' })).toMatch('hold must be')
    expect(parseMode({ kind: 'drain', hold: 'account' })).toMatch('hold belongs to reserve')
  })
})

describe('the launcher for a model', () => {
  const reg = (): Registry => ({
    accounts: {
      iu: acc(null, 'ultra', ['interactive'], { mode: { kind: 'reserve', for: 'fable' } }),
      me: acc('/x/me', 'max', ['bulk'], { mode: { kind: 'reserve', for: 'Fable' } }),
      me2: acc('/x/me2', 'max', ['bulk']),
    },
  })
  test('the open reserve with the most unused allowance; none open: the first; none at all: the default', () => {
    const c = cacheOf({
      iu: { ...sample(null, 10), ...fable(10, 40, 20) },
      me: { ...sample(5, 10), ...fable(10, 4, 2) },
      me2: sample(5, 5),
    })
    expect(launchAccount(reg(), c, 'fable', NOW)).toBe('me')
    const meFull = cacheOf({ ...c.samples, me: { ...sample(5, 10), ...fable(10, 100, 50) } })
    expect(launchAccount(reg(), meFull, 'fable', NOW)).toBe('iu')
    const none = cacheOf({ iu: sample(null, 99), me: sample(95, 10), me2: sample(5, 5) })
    expect(launchAccount(reg(), none, 'fable', NOW)).toBe('iu')
    expect(launchAccount(reg3(), none, 'fable', NOW)).toBe('iu')
    expect(launchAccount({ ...reg3(), fable: 'me2' }, emptyCache(), 'fable', NOW)).toBe('me2')
  })
})

describe('expiry: until reset ends at an observed reset, a manual one included', () => {
  const R = NOW / 1000 + 50 * H // me2's scheduled weekly reset
  const drain = (o: Partial<OverrideRecord> = {}): OverrideRecord => ({
    kind: 'drain',
    until: 'reset',
    why: 'empty before the manual reset',
    set_at: NOW,
    set_on: 'mini',
    baseline_w_reset: R,
    ...o,
  })
  const state = (r: OverrideRecord) => ({ version: 1 as const, accounts: { me2: r } })
  const view = (dir: string, at: number, r = drain()) => resolveModes(reg3(), state(r), loadCache(dir), at).me2

  test('live before the reset: drain from the override, first in every lane while cool', () => {
    const dir = tmp()
    saveSample('me2', sample(10, 97, R), dir, true, NOW - 60_000)
    saveSample('me', sample(10, 20), dir, true, NOW - 60_000)
    saveSample('iu', sample(null, 20), dir, false, NOW - 60_000)
    const v = view(dir, NOW + 60_000)
    expect(v).toMatchObject({ source: 'override', mode: { kind: 'drain', until: 'reset' }, until_at: R * 1000 })
    const applied = applyModes(reg3(), resolveModes(reg3(), state(drain()), loadCache(dir), NOW))
    for (const lane of ['interactive', 'bulk', 'lead'])
      expect(pick(applied, loadCache(dir), lane, NOW)).toMatchObject({ picked: 'me2', reason: 'drain' })
    rmSync(dir, { recursive: true })
  })
  test('a manual reset before the scheduled time ends it (the window moves a week on)', () => {
    const dir = tmp()
    saveSample('me2', sample(10, 97, R), dir, true, NOW - 60_000)
    saveSample(
      'me2',
      { ...sample(0, 0, NOW / 1000 + 7 * D), s_ts: NOW + 60_000, w_ts: NOW + 60_000 },
      dir,
      true,
      NOW + 60_000,
    )
    expect(loadCache(dir).resets?.me2).toMatchObject({ at: NOW + 60_000, w_before: 97, w_reset_before: R })
    expect(view(dir, NOW + 120_000)).toMatchObject({ source: 'registry', expired: true, mode: { kind: 'normal' } })
    rmSync(dir, { recursive: true })
  })
  test('a fall of 50 points with the same reset time ends it too', () => {
    const dir = tmp()
    saveSample('me2', sample(10, 97, R), dir, true, NOW - 60_000)
    saveSample('me2', { ...sample(1, 2, R), s_ts: NOW + 60_000, w_ts: NOW + 60_000 }, dir, true, NOW + 60_000)
    expect(view(dir, NOW + 120_000).expired).toBe(true)
    rmSync(dir, { recursive: true })
  })
  test('the scheduled reset passing ends it, with or without a sample', () => {
    const dir = tmp()
    expect(view(dir, NOW + 60_000).source).toBe('override')
    expect(view(dir, R * 1000).source).toBe('registry')
    rmSync(dir, { recursive: true })
  })
  test('a sample whose weekly reset lies more than a day past the baseline ends it (no reset file needed)', () => {
    const c = cacheOf({ me2: sample(10, 3, R + 7 * D) })
    expect(resolveModes(reg3(), state(drain()), c, NOW + 60_000).me2.source).toBe('registry')
  })
  test('a rollover that happened before the override was set does not end it', () => {
    const c = cacheOf(
      { me2: sample(10, 3, R) },
      { resets: { me2: { at: NOW + 60_000, w_before: 90, w_reset_before: NOW / 1000 - H, w_reset_after: R } } },
    )
    expect(resolveModes(reg3(), state(drain()), c, NOW + 120_000).me2.source).toBe('override')
  })
  test('an ISO until ends at that time; a registry mode with a passed until falls back to the v1 keys', () => {
    const iso = new Date(NOW + H * 1000).toISOString()
    const c = cacheOf({})
    expect(resolveModes(reg3(), state(drain({ until: iso, baseline_w_reset: null })), c, NOW).me2.source).toBe(
      'override',
    )
    expect(
      resolveModes(reg3(), state(drain({ until: iso, baseline_w_reset: null })), c, NOW + 2 * H * 1000).me2.source,
    ).toBe('registry')
    const r = reg3({ drain: ['me2'] })
    r.accounts.me2 = { ...r.accounts.me2, mode: { kind: 'paused', until: iso } }
    expect(resolveModes(r, { version: 1, accounts: {} }, c, NOW).me2.mode.kind).toBe('paused')
    expect(resolveModes(r, { version: 1, accounts: {} }, c, NOW + 2 * H * 1000).me2.mode.kind).toBe('drain')
  })
  test('observedReset: a forward move of more than a day, or a fall of 50 points', () => {
    expect(observedReset(sample(1, 90, R), sample(1, 91, R + 2 * D))).toBe(true)
    expect(observedReset(sample(1, 90, R), sample(1, 40, R))).toBe(true)
    expect(observedReset(sample(1, 90, R), sample(1, 41, R + H))).toBe(false)
    expect(observedReset(null, sample(1, 0, R))).toBe(false)
  })
})

describe('registry v2', () => {
  const load = (body: unknown) => {
    const dir = tmp()
    const p = join(dir, 'r.json')
    writeFileSync(p, JSON.stringify(body))
    try {
      return loadRegistry(p)
    } finally {
      rmSync(dir, { recursive: true })
    }
  }
  test('a v1 file reads exactly as before', () => {
    const v1 = { fable: 'iu', drain: ['me2'], accounts: reg3().accounts }
    expect(load(v1)).toEqual({ accounts: reg3().accounts, fable: 'iu', drain: ['me2'] })
  })
  test('per-account mode: a kind or an object; reserve needs for; until reset is refused in the registry', () => {
    const r = load({ version: 2, accounts: { ...reg3().accounts, me: { ...reg3().accounts.me, mode: 'paused' } } })
    expect(r.version).toBe(2)
    expect(r.accounts.me.mode).toEqual({ kind: 'paused' })
    const bad = (mode: unknown) => () => load({ accounts: { ...reg3().accounts, me: { ...reg3().accounts.me, mode } } })
    expect(bad({ kind: 'reserve' })).toThrow('reserve needs for')
    expect(bad({ kind: 'drain', until: 'reset' })).toThrow('overrides only')
    expect(bad('sleep')).toThrow('kind must be one of')
  })
  test('an unknown version is refused (the CLI reads it as registry unreadable)', () => {
    expect(() => load({ version: 3, accounts: reg3().accounts })).toThrow('version 3 is not known')
  })
})

describe('an override reaches the other machine through the peer import', () => {
  const CLI = join(import.meta.dir, '..', 'bin', 'claude-account.ts')
  const machine = () => {
    const home = tmp()
    const registry = join(home, 'registry.json')
    writeFileSync(registry, JSON.stringify(reg3()))
    const env = {
      ...(process.env as Record<string, string>),
      HOME: home,
      CLAUDE_ACCOUNTS_REGISTRY: registry,
      CLAUDE_ACCOUNTS_CACHE_DIR: join(home, 'cache'),
      CLAUDE_ACCOUNTS_PICKS: join(home, 'picks.jsonl'),
      CLAUDE_ACCOUNTS_MODES: join(home, 'modes.json'),
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
  // B's refresh with A's `usage --json` as the peer: no Keychain token, `claude auth status` says logged in
  const importInto = (b: ReturnType<typeof machine>, peerBody: unknown) =>
    runRefresh({
      reg: reg3(),
      claudeBin: 'claude',
      baseEnv: { PATH: '/bin' },
      now: () => Date.now(),
      ids: ['me'],
      dir: b.env.CLAUDE_ACCOUNTS_CACHE_DIR,
      modesPath: b.env.CLAUDE_ACCOUNTS_MODES,
      machine: 'macbook',
      peerUsage: () => peerBody,
      spawn: (cmd) =>
        cmd === '/usr/bin/security'
          ? { status: 44, stdout: '', stderr: '' }
          : { status: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' },
      httpGet: async () => ({ status: 500, json: null }),
    })
  test("set on A shows in A's rank at once and on B after its refresh; a clear on A removes it on B", async () => {
    const a = machine()
    const b = machine()
    const until = new Date(Date.now() + 2 * 86400_000).toISOString()
    expect(a.cli(['mode', 'me2', 'drain', '--until', until, '--why', 'empty it']).rc).toBe(0)
    saveSample('me2', { ...sample(10, 40), s_ts: Date.now(), w_ts: Date.now() }, a.env.CLAUDE_ACCOUNTS_CACHE_DIR)
    saveSample('me', { ...sample(10, 40), s_ts: Date.now(), w_ts: Date.now() }, a.env.CLAUDE_ACCOUNTS_CACHE_DIR)
    expect(JSON.parse(a.cli(['rank', '--lane', 'bulk', '--json']).out).order[0]).toMatchObject({
      account: 'me2',
      reason: 'drain',
    })
    const usageA = JSON.parse(a.cli(['usage', '--json']).out)
    const row = usageA.accounts.find((r: { id: string }) => r.id === 'me2')
    expect(row.mode).toMatchObject({ kind: 'drain', until, why: 'empty it', source: 'override' })
    expect([
      row.mode_override.kind,
      row.mode_override.until,
      typeof row.mode_override.set_at,
      typeof row.mode_override.set_on,
    ]).toEqual(['drain', until, 'number', 'string'])

    await importInto(b, usageA)
    expect(loadOverrides(b.env.CLAUDE_ACCOUNTS_MODES).accounts.me2).toEqual(row.mode_override)
    const listedB = JSON.parse(b.cli(['mode', '--json']).out).accounts.find((r: { id: string }) => r.id === 'me2')
    expect(listedB).toMatchObject({ kind: 'drain', source: 'override' })
    expect(readFileSync(b.env.CLAUDE_ACCOUNTS_MODES.replace(/\.json$/, '.jsonl'), 'utf8')).toContain('"action":"adopt"')

    expect(a.cli(['mode', 'me2', '--clear']).rc).toBe(0)
    await importInto(b, JSON.parse(a.cli(['usage', '--json']).out))
    expect(loadOverrides(b.env.CLAUDE_ACCOUNTS_MODES).accounts.me2).toMatchObject({ cleared: true })
    expect(
      JSON.parse(b.cli(['mode', '--json']).out).accounts.find((r: { id: string }) => r.id === 'me2'),
    ).toMatchObject({
      kind: 'normal',
      source: 'registry',
    })
    // an older record from the peer never replaces a newer local one
    await importInto(b, usageA)
    expect(loadOverrides(b.env.CLAUDE_ACCOUNTS_MODES).accounts.me2).toMatchObject({ cleared: true })
    rmSync(a.home, { recursive: true })
    rmSync(b.home, { recursive: true })
  })
  test('an empty limit set from the peer carries no age and never replaces a local one', async () => {
    const b = machine()
    const local = {
      ...sample(10, 20),
      s_ts: Date.now(),
      w_ts: Date.now(),
      ...fable(20, 6, 3),
      limits_ts: Date.now() - 60_000,
    }
    saveSample('me', local, b.env.CLAUDE_ACCOUNTS_CACHE_DIR)
    await importInto(b, {
      accounts: [
        {
          id: 'me',
          five_hour: 10,
          seven_day: 20,
          five_hour_age_s: 5,
          seven_day_age_s: 5,
          limits: [],
          weekly_scoped_shares: [],
        },
      ],
    })
    expect(loadCache(b.env.CLAUDE_ACCOUNTS_CACHE_DIR).samples.me.limits).toEqual(local.limits)
    rmSync(b.home, { recursive: true })
  })
  test('the mode verb refuses bad input with exit 2; drain defaults to until reset', () => {
    const a = machine()
    expect(a.cli(['mode', 'nope', 'drain']).rc).toBe(2)
    expect(a.cli(['mode', 'me', 'reserve']).rc).toBe(2)
    expect(a.cli(['mode', 'me', 'paused', '--for', 'fable']).rc).toBe(2)
    expect(a.cli(['mode', 'me', 'drain', '--until', '2001-01-01T00:00:00Z']).rc).toBe(2)
    expect(a.cli(['mode', 'me', 'sleep']).rc).toBe(2)
    expect(a.cli(['mode', 'me', 'drain']).rc).toBe(0)
    expect(loadOverrides(a.env.CLAUDE_ACCOUNTS_MODES).accounts.me).toMatchObject({ kind: 'drain', until: 'reset' })
    expect(a.cli(['mode']).out).toMatch(/^me\s+drain\s+override\s+until reset/m)
    rmSync(a.home, { recursive: true })
  })
  test('mode reserve --hold: account is the default, allowance keeps the budget; both show in the listing and usage --json', () => {
    const a = machine()
    expect(a.cli(['mode', 'me', 'reserve', '--for', 'fable', '--hold', 'half']).rc).toBe(2)
    expect(a.cli(['mode', 'me', 'paused', '--hold', 'account']).rc).toBe(2)
    expect(a.cli(['mode', 'me', 'reserve', '--for', 'fable']).out).toContain('holds the account')
    expect(loadOverrides(a.env.CLAUDE_ACCOUNTS_MODES).accounts.me).toMatchObject({ kind: 'reserve', hold: 'account' })
    expect(a.cli(['mode']).out).toMatch(/^me\s+reserve for fable\s+override.*holds the account/m)
    const row = (id: string) =>
      (JSON.parse(a.cli(['usage', '--json']).out).accounts as { id: string; mode: { hold: string | null } }[]).find(
        (r) => r.id === id,
      )!
    expect(row('me').mode.hold).toBe('account')
    expect(row('me2').mode.hold).toBeNull()
    expect(a.cli(['mode', 'me', 'reserve', '--for', 'fable', '--hold', 'allowance']).rc).toBe(0)
    expect(a.cli(['mode']).out).toMatch(/^me\s+reserve for fable\s+override.*budget unknown/m)
    expect(row('me').mode.hold).toBe('allowance')
    rmSync(a.home, { recursive: true })
  })
  test('a registry version this build does not know: pick falls back to the default account with exit 4', () => {
    const a = machine()
    writeFileSync(a.env.CLAUDE_ACCOUNTS_REGISTRY, JSON.stringify({ version: 9, ...reg3() }))
    const r = a.cli(['pick', '--lane', 'bulk'])
    expect([r.rc, r.out.trim()]).toEqual([4, 'unset CLAUDE_CONFIG_DIR'])
    expect(a.cli(['usage']).rc).toBe(2)
    rmSync(a.home, { recursive: true })
  })
})

describe('property: 1 to 8 accounts, random plans, reset times and modes', () => {
  // mulberry32: a seeded source, so a failure names its seed and replays
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const LANES = ['interactive', 'headless', 'bulk', 'lead']
  const KINDS: ModeKind[] = ['normal', 'normal', 'drain', 'reserve', 'paused']
  const world = (seed: number) => {
    const r = rng(seed)
    const int = (n: number) => Math.floor(r() * n)
    const n = 1 + int(8)
    const accounts: Record<string, Account> = {}
    const samples: Record<string, Sample> = {}
    for (let i = 0; i < n; i++) {
      const id = `a${i}`
      const plan = r() < 0.3 ? 'ultra' : 'max'
      const kind = KINDS[int(KINDS.length)]
      accounts[id] = acc(
        i === 0 ? null : `/x/${id}`,
        plan,
        LANES.filter(() => r() < 0.3),
        {
          enabled: r() < 0.9,
          mode:
            kind === 'reserve' ? { kind, for: 'fable', ...(r() < 0.5 ? { hold: 'account' as const } : {}) } : { kind },
        },
      )
      const s = plan === 'ultra' ? null : int(101)
      const x = sample(s, int(101), NOW / 1000 + (1 + int(167)) * H)
      samples[id] = kind === 'reserve' && r() < 0.7 ? { ...x, ...fable(x.w!, int(101), int(51)) } : x
    }
    return { reg: { accounts } as Registry, cache: cacheOf(samples) }
  }
  test('a paused or closed account is never picked, a cool drain account is first, the same snapshot gives the same order', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { reg, cache } = world(seed)
      for (const lane of LANES) {
        const p = pick(reg, cache, lane, NOW)
        const ctx = `seed ${seed} lane ${lane} picked ${p.picked} (${p.reason})`
        // the interactive fallback lands on the default account whatever its state: Claude Code shows the limit itself
        if (p.picked !== SPILL && p.picked !== defaultAccountId(reg)) {
          expect(eligible(reg, cache, p.picked, NOW), ctx).toBe(true)
          expect(reg.accounts[p.picked].mode?.kind, ctx).not.toBe('paused')
          const b = reserveBudget(reg, cache, p.picked, NOW)
          if (b?.known) expect(b.open, ctx).toBe(true)
        }
        const coolDrain = Object.keys(reg.accounts).filter((id) => {
          const a = reg.accounts[id]
          const s = hasSessionLimit(a) ? (cache.samples[id].s ?? 0) : 0
          return a.mode?.kind === 'drain' && eligible(reg, cache, id, NOW) && s < SESSION_SOFT_MAX
        })
        if (coolDrain.length) expect(p, ctx).toMatchObject({ reason: 'drain' })
        if (coolDrain.length) expect(coolDrain, ctx).toContain(p.picked)
        expect(pick(reg, cache, lane, NOW), ctx).toEqual(p)
        const order = rank({ reg, cache, lane, nowMs: NOW })
        expect(rank({ reg, cache, lane, nowMs: NOW }), ctx).toEqual(order)
        if (p.picked !== SPILL && p.reason !== 'interactive-fallback') expect(order[0]?.account, ctx).toBe(p.picked)
        for (const e of order) expect(reg.accounts[e.account].mode?.kind, ctx).not.toBe('paused')
      }
    }
  })
  test('a hold: account reserve is never ranked before an open account that is not a reserve', () => {
    let held = 0
    for (let seed = 1; seed <= 400; seed++) {
      const { reg, cache } = world(seed)
      for (const lane of LANES) {
        const order = rank({ reg, cache, lane, nowMs: NOW }).map((e) => e.account)
        const ctx = `seed ${seed} lane ${lane} order ${order.join(',')}`
        const holders = order.filter((id) => {
          const m = reg.accounts[id].mode
          return m?.kind === 'reserve' && reserveHold(m) === 'account'
        })
        if (!holders.length) continue
        held++
        const firstHolder = Math.min(...holders.map((id) => order.indexOf(id)))
        const openPlain = Object.keys(reg.accounts).filter(
          (id) => reg.accounts[id].mode?.kind !== 'reserve' && eligible(reg, cache, id, NOW),
        )
        for (const id of openPlain) {
          expect(order.indexOf(id), ctx).toBeGreaterThanOrEqual(0)
          expect(order.indexOf(id), ctx).toBeLessThan(firstHolder)
        }
      }
    }
    expect(held).toBeGreaterThan(50)
  })
})
