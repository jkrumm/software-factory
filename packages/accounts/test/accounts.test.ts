import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERBS, helpText, verbHelp } from '../src/cli.ts'
import {
  type Cache,
  type HttpGet,
  type Registry,
  type Sample,
  type SpawnResult,
  type Spawner,
  accountFromConfigDir,
  boundedSpawnSync,
  claimRefresh,
  dueIds,
  emptyCache,
  homeIds,
  loadCache,
  markExhausted,
  mergeSample,
  newestAge,
  pick,
  rank,
  fableAccount,
  sessionAccount,
  pickLine,
  recordSample,
  refreshBeforePick,
  refreshEnv,
  releaseClaim,
  runRefresh,
  isSample,
  loadRegistry,
  sampleFromClaudeJson,
  sampleFromOAuthUsage,
  saveSample,
  setAuthFailed,
  markVerified,
  readVerified,
  shellLine,
  keychainService,
  tokenFromCredentials,
  oauthUsageHeaders,
  latestSessionId,
  expiryFromCredentials,
  tierFromCredentials,
  planFromTier,
  accountUnits,
  hasSessionLimit,
  planTier,
  withoutSessionWindows,
  SESSION_MAX,
  SESSION_SOFT_MAX,
  gradeLogin,
  readLoginExpiry,
  askRelogins,
  reloginCandidates,
  RELOGIN_ASK_INTERVAL_MS,
  RELOGIN_CAP_INTERVAL_MS,
  type LoginRow,
  type RefreshResult,
} from '../src/index.ts'

const NOW = 1_800_000_000_000
const H = 3600
const reg = (bEnabled = true): Registry => ({
  accounts: {
    iu: {
      dir: null,
      plan: 'max20x',
      units: { session: 4, weekly: 2 },
      homeLanes: ['interactive', 'headless'],
      enabled: true,
    },
    me: {
      dir: '/home/x/.claude-me',
      plan: 'max5x',
      units: { session: 1, weekly: 1 },
      homeLanes: ['bulk'],
      enabled: bEnabled,
    },
  },
})
const sample = (s: number, w: number, o: { age?: number; wReset?: number } = {}): Sample => ({
  s,
  w,
  s_reset: NOW / 1000 + 3 * H,
  w_reset: o.wReset ?? NOW / 1000 + 100 * H,
  s_ts: NOW - (o.age ?? 60_000),
  w_ts: NOW - (o.age ?? 60_000),
  src: 't',
})
const cacheOf = (a?: Sample, b?: Sample): Cache => ({
  ...emptyCache(),
  samples: { ...(a ? { iu: a } : {}), ...(b ? { me: b } : {}) },
})
const tmp = () => mkdtempSync(join(tmpdir(), 'ca-'))
const staleA = () => cacheOf(sample(10, 10, { age: 11 * 60_000 }))

describe('pick rule v1.1 pace guard', () => {
  const D = 24 * H
  const iuOver = sample(10, 88, { wReset: NOW / 1000 + 3.9 * D }) // pace 44
  const meCalm = sample(10, 2, { wReset: NOW / 1000 + 6.5 * D }) // pace 7
  test('over-pace home yields to an under-pace other, every lane', () => {
    expect(pick(reg(), cacheOf(iuOver, meCalm), 'interactive', NOW)).toMatchObject({ picked: 'me', reason: 'pace' })
    expect(pick(reg(), cacheOf(iuOver, meCalm), 'headless', NOW)).toMatchObject({ picked: 'me', reason: 'pace' })
  })
  test('both over pace -> home', () => {
    const meOver = sample(10, 60, { wReset: NOW / 1000 + 6.5 * D })
    expect(pick(reg(), cacheOf(iuOver, meOver), 'interactive', NOW)).toMatchObject({ picked: 'iu', reason: 'home' })
  })
  test('other ineligible -> home', () => {
    expect(
      pick(reg(), cacheOf(iuOver, sample(95, 2, { wReset: NOW / 1000 + 6.5 * D })), 'interactive', NOW),
    ).toMatchObject({ picked: 'iu', reason: 'home' })
  })
  test('home without a weekly reset is never over pace', () => {
    expect(pick(reg(), cacheOf({ ...sample(10, 88), w_reset: null }, meCalm), 'interactive', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'home',
    })
  })
  test('bulk lane already on me is unaffected', () => {
    expect(pick(reg(), cacheOf(iuOver, meCalm), 'bulk', NOW)).toMatchObject({ picked: 'me', reason: 'home' })
  })
  test('expiring capacity still wins for bulk lanes', () => {
    expect(pick(reg(), cacheOf(iuOver, sample(10, 2, { wReset: NOW / 1000 + 5 * H })), 'bulk', NOW)).toMatchObject({
      picked: 'me',
      reason: 'expiring-capacity',
    })
  })
})

// ── rule v1.4: N accounts. `me` and `me2` share the bulk lanes; units come from the plan (no `units` in this registry). ──
const reg3 = (): Registry => ({
  accounts: {
    iu: { dir: null, plan: 'max20x', homeLanes: ['interactive', 'headless'], enabled: true },
    me: { dir: '/home/x/.claude-me', plan: 'max5x', homeLanes: ['bulk'], enabled: true },
    me2: { dir: '/home/x/.claude-me2', plan: 'max5x', homeLanes: ['bulk'], enabled: true },
  },
})
const cache3 = (iu?: Sample, me?: Sample, me2?: Sample): Cache => ({
  ...emptyCache(),
  samples: { ...(iu ? { iu } : {}), ...(me ? { me } : {}), ...(me2 ? { me2 } : {}) },
})

describe('Fable mode: the fable account is the last resort', () => {
  const fable = (): Registry => ({ ...reg3(), fable: 'me2' })
  const all = () => cache3(sample(10, 10), sample(10, 10), sample(5, 5, { wReset: NOW / 1000 + 2 * H }))
  test('no lane picks it while another account is eligible', () => {
    for (const lane of ['interactive', 'headless', 'bulk', 'batch'])
      expect(pick(fable(), all(), lane, NOW).picked).not.toBe('me2')
    // without Fable mode the expiring me2 window would have won the bulk pick
    expect(pick(reg3(), all(), 'bulk', NOW)).toMatchObject({ picked: 'me2', reason: 'expiring-capacity' })
  })
  test('it takes the work once nothing else is eligible', () => {
    const c = cache3(sample(95, 10), sample(95, 10), sample(10, 10))
    expect(pick(fable(), c, 'bulk', NOW)).toMatchObject({ picked: 'me2', reason: 'fable-reserve' })
    expect(pick(fable(), c, 'interactive', NOW)).toMatchObject({ picked: 'me2', reason: 'fable-reserve' })
  })
  test('rank lists it last', () => {
    expect(
      rank({ reg: fable(), cache: all(), lane: 'bulk', nowMs: NOW })
        .map((e) => e.account)
        .at(-1),
    ).toBe('me2')
  })
  test('cf account: the fable account, else the default', () => {
    expect(fableAccount(fable())).toBe('me2')
    expect(fableAccount(reg3())).toBe('iu')
    const off = fable()
    off.accounts.me2.enabled = false
    expect(fableAccount(off)).toBe('iu')
  })
  test('loadRegistry rejects an unknown fable id and keeps a valid one', () => {
    const d = tmp(),
      f = join(d, 'r.json')
    writeFileSync(f, JSON.stringify({ ...reg3(), fable: 'nope' }))
    expect(() => loadRegistry(f)).toThrow(/fable/)
    writeFileSync(f, JSON.stringify(fable()))
    expect(loadRegistry(f).fable).toBe('me2')
    rmSync(d, { recursive: true })
  })
})

describe('Drain mode: the drain accounts are filled first, to the wall', () => {
  const D = 24 * H
  const drain = (): Registry => ({ ...reg3(), drain: ['me2'] })
  const both = (): Registry => ({ ...reg3(), fable: 'iu', drain: ['me2'] })
  // me2 far over pace (91 % with 3.5 days left), me fresh, iu fresh
  const c = (me2: Sample) =>
    cache3(sample(10, 12, { wReset: NOW / 1000 + 6.4 * D }), sample(0, 0, { wReset: NOW / 1000 + 7 * D - H }), me2)
  const me2Over = sample(10, 91, { wReset: NOW / 1000 + 3.5 * D })
  test('every lane picks the drain account while its 5h window is cool, pace and expiring capacity notwithstanding', () => {
    for (const lane of ['interactive', 'headless', 'bulk', 'lead'])
      expect(pick(drain(), c(me2Over), lane, NOW)).toMatchObject({ picked: 'me2', reason: 'drain' })
    const meExpiring = cache3(sample(10, 12), sample(10, 50, { wReset: NOW / 1000 + 5 * H }), me2Over)
    expect(pick(drain(), meExpiring, 'bulk', NOW)).toMatchObject({ picked: 'me2', reason: 'drain' })
  })
  test('its weekly ceiling is 100: 99 % still drains, 100 % is the wall', () => {
    expect(pick(drain(), c(sample(10, 99, { wReset: NOW / 1000 + 3.5 * D })), 'bulk', NOW)).toMatchObject({
      picked: 'me2',
      reason: 'drain',
    })
    expect(pick(drain(), c(sample(10, 100, { wReset: NOW / 1000 + 3.5 * D })), 'bulk', NOW).picked).not.toBe('me2')
    // without drain mode the same 96 % account is over the 95 ceiling
    expect(pick(reg3(), c(sample(10, 96, { wReset: NOW / 1000 + 3.5 * D })), 'bulk', NOW).picked).not.toBe('me2')
  })
  test('a hot 5h window hands the work to the plain rule until the window cools', () => {
    expect(pick(drain(), c(sample(SESSION_SOFT_MAX, 91, { wReset: NOW / 1000 + 3.5 * D })), 'bulk', NOW)).toMatchObject(
      { picked: 'me', reason: 'home' },
    )
    expect(
      pick(drain(), c(sample(SESSION_SOFT_MAX - 1, 91, { wReset: NOW / 1000 + 3.5 * D })), 'bulk', NOW).reason,
    ).toBe('drain')
  })
  test('with Fable on iu: drain first, then the rest, iu last', () => {
    expect(pick(both(), c(me2Over), 'interactive', NOW)).toMatchObject({ picked: 'me2', reason: 'drain' })
    const walled = c(sample(10, 100, { wReset: NOW / 1000 + 3.5 * D }))
    expect(pick(both(), walled, 'interactive', NOW)).toMatchObject({ picked: 'me', reason: 'spill' })
    expect(pick(both(), walled, 'lead', NOW).picked).toBe('me')
    expect(rank({ reg: both(), cache: c(me2Over), lane: 'bulk', nowMs: NOW }).map((r) => r.account)).toEqual([
      'me2',
      'me',
      'iu',
    ])
    const meOut = { ...walled, exhausted: { me: NOW / 1000 + 600 } }
    expect(pick(both(), meOut, 'lead', NOW)).toMatchObject({ picked: 'iu', reason: 'fable-reserve' })
  })
  test('loadRegistry: drain names accounts and never the fable one', () => {
    const d = tmp(),
      f = join(d, 'r.json')
    writeFileSync(f, JSON.stringify({ ...reg3(), drain: ['nope'] }))
    expect(() => loadRegistry(f)).toThrow(/drain/)
    writeFileSync(f, JSON.stringify({ ...reg3(), drain: 'me2' }))
    expect(() => loadRegistry(f)).toThrow(/drain/)
    writeFileSync(f, JSON.stringify({ ...reg3(), fable: 'me2', drain: ['me2'] }))
    expect(() => loadRegistry(f)).toThrow(/both/)
    writeFileSync(f, JSON.stringify(both()))
    expect(loadRegistry(f)).toMatchObject({ fable: 'iu', drain: ['me2'] })
    rmSync(d, { recursive: true })
  })
})

describe('pick rule v1.4: N accounts', () => {
  const D = 24 * H
  const iu = sample(10, 10)
  test('units default from the plan; a present units block is still validated', () => {
    expect(accountUnits(reg3().accounts.iu)).toEqual({ session: 4, weekly: 2 })
    expect(accountUnits(reg3().accounts.me)).toEqual({ session: 1, weekly: 1 })
    expect(accountUnits({ ...reg3().accounts.me, units: { session: 3, weekly: 5 } })).toEqual({ session: 3, weekly: 5 })
    const d = tmp()
    const file = join(d, 'r.json')
    writeFileSync(file, JSON.stringify(reg3()))
    expect(Object.keys(loadRegistry(file).accounts)).toEqual(['iu', 'me', 'me2'])
    writeFileSync(
      file,
      JSON.stringify({ accounts: { ...reg3().accounts, me: { ...reg3().accounts.me, units: { session: '4' } } } }),
    )
    expect(() => loadRegistry(file)).toThrow(/malformed/)
    rmSync(d, { recursive: true })
  })
  test('home: of several accounts claiming the lane, the one with the most weekly headroom', () => {
    expect(pick(reg3(), cache3(iu, sample(10, 80), sample(10, 10)), 'bulk', NOW)).toMatchObject({
      picked: 'me2',
      reason: 'home',
    })
    expect(pick(reg3(), cache3(iu, sample(10, 10), sample(10, 80)), 'bulk', NOW)).toMatchObject({
      picked: 'me',
      reason: 'home',
    })
    expect(pick(reg3(), cache3(iu, sample(10, 10), sample(10, 10)), 'bulk', NOW)).toMatchObject({
      picked: 'me',
      reason: 'home',
    }) // tie: registry order
  })
  test('an exhausted or ineligible home hands over to its sibling before iu', () => {
    const c = { ...cache3(iu, sample(10, 10), sample(10, 30)), exhausted: { me: NOW / 1000 + 600 } }
    expect(pick(reg3(), c, 'bulk', NOW)).toMatchObject({ picked: 'me2', reason: 'home' })
    expect(
      pick(reg3(), { ...c, exhausted: { me: NOW / 1000 + 600, me2: NOW / 1000 + 600 } }, 'bulk', NOW),
    ).toMatchObject({ picked: 'iu', reason: 'spill' })
    expect(pick(reg3(), { ...cache3(iu, sample(95, 10), sample(10, 30)) }, 'bulk', NOW)).toMatchObject({
      picked: 'me2',
      reason: 'home',
    })
  })
  test('headroom is scaled by the weekly units: a 20x account with the same percent has twice the room', () => {
    // lane without a home -> step 5, the most headroom: iu (95-50)*2 = 90, me (95-30)*1 = 65, me2 (95-40)*1 = 55
    expect(pick(reg3(), cache3(sample(10, 50), sample(10, 30), sample(10, 40)), 'nope', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'spill',
    })
    expect(pick(reg3(), cache3(sample(10, 70), sample(10, 30), sample(10, 40)), 'nope', NOW)).toMatchObject({
      picked: 'me',
      reason: 'spill',
    }) // iu (95-70)*2 = 50
  })
  test('v1.7: a spill draw skips an over-pace account while a calmer one is eligible, and falls back when all are over pace', () => {
    const D = 24 * H
    const iuCalm = sample(10, 5, { wReset: NOW / 1000 + 6.7 * D }) // pace 4
    const meFull = sample(10, 96) // over WEEKLY_MAX: not eligible
    const me2Over = sample(10, 70, { wReset: NOW / 1000 + 100 * H }) // pace 40: 30 points over
    const last = () => 0.99 // the draw lands on the last candidate: me2 unless it is filtered out
    expect(pick(reg3(), cache3(iuCalm, meFull, me2Over), 'lead', NOW, last)).toMatchObject({
      picked: 'iu',
      reason: 'spill',
    })
    const iuOver = sample(10, 70, { wReset: NOW / 1000 + 6.7 * D })
    expect(pick(reg3(), cache3(iuOver, meFull, me2Over), 'lead', NOW, last)).toMatchObject({
      picked: 'me2',
      reason: 'spill',
    })
  })
  test('v1.8: an expiring window is drained to the end: no 70 % cap on expiring capacity, ceiling 100 in the last 3 h', () => {
    const iuLate = sample(10, 90, { wReset: NOW / 1000 + 10 * H })
    const meBusy = sample(10, 50)
    expect(pick(reg3(), cache3(iuLate, meBusy, sample(10, 50)), 'bulk', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'expiring-capacity',
    })
    const iuFinal = (w: number) => cache3(sample(10, w, { wReset: NOW / 1000 + 2 * H }), sample(10, 50), sample(10, 50))
    expect(pick(reg3(), iuFinal(99), 'bulk', NOW)).toMatchObject({ picked: 'iu', reason: 'expiring-capacity' })
    expect(pick(reg3(), iuFinal(100), 'bulk', NOW).picked).not.toBe('iu')
    // 5 h out the ceiling is still 98
    expect(
      pick(reg3(), cache3(sample(10, 99, { wReset: NOW / 1000 + 5 * H }), sample(10, 50), sample(10, 50)), 'bulk', NOW)
        .picked,
    ).not.toBe('iu')
  })
  test('5h boundary: a bulk lane leaves a sibling at SESSION_SOFT_MAX for iu and returns once a fresh sample shows the new window', () => {
    const calm = (s: number) => cache3(sample(70, 10), sample(10, 96), sample(s, 5)) // me over WEEKLY_MAX; iu's 5h within SESSION_MARGIN of me2, so no session move
    expect(pick(reg3(), calm(SESSION_SOFT_MAX - 1), 'bulk', NOW)).toMatchObject({ picked: 'me2', reason: 'home' })
    expect(pick(reg3(), calm(SESSION_SOFT_MAX), 'bulk', NOW)).toMatchObject({ picked: 'iu', reason: 'spill' })
    expect(pick(reg3(), calm(SESSION_MAX), 'bulk', NOW)).toMatchObject({ picked: 'iu', reason: 'spill' })
    expect(pick(reg3(), calm(100), 'bulk', NOW)).toMatchObject({ picked: 'iu', reason: 'spill' })
    expect(pick(reg3(), calm(2), 'bulk', NOW)).toMatchObject({ picked: 'me2', reason: 'home' }) // window reset: back home
  })
  test('past SESSION_SOFT_MAX an account is still used when it is the last one open', () => {
    const hotAll = (me2: number) => cache3(sample(85, 10), sample(10, 96), sample(me2, 5))
    expect(pick(reg3(), hotAll(SESSION_MAX - 1), 'bulk', NOW)).toMatchObject({ picked: 'me2', reason: 'home' })
    expect(pick(reg3(), hotAll(SESSION_MAX), 'bulk', NOW)).toMatchObject({ picked: 'iu', reason: 'spill' })
  })
  test('a missing weekly window counts as full headroom', () => {
    const noWeekly: Sample = { ...sample(10, 0), w: null, w_reset: null, w_ts: null }
    const full = (w: number) => sample(10, w, { wReset: NOW / 1000 + 7 * D }) // a missing window is weighed as a full week away
    expect(pick(reg3(), cache3(iu, noWeekly, full(5)), 'bulk', NOW)).toMatchObject({ picked: 'me', reason: 'home' }) // 95 > 90
    expect(pick(reg3(), cache3(iu, full(5), noWeekly), 'bulk', NOW)).toMatchObject({ picked: 'me2', reason: 'home' })
    expect(pick(reg3(), cache3(iu, noWeekly, full(0)), 'bulk', NOW)).toMatchObject({ picked: 'me', reason: 'home' }) // 95 = 95: registry order
  })
  test('pace step: the calm alternative with the most headroom', () => {
    const iuOver = sample(10, 88, { wReset: NOW / 1000 + 3.9 * D }) // pace 44
    const calm = (w: number) => sample(10, w, { wReset: NOW / 1000 + 3.5 * D }) // pace 50
    expect(pick(reg3(), cache3(iuOver, calm(40), calm(20)), 'interactive', NOW)).toMatchObject({
      picked: 'me2',
      reason: 'pace',
    })
    expect(pick(reg3(), cache3(iuOver, calm(20), calm(40)), 'interactive', NOW)).toMatchObject({
      picked: 'me',
      reason: 'pace',
    })
    // an over-pace sibling is skipped even with more headroom on paper
    const over = sample(10, 70, { wReset: NOW / 1000 + 6.5 * D }) // pace 7
    expect(pick(reg3(), cache3(iuOver, over, calm(60)), 'interactive', NOW)).toMatchObject({
      picked: 'me2',
      reason: 'pace',
    })
  })
  test('session step: the alternative with the emptiest 5h, ties by headroom', () => {
    expect(pick(reg3(), cache3(sample(60, 10), sample(30, 10), sample(5, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'me2',
      reason: 'session',
    })
    expect(pick(reg3(), cache3(sample(60, 10), sample(5, 10), sample(30, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'me',
      reason: 'session',
    })
    expect(pick(reg3(), cache3(sample(60, 10), sample(5, 40), sample(5, 20)), 'interactive', NOW)).toMatchObject({
      picked: 'me2',
      reason: 'session',
    }) // equal 5h -> more headroom
    expect(pick(reg3(), cache3(sample(60, 10), sample(5, 20), sample(5, 20)), 'interactive', NOW)).toMatchObject({
      picked: 'me',
      reason: 'session',
    }) // full tie -> registry order
    expect(pick(reg3(), cache3(sample(60, 10), sample(5, 50), sample(5.5, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'me',
      reason: 'session',
    }) // emptiest 5h beats headroom
  })
  test('a session alternative must still pass the margin test', () => {
    expect(pick(reg3(), cache3(sample(30, 10), sample(15, 10), sample(12, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'home',
    })
  })
})

describe('pick rule v1.5: expiry-weighted sharing', () => {
  const D = 24 * H
  const iu = sample(10, 10)
  // me2 resets in 3 days at 67 %, me in 7 days at 11 %: the sooner reset weighs more, the later one still gets a real share
  const me = sample(10, 11, { wReset: NOW / 1000 + 7 * D })
  const me2 = sample(10, 67, { wReset: NOW / 1000 + 3 * D })
  test('deterministic mode takes the account whose spare capacity is most urgent', () => {
    expect(pick(reg3(), cache3(iu, me, me2), 'bulk', NOW)).toMatchObject({ picked: 'me2', reason: 'home' })
    // same spare, later reset: the sooner one still wins
    expect(
      pick(
        reg3(),
        cache3(iu, sample(10, 40, { wReset: NOW / 1000 + 6 * D }), sample(10, 40, { wReset: NOW / 1000 + 2 * D })),
        'bulk',
        NOW,
      ).picked,
    ).toBe('me2')
  })
  test('with an rng the siblings share the work in proportion to their weights, not winner-takes-all', () => {
    const n = 2000
    const picks = Array.from(
      { length: n },
      (_, i) => pick(reg3(), cache3(iu, me, me2), 'bulk', NOW, () => (i + 0.5) / n).picked,
    )
    const share = picks.filter((p) => p === 'me2').length / n
    expect(share).toBeGreaterThan(0.4)
    expect(share).toBeLessThan(0.65)
    expect(picks.every((p) => p === 'me' || p === 'me2')).toBe(true) // iu is not a home of the bulk lanes
  })
  test('a session-hot sibling drops out of the draw, the cool sibling is home, not an outsider', () => {
    const hot = sample(85, 11, { wReset: NOW / 1000 + 7 * D })
    const calm = sample(15, 67, { wReset: NOW / 1000 + 3 * D })
    expect(pick(reg3(), cache3(sample(2, 10), hot, calm), 'bulk', NOW, () => 0)).toMatchObject({
      picked: 'me2',
      reason: 'home',
    })
  })
  test('N accounts: a fourth subscription joins from the registry alone', () => {
    const r: Registry = {
      accounts: {
        ...reg3().accounts,
        me3: { dir: '/home/x/.claude-me3', plan: 'max5x', homeLanes: ['bulk'], enabled: true },
      },
    }
    const c: Cache = {
      ...cache3(iu, me, me2),
      samples: { ...cache3(iu, me, me2).samples, me3: sample(10, 30, { wReset: NOW / 1000 + 4 * D }) },
    } // outside the 72 h expiring horizon, so the weights share
    expect(pick(r, c, 'bulk', NOW)).toMatchObject({ picked: 'me3' })
    const seen = new Set(Array.from({ length: 200 }, (_, i) => pick(r, c, 'bulk', NOW, () => (i + 0.5) / 200).picked))
    expect(seen).toEqual(new Set(['me', 'me2', 'me3']))
  })
  test('weight edge cases: no weekly reset, a reset already past, plan spelling', () => {
    const wk = (o: Partial<Sample>) => ({ ...sample(10, 50, { wReset: NOW / 1000 + 7 * D }), ...o })
    // 168 h fallback: w set, w_reset null weighs like a reset a full week away
    expect(pick(reg3(), cache3(iu, wk({ w_reset: null }), wk({})), 'bulk', NOW).picked).toBe('me')
    // reset passed: judged as a fresh week (95 spare), not as the stale 50 %-used sample nor a 1 h rush
    expect(pick(reg3(), cache3(iu, wk({ w: 90, w_reset: NOW / 1000 - 60 }), wk({ w: 60 })), 'bulk', NOW).picked).toBe(
      'me',
    )
    const a = (plan: string) => accountUnits({ dir: null, plan, homeLanes: [], enabled: true })
    expect(a(' Max10x ')).toEqual(a('max10x'))
    expect(a('max40x')).toEqual({ session: 8, weekly: 1 + 7 / 3 })
  })
  test('units follow any maxNx plan, an explicit block still wins', () => {
    const a = (plan: string, units?: { session: number; weekly: number }) =>
      accountUnits({ dir: null, plan, units, homeLanes: [], enabled: true })
    expect(a('max5x')).toEqual({ session: 1, weekly: 1 })
    expect(a('max20x')).toEqual({ session: 4, weekly: 2 })
    expect(a('max10x').session).toBe(2)
    expect(a('max10x').weekly).toBeCloseTo(4 / 3)
    expect(a('pro')).toEqual({ session: 1, weekly: 1 })
    expect(a('max20x', { session: 9, weekly: 9 })).toEqual({ session: 9, weekly: 9 })
  })
})

describe('sessionAccount', () => {
  const line = (session: string, account: string | null) =>
    JSON.stringify({ event: 'session_env', data: { session, account } })
  test('newest session_env line for the session wins; unknown and malformed ids give null', () => {
    const d = tmp()
    writeFileSync(join(d, '2026-10-23.jsonl'), `${line('abc-1', 'iu')}\n`)
    writeFileSync(join(d, '2026-10-24.jsonl'), `${line('abc-1', 'me')}\nnot json\n${line('zzz-9', 'iu')}\n`)
    expect(sessionAccount('abc-1', d)).toBe('me')
    expect(sessionAccount('zzz-9', d)).toBe('iu')
    expect(sessionAccount('nope-0', d)).toBeNull()
    expect(sessionAccount('../x', d)).toBeNull()
    expect(sessionAccount('abc-1', join(d, 'missing'))).toBeNull()
  })
  test('a newer line without an account wins over an older account (resumed on the default dir)', () => {
    const d = tmp()
    writeFileSync(join(d, '2026-10-23.jsonl'), `${line('abc-1', 'me')}\n`)
    writeFileSync(join(d, '2026-10-24.jsonl'), `${line('abc-1', null)}\n`)
    expect(sessionAccount('abc-1', d)).toBeNull()
  })
})

describe('latestSessionId', () => {
  test("newest transcript by mtime in the cwd's project dir; encoding, missing dir and non-transcripts", () => {
    const projects = tmp()
    const cwd = '/Users/x/.herdr/worktrees/my_repo.v2'
    const d = join(projects, '-Users-x--herdr-worktrees-my-repo-v2')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'aaaa-1.jsonl'), '')
    writeFileSync(join(d, 'bbbb-2.jsonl'), '')
    writeFileSync(join(d, 'notes.txt'), '')
    utimesSync(join(d, 'aaaa-1.jsonl'), 2000, 2000)
    utimesSync(join(d, 'bbbb-2.jsonl'), 1000, 1000)
    utimesSync(join(d, 'notes.txt'), 9000, 9000)
    expect(latestSessionId(projects, cwd)).toBe('aaaa-1')
    expect(latestSessionId(projects, '/nowhere')).toBeNull()
    rmSync(projects, { recursive: true })
  })
})

describe('latestSessionId vanished entries', () => {
  test('a transcript that disappears between readdir and stat is skipped, the others still count', () => {
    const projects = tmp()
    const d = join(projects, '-work-x')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'live-1.jsonl'), '')
    utimesSync(join(d, 'live-1.jsonl'), 1000, 1000)
    symlinkSync(join(d, 'gone-target'), join(d, 'dead-2.jsonl')) // listed by readdir, stat throws ENOENT
    expect(latestSessionId(projects, '/work/x')).toBe('live-1')
    rmSync(projects, { recursive: true })
  })
})

describe('login expiry', () => {
  const D = 86400_000
  const item = (refresh: number | undefined, access = NOW + 5 * H * 1000) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'SECRET-A',
        refreshToken: 'SECRET-R',
        expiresAt: access,
        ...(refresh === undefined ? {} : { refreshTokenExpiresAt: refresh }),
        scopes: ['x'],
      },
    })
  const fake =
    (byService: Record<string, SpawnResult>): Spawner =>
    (_cmd, a) =>
      byService[a[2]] ?? { status: 44, stdout: '', stderr: 'could not be found' }
  const ok = (stdout: string): SpawnResult => ({ status: 0, stdout, stderr: '' })
  const rows = (iu: SpawnResult, me?: SpawnResult) =>
    readLoginExpiry({
      reg: reg(),
      spawn: fake({ [keychainService(null)]: iu, ...(me ? { [keychainService('/home/x/.claude-me')]: me } : {}) }),
      baseEnv: {},
      now: NOW,
    })

  test('expiryFromCredentials reads only the two timestamps; anything else is null', () => {
    expect(expiryFromCredentials(item(NOW + D))).toEqual({
      refreshTokenExpiresAt: NOW + D,
      expiresAt: NOW + 5 * H * 1000,
    })
    expect(expiryFromCredentials(item(undefined))).toEqual({
      refreshTokenExpiresAt: null,
      expiresAt: NOW + 5 * H * 1000,
    })
    expect(
      expiryFromCredentials(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 'soon', expiresAt: -1 } })),
    ).toEqual({ refreshTokenExpiresAt: null, expiresAt: null })
    expect(expiryFromCredentials('not json')).toBeNull()
    expect(expiryFromCredentials('{}')).toBeNull()
  })
  test('gradeLogin: PASS > 7 d, WARN <= 7 d, FAIL <= 2 d or past, unknown = WARN', () => {
    expect(gradeLogin(NOW + 7 * D + 1, NOW)).toBe('PASS')
    expect(gradeLogin(NOW + 7 * D, NOW)).toBe('WARN')
    expect(gradeLogin(NOW + 2 * D + 1, NOW)).toBe('WARN')
    expect(gradeLogin(NOW + 2 * D, NOW)).toBe('FAIL')
    expect(gradeLogin(NOW - 1, NOW)).toBe('FAIL')
    expect(gradeLogin(null, NOW)).toBe('WARN')
  })
  test('rows per enabled account, with days left and the expired flag', () => {
    const r = rows(ok(item(NOW + 20 * D)), ok(item(NOW - 3 * D)))
    expect(r.map((x) => [x.id, x.grade, x.expired, x.days_left])).toEqual([
      ['iu', 'PASS', false, 20],
      ['me', 'FAIL', true, -3],
    ])
    expect(r[1].detail).toContain('expired')
    expect(
      readLoginExpiry({
        reg: reg(false),
        spawn: fake({ [keychainService(null)]: ok(item(NOW + D)) }),
        baseEnv: {},
        now: NOW,
      }).map((x) => x.id),
    ).toEqual(['iu']) // a disabled account is not graded
  })
  test('default and severity: a non-default account never reaches FAIL, the default keeps it', () => {
    const r = rows(ok(item(NOW + D)), ok(item(NOW + D)))
    expect(r.map((x) => [x.id, x.default, x.grade, x.severity])).toEqual([
      ['iu', true, 'FAIL', 'FAIL'],
      ['me', false, 'FAIL', 'WARN'],
    ])
    const e = rows({ status: 44, stdout: '', stderr: 'x' }, ok(item(NOW - D)))
    expect(e.map((x) => [x.id, x.grade, x.severity])).toEqual([
      ['iu', 'WARN', 'WARN'],
      ['me', 'FAIL', 'WARN'],
    ])
  })
  test('an unreadable or foreign item is a WARN, never a FAIL, and never echoes the item', () => {
    const r = rows({ status: 44, stdout: '', stderr: 'could not be found' }, ok(item(undefined)))
    expect(r.map((x) => [x.id, x.grade, x.days_left, x.expired])).toEqual([
      ['iu', 'WARN', null, false],
      ['me', 'WARN', null, false],
    ])
    expect(rows(ok('garbage SECRET-A'))[0].detail).not.toContain('SECRET')
    expect(JSON.stringify(rows(ok(item(NOW + 3 * D))))).not.toContain('SECRET')
    expect(
      rows({ status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT', message: 'timed out' } })[0],
    ).toMatchObject({ grade: 'WARN', refresh_expires_at: null })
  })

  const tiered = (tier: unknown, refresh: number | null = NOW + 20 * D) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'SECRET-A',
        refreshToken: 'SECRET-R',
        expiresAt: NOW + H * 1000,
        ...(refresh === null ? {} : { refreshTokenExpiresAt: refresh }),
        rateLimitTier: tier,
      },
    })
  test('planFromTier parses the Max multiple; anything else is null', () => {
    expect(planFromTier('default_claude_max_20x')).toBe('ultra')
    expect(planFromTier('default_claude_max_5x')).toBe('max')
    expect(planFromTier('default_claude_pro')).toBeNull()
    expect(planFromTier('default_raven')).toBeNull()
    expect(planFromTier(null)).toBeNull()
    expect(tierFromCredentials(tiered('default_claude_max_5x'))).toBe('default_claude_max_5x')
    expect(tierFromCredentials(tiered(7))).toBeNull()
    expect(tierFromCredentials(tiered('x'.repeat(65)))).toBeNull()
    expect(tierFromCredentials('not json')).toBeNull()
    expect(tierFromCredentials(item(NOW + D))).toBeNull() // no tier in the item
  })
  test('rows carry the raw tier and the detected plan, never a token field', () => {
    const r = rows(ok(tiered('default_claude_max_20x')), ok(tiered('default_claude_max_5x')))
    expect(r.map((x) => [x.id, x.tier, x.plan_detected])).toEqual([
      ['iu', 'default_claude_max_20x', 'ultra'],
      ['me', 'default_claude_max_5x', 'max'],
    ])
    expect(JSON.stringify(r)).not.toContain('SECRET')
    expect(rows(ok(item(NOW + 3 * D)))[0]).toMatchObject({ tier: null, plan_detected: null }) // no tier -> undetectable
    expect(rows(ok(tiered('default_claude_pro')))[0]).toMatchObject({ tier: 'default_claude_pro', plan_detected: null })
    expect(rows(ok(tiered('default_claude_max_5x', null)))[0]).toMatchObject({
      grade: 'WARN',
      refresh_expires_at: null,
      plan_detected: 'max',
    }) // unreadable expiry, plan still known
    expect(rows({ status: 44, stdout: '', stderr: 'x' })[0]).toMatchObject({ tier: null, plan_detected: null })
  })
  test('ids select accounts even when disabled (a first login), instead of the enabled set', () => {
    const spawn = fake({
      [keychainService('/home/x/.claude-me')]: ok(tiered('default_claude_max_5x')),
      [keychainService(null)]: ok(tiered('default_claude_max_20x')),
    })
    const sel = (ids?: string[]) =>
      readLoginExpiry({ reg: reg(false), spawn, baseEnv: {}, now: NOW, ids }).map((x) => x.id)
    expect(sel()).toEqual(['iu'])
    expect(sel(['me'])).toEqual(['me'])
    expect(sel(['iu', 'me'])).toEqual(['iu', 'me'])
    expect(sel([])).toEqual([])
  })
})

describe('re-login asks', () => {
  const D = 86400_000
  const row = (id: string, grade: LoginRow['grade'], over: Partial<LoginRow> = {}): LoginRow => ({
    id,
    default: id === 'iu',
    grade,
    severity: grade,
    refresh_expires_at: NOW + 20 * D,
    access_expires_at: NOW + H * 1000,
    days_left: 20,
    expired: false,
    detail: 'x',
    tier: null,
    plan_detected: null,
    ...over,
  })
  const none: Record<string, RefreshResult> = {}

  test('candidates: an auth-failed refresh, or a known login end <= 7 d; PASS and unreadable never ask; one entry per account', () => {
    const logins = [row('iu', 'PASS'), row('me', 'WARN', { days_left: 5, refresh_expires_at: NOW + 5 * D })]
    expect(reloginCandidates(none, logins)).toEqual([{ id: 'me', reason: 'login ends in 5 d' }])
    expect(reloginCandidates({ iu: 'auth-failed' }, [row('iu', 'PASS')])).toEqual([
      { id: 'iu', reason: 'login is dead' },
    ])
    expect(
      reloginCandidates({ me: 'auth-failed' }, [
        row('me', 'FAIL', { expired: true, days_left: -1, refresh_expires_at: NOW - D }),
      ]),
    ).toEqual([{ id: 'me', reason: 'login is dead' }])
    expect(reloginCandidates({ me: 'fresh', iu: 'auth-ok', x: 'stale', y: 'unresolved' }, [])).toEqual([])
    expect(reloginCandidates(none, [row('me', 'WARN', { refresh_expires_at: null, days_left: null })])).toEqual([]) // unreadable proves nothing
    expect(
      reloginCandidates(none, [row('me', 'FAIL', { expired: true, days_left: -2, refresh_expires_at: NOW - 2 * D })]),
    ).toEqual([{ id: 'me', reason: 'login expired' }])
  })
  const warn = (id: string) => row(id, 'WARN', { days_left: 3, refresh_expires_at: NOW + 3 * D })
  const run = (dir: string, now: number, logins: LoginRow[], ask: (id: string) => void, results = none) =>
    askRelogins({ results, logins, now, dir, ask: (c) => ask(c.id) })

  test('repeat suppression: one ask per account per 24 h; another account has its own clock', () => {
    const dir = tmp()
    const asked: string[] = []
    const ask = (id: string) => void asked.push(id)
    expect(run(dir, NOW, [warn('me')], ask).asked).toEqual(['me'])
    expect(run(dir, NOW + RELOGIN_CAP_INTERVAL_MS + 1, [warn('me')], ask).asked).toEqual([]) // an hour later: muted
    expect(run(dir, NOW + RELOGIN_ASK_INTERVAL_MS - 1, [warn('me')], ask).asked).toEqual([])
    expect(run(dir, NOW + RELOGIN_CAP_INTERVAL_MS + 1, [warn('me'), warn('iu')], ask).asked).toEqual(['iu'])
    expect(run(dir, NOW + RELOGIN_ASK_INTERVAL_MS, [warn('me')], ask).asked).toEqual(['me']) // 24 h later: asks again
    expect(asked).toEqual(['me', 'iu', 'me'])
    rmSync(dir, { recursive: true })
  })
  test('cap: one automatic dialog per machine per hour; the deferred account is not muted and is asked next hour', () => {
    const dir = tmp()
    const asked: string[] = []
    const o = run(dir, NOW, [warn('me'), warn('iu')], (id) => void asked.push(id))
    expect(o).toEqual({ asked: ['me'], failed: [], capped: ['iu'] })
    expect(run(dir, NOW + 10 * 60_000, [warn('iu')], (id) => void asked.push(id)).capped).toEqual(['iu']) // still inside the hour
    expect(run(dir, NOW + RELOGIN_CAP_INTERVAL_MS, [warn('iu')], (id) => void asked.push(id)).asked).toEqual(['iu'])
    expect(asked).toEqual(['me', 'iu'])
    rmSync(dir, { recursive: true })
  })
  test('a spawn that throws mutes nothing: the next run retries, and one failure does not stop the other accounts', () => {
    const dir = tmp()
    const logs: string[] = []
    const first = askRelogins({
      results: none,
      logins: [warn('me'), warn('iu')],
      now: NOW,
      dir,
      log: (m) => logs.push(m),
      ask: (c) => {
        if (c.id === 'me') throw new Error('spawn boom')
      },
    })
    expect(first).toEqual({ asked: ['iu'], failed: ['me'], capped: [] })
    expect(logs).toEqual(['re-login ask for me failed: spawn boom'])
    const asked: string[] = []
    // me retries on the next run (stamp and cap were given back by the failure; iu took the cap, so wait an hour)
    expect(
      run(dir, NOW + RELOGIN_CAP_INTERVAL_MS, [warn('me'), warn('iu')], (id) => void asked.push(id)).asked,
    ).toEqual(['me'])
    expect(asked).toEqual(['me'])
    rmSync(dir, { recursive: true })
  })
  test('the claim is exclusive: a concurrent keepalive run cannot ask twice (the stamp is held while the ask runs)', () => {
    const dir = tmp()
    const asked: string[] = []
    const o = askRelogins({
      results: none,
      logins: [warn('me')],
      now: NOW,
      dir,
      ask: (c) => {
        asked.push(c.id)
        // another run starting while the ask is being started sees the claim
        expect(
          askRelogins({
            results: none,
            logins: [warn('me')],
            now: NOW + 1,
            dir,
            ask: (x) => void asked.push(`dup-${x.id}`),
          }).asked,
        ).toEqual([])
      },
    })
    expect(o.asked).toEqual(['me'])
    expect(asked).toEqual(['me'])
    rmSync(dir, { recursive: true })
  })
  test('stamp and cap files are invisible to the quota cache; a corrupt or future stamp does not mute', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'me.relogin-ask.json'), 'garbage')
    expect(run(dir, NOW, [warn('me')], () => {}).asked).toEqual(['me'])
    rmSync(join(dir, 'relogin-ask.cap'))
    writeFileSync(join(dir, 'me.relogin-ask.json'), JSON.stringify({ ts: NOW + 5 * RELOGIN_ASK_INTERVAL_MS }))
    expect(run(dir, NOW, [warn('me')], () => {}).asked).toEqual(['me'])
    expect(loadCache(dir).samples).toEqual({})
    rmSync(dir, { recursive: true })
  })
})

describe('pick rule v1.2 session balance', () => {
  test('home 5h much fuller than the other -> the emptier window', () => {
    expect(pick(reg(), cacheOf(sample(60, 10), sample(5, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'me',
      reason: 'session',
    })
    expect(pick(reg(), cacheOf(sample(5, 10), sample(60, 10)), 'bulk', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'session',
    })
  })
  test('a stale 5h reading never triggers the move', () => {
    const old = { ...sample(5, 10), s_ts: NOW - 7 * H * 1000 }
    expect(pick(reg(), cacheOf(sample(60, 10), old), 'interactive', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'home',
    })
  })
  test('within the margin the home account stays', () => {
    expect(pick(reg(), cacheOf(sample(30, 10), sample(15, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'home',
    })
  })
  test('an over-pace other never receives the session move', () => {
    const meOver = sample(0, 80, { wReset: NOW / 1000 + 6.5 * 24 * H })
    expect(pick(reg(), cacheOf(sample(50, 10), meOver), 'interactive', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'home',
    })
  })
  test("a filling home 5h window overrides the other's weekly pace", () => {
    const meOver = sample(0, 80, { wReset: NOW / 1000 + 6.5 * 24 * H })
    expect(pick(reg(), cacheOf(sample(60, 10), meOver), 'interactive', NOW)).toMatchObject({
      picked: 'me',
      reason: 'session',
    })
  })
})

describe('pick rule v1', () => {
  test('home eligible', () => {
    const c = cacheOf(sample(10, 10), sample(10, 10))
    expect(pick(reg(), c, 'bulk', NOW)).toEqual({ picked: 'me', reason: 'home', stale: false })
    expect(pick(reg(), c, 'interactive', NOW)).toMatchObject({ picked: 'iu', reason: 'home' })
    expect(pick(reg(), c, 'headless', NOW).picked).toBe('iu')
    expect(pick(reg(), c, 'bulk', NOW).picked).toBe('me')
  })
  test('expiring capacity beats home for bulk lanes only', () => {
    const a = sample(10, 40, { wReset: NOW / 1000 + 5 * H })
    expect(pick(reg(), cacheOf(a, sample(10, 10)), 'bulk', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'expiring-capacity',
    })
    expect(pick(reg(), cacheOf(a, sample(10, 10)), 'interactive', NOW).reason).toBe('home')
  })
  test('expiring capacity needs a reset still ahead (any weekly% under the ceiling)', () => {
    expect(
      pick(reg(), cacheOf(sample(10, 75, { wReset: NOW / 1000 + 5 * H }), sample(10, 10)), 'bulk', NOW),
    ).toMatchObject({ picked: 'iu', reason: 'expiring-capacity' })
    expect(
      pick(reg(), cacheOf(sample(10, 40, { wReset: NOW / 1000 - 60 }), sample(10, 10)), 'bulk', NOW),
    ).toMatchObject({ picked: 'me', reason: 'home' })
    expect(
      pick(reg(), cacheOf(sample(10, 40, { wReset: NOW / 1000 + 60 }), sample(10, 10)), 'bulk', NOW),
    ).toMatchObject({ picked: 'iu', reason: 'expiring-capacity' })
  })
  test('spill to the other account when home is over a threshold', () => {
    expect(pick(reg(), cacheOf(sample(10, 10), sample(90, 10)), 'bulk', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'spill',
    })
    expect(pick(reg(), cacheOf(sample(10, 95), sample(10, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'me',
      reason: 'spill',
    })
  })
  test('interactive falls back to a, bulk goes to iu', () => {
    const c = cacheOf(sample(99, 99), sample(99, 99))
    expect(pick(reg(), c, 'interactive', NOW)).toMatchObject({ picked: 'iu', reason: 'interactive-fallback' })
    expect(pick(reg(), c, 'bulk', NOW)).toMatchObject({ picked: 'spill', reason: 'no-eligible-account' })
  })
  test('disabled b is never picked', () => {
    expect(pick(reg(false), cacheOf(sample(10, 10), sample(0, 0)), 'bulk', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'spill',
    })
  })
  test('a stale sample (10 min - 6 h) is used with stale: true, never sends bulk to iu', () => {
    const c = cacheOf(sample(10, 10, { age: 11 * 60_000 }), sample(10, 10))
    expect(pick(reg(), c, 'interactive', NOW)).toMatchObject({ picked: 'iu', reason: 'home', stale: true })
    expect(pick(reg(false), c, 'bulk', NOW)).toMatchObject({ picked: 'iu', reason: 'spill', stale: true })
    expect(
      pick(reg(), cacheOf(sample(10, 10, { age: 5 * H * 1000 }), sample(10, 10, { age: 5 * H * 1000 })), 'bulk', NOW),
    ).toMatchObject({ picked: 'me', reason: 'home', stale: true })
  })
  test('stale sample over a threshold, or older than 6 h, is ineligible', () => {
    expect(pick(reg(false), cacheOf(sample(95, 10, { age: 60 * 60_000 })), 'bulk', NOW).picked).toBe('spill')
    expect(pick(reg(false), cacheOf(sample(10, 10, { age: 7 * H * 1000 })), 'bulk', NOW).picked).toBe('spill')
  })
  test('never-sampled account is ineligible', () => {
    expect(pick(reg(), cacheOf(undefined, sample(10, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'me',
      reason: 'spill',
    })
    expect(pick(reg(), cacheOf(), 'bulk', NOW).picked).toBe('spill')
    expect(pick(reg(), cacheOf(), 'interactive', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'interactive-fallback',
      stale: false,
    })
  })
  test('exhausted mark holds until resets_at', () => {
    const c = { ...cacheOf(sample(10, 10), sample(10, 10)), exhausted: { me: NOW / 1000 + 600 } }
    expect(pick(reg(), c, 'bulk', NOW)).toMatchObject({ picked: 'iu', reason: 'spill' })
    expect(pick(reg(), c, 'bulk', NOW + 601_000)).toMatchObject({ picked: 'me', reason: 'home', stale: true })
  })
  test('auth_failed account is skipped', () => {
    expect(
      pick(reg(), { ...cacheOf(sample(10, 10), sample(10, 10)), auth_failed: { me: true } }, 'bulk', NOW).picked,
    ).toBe('iu')
  })
  test('each window is judged by its own timestamp', () => {
    // s is 7 h old (ignored: unknown), w is fresh and under the threshold -> eligible, stale
    const x: Sample = { ...sample(99, 10), s_ts: NOW - 7 * H * 1000 }
    expect(pick(reg(false), cacheOf(x), 'bulk', NOW)).toMatchObject({ picked: 'iu', stale: true })
    // w is 7 h old, s fresh and over the threshold -> ineligible
    expect(pick(reg(false), cacheOf({ ...sample(95, 10), w_ts: NOW - 7 * H * 1000 }), 'bulk', NOW).picked).toBe('spill')
    // a fresh s next to a 1 h old w: the sample is only as fresh as its stalest window
    expect(pick(reg(false), cacheOf({ ...sample(10, 10), w_ts: NOW - 3_600_000 }), 'bulk', NOW).stale).toBe(true)
  })
  test('home lanes: only accounts claiming the lane are home; headless spills to b rather than counting it home', () => {
    expect(homeIds(reg(), 'headless')).toEqual(['iu'])
    expect(homeIds(reg(), 'bulk')).toEqual(['me'])
    expect(homeIds(reg(), 'nope')).toEqual([])
    expect(pick(reg(), cacheOf(sample(99, 10), sample(10, 10)), 'headless', NOW)).toMatchObject({
      picked: 'me',
      reason: 'spill',
    })
  })
  test('home lanes: a `lane:*` wildcard counts only when no account matches exactly', () => {
    const r: Registry = {
      accounts: { ...reg().accounts, me: { ...reg().accounts.me, homeLanes: ['bulk', 'batch:*'] } },
    }
    expect(homeIds(r, 'batch:nightly')).toEqual(['me'])
    expect(
      homeIds({ accounts: { ...r.accounts, iu: { ...r.accounts.iu, homeLanes: ['batch:nightly'] } } }, 'batch:nightly'),
    ).toEqual(['iu'])
  })
})

describe('helpers', () => {
  test('shellLine quotes the path', () => {
    const r = reg()
    expect(shellLine(r, { picked: 'iu', reason: '', stale: false })).toBe('unset CLAUDE_CONFIG_DIR')
    expect(shellLine(r, { picked: 'me', reason: '', stale: false })).toBe(
      "export CLAUDE_CONFIG_DIR='/home/x/.claude-me'",
    )
    expect(shellLine(r, { picked: 'spill', reason: '', stale: false })).toBeNull()
    r.accounts.me.dir = "/home/x/my dir/it's"
    expect(shellLine(r, { picked: 'me', reason: '', stale: false })).toBe(
      `export CLAUDE_CONFIG_DIR='/home/x/my dir/it'\\''s'`,
    )
  })
  test('accountFromConfigDir', () => {
    expect(accountFromConfigDir(reg(), undefined)).toBe('iu')
    expect(accountFromConfigDir(reg(), '')).toBe('iu')
    expect(accountFromConfigDir(reg(), '/home/x/.claude-me')).toBe('me')
    expect(accountFromConfigDir(reg(), '/somewhere/else')).toBeNull()
  })
  test('refresh env strips credentials and blanks the base url', () => {
    expect(
      refreshEnv(
        {
          ANTHROPIC_API_KEY: 'k',
          ANTHROPIC_AUTH_TOKEN: 't',
          CLAUDE_CODE_OAUTH_TOKEN: 'o',
          CLAUDE_CONFIG_DIR: '/x',
          PATH: '/bin',
        },
        null,
      ),
    ).toEqual({ ANTHROPIC_BASE_URL: '', PATH: '/bin' })
    expect(refreshEnv({}, '/d').CLAUDE_CONFIG_DIR).toBe('/d')
  })
  test('pickLine accounts come from the registry', () => {
    const r = reg()
    r.accounts.c = { ...r.accounts.me }
    const l = pickLine(r, cacheOf(sample(1, 2)), 'bulk', { picked: 'iu', reason: 'home', stale: true }, NOW)
    expect(Object.keys(l).filter((k) => !['ts', 'lane', 'picked', 'reason', 'stale'].includes(k))).toEqual([
      'iu',
      'me',
      'c',
    ])
    expect(l).toMatchObject({ stale: true, iu: { s: 1, w: 2 }, me: { s: null, w: null } })
  })
  test('sampleFromClaudeJson, and a payload that omits a window keeps what we know', () => {
    const blob = (utilization: object) => ({
      cachedUsageUtilization: { fetchedAtMs: NOW, accountUuid: 'u', utilization },
    })
    const full = sampleFromClaudeJson(
      blob({
        five_hour: { utilization: 11, resets_at: '2026-10-24T13:50:00+00:00' },
        seven_day: { utilization: 85, resets_at: '2026-10-28T16:00:00+00:00' },
      }),
    )!
    expect(full).toMatchObject({
      s: 11,
      w: 85,
      s_ts: NOW,
      w_ts: NOW,
      s_reset: Date.parse('2026-10-24T13:50:00Z') / 1000,
    })
    expect(sampleFromClaudeJson({})).toBeNull()
    expect(sampleFromClaudeJson(blob({ five_hour: null, seven_day: null }))).toBeNull()
    const onlyS = sampleFromClaudeJson(
      blob({ five_hour: { utilization: 20, resets_at: '2026-10-24T14:00:00+00:00' }, seven_day: null }),
    )!
    expect(onlyS).toMatchObject({ s: 20, w: null, w_ts: null })
    const merged = mergeSample({ ...full, s_ts: NOW - 5000, w_ts: NOW - 5000 }, onlyS)
    expect(merged).toMatchObject({ s: 20, s_ts: NOW, w: 85, w_ts: NOW - 5000 })
  })
  test('mergeSample: an older window never overwrites a newer one', () => {
    const m = mergeSample(sample(50, 50), { ...sample(1, 1), s_ts: NOW - 120_000, w_ts: NOW - 120_000 })
    expect(m).toMatchObject({ s: 50, w: 50 })
  })
  test('an auth-failed account is retried after the cooldown, in the background only; --ids bypasses it', async () => {
    const stale = (at: number) => ({
      ...cacheOf(sample(1, 1, { age: 11 * 60_000 }), sample(1, 1, { age: 11 * 60_000 })),
      auth_failed: { me: true },
      auth_failed_at: { me: at },
    })
    expect(dueIds(reg(), stale(NOW - 60_000), NOW)).toEqual(['iu']) // marked a minute ago: cooling down
    expect(dueIds(reg(), stale(NOW - 31 * 60_000), NOW)).toEqual(['iu', 'me']) // cooldown over: due again
    expect(dueIds(reg(), stale(NOW - 60_000), NOW, true)).toEqual(['iu', 'me']) // manual retry
    const calls = { sync: [] as string[][], detach: [] as string[][] }
    const run = (c: Cache) =>
      refreshBeforePick({
        reg: reg(),
        lane: 'bulk',
        now: NOW,
        cache: c,
        claim: (ids) => ids,
        runSync: (ids) => {
          calls.sync.push(ids)
        },
        detach: (ids) => {
          calls.detach.push(ids)
        },
      })
    expect(await run(stale(NOW - 31 * 60_000))).toEqual({ sync: [], background: ['iu', 'me'] }) // a retry never blocks a pick
    expect(await run(stale(NOW - 60_000))).toEqual({ sync: [], background: ['iu'] })
  })
  test('a failed refresh restarts the cooldown; a successful one clears the mark', () => {
    const dir = tmp()
    setAuthFailed('me', true, NOW, dir)
    setAuthFailed('me', true, NOW + 10 * 60_000, dir)
    expect(loadCache(dir).auth_failed_at.me).toBe(NOW + 10 * 60_000)
    setAuthFailed('me', false, NOW + 11 * 60_000, dir)
    expect(loadCache(dir).auth_failed.me).toBeUndefined()
  })
  test('newestAge / dueIds', () => {
    expect(newestAge({ ...sample(1, 1), w_ts: NOW - 1000 }, NOW)).toBe(1000)
    expect(dueIds(reg(false), staleA(), NOW)).toEqual(['iu'])
    expect(dueIds(reg(), cacheOf(sample(1, 1)), NOW)).toEqual(['me'])
    expect(dueIds(reg(), cacheOf(sample(1, 1), sample(1, 1)), NOW)).toEqual([])
  })
})

describe('per-account files', () => {
  test('saveSample merges field-wise per window on disk', () => {
    const dir = tmp()
    saveSample('iu', sample(10, 20), dir)
    saveSample('iu', { s: null, w: 30, s_reset: null, w_reset: 1, s_ts: null, w_ts: NOW, src: 'x' }, dir)
    expect(loadCache(dir).samples.iu).toMatchObject({ s: 10, w: 30, s_ts: NOW - 60_000, w_ts: NOW })
    rmSync(dir, { recursive: true })
  })
  test('partial record keeps the other window and its timestamp; a full one refreshes both', () => {
    const dir = tmp()
    saveSample('iu', sample(10, 40, { wReset: NOW / 1000 + 9 }), dir)
    recordSample('iu', { s: 20, s_reset: 5 }, NOW, dir)
    const x = loadCache(dir).samples.iu
    expect(x).toMatchObject({ s: 20, s_ts: NOW, w: 40, w_ts: NOW - 60_000, w_reset: NOW / 1000 + 9, src: 'statusline' })
    recordSample('iu', { s: 1, w: 2, s_reset: 3, w_reset: 4 }, NOW + 1000, dir)
    expect(loadCache(dir).samples.iu).toMatchObject({ s: 1, w: 2, w_ts: NOW + 1000 })
    rmSync(dir, { recursive: true })
  })
  test('record clears auth_failed for that account only; exhausted keeps the max', () => {
    const dir = tmp()
    setAuthFailed('iu', true, NOW, dir)
    setAuthFailed('me', true, NOW, dir)
    recordSample('iu', { s: 1 }, NOW, dir)
    expect(loadCache(dir).auth_failed).toEqual({ me: true })
    markExhausted('iu', 100, dir)
    markExhausted('iu', 50, dir)
    expect(loadCache(dir).exhausted.iu).toBe(100)
    rmSync(dir, { recursive: true })
  })
  test('concurrent writers to different accounts and kinds lose nothing', async () => {
    const dir = tmp()
    const lib = join(import.meta.dir, '..', 'src', 'index.ts')
    const run = (code: string) =>
      Bun.spawn(['bun', '-e', `import * as L from ${JSON.stringify(lib)}; ${code}`], {
        env: { ...process.env, CLAUDE_ACCOUNTS_CACHE_DIR: dir },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    const ps = ['w', 'x', 'y', 'z'].flatMap((id) => [
      run(`L.recordSample(${JSON.stringify(id)}, { s: 5, w: 6 }, Date.now())`),
      run(`L.markExhausted(${JSON.stringify(id)}, 99)`),
    ])
    for (const p of ps) expect(await p.exited).toBe(0)
    const c = loadCache(dir)
    expect(Object.keys(c.samples).sort()).toEqual(['w', 'x', 'y', 'z'])
    expect(Object.keys(c.exhausted).sort()).toEqual(['w', 'x', 'y', 'z'])
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    rmSync(dir, { recursive: true })
  })
})

describe('claimRefresh (O_EXCL claim file)', () => {
  test('the first claim wins, a second inside the 5-min budget gets nothing', () => {
    const dir = tmp()
    expect(claimRefresh(reg(false), ['iu'], NOW, staleA(), dir)).toEqual(['iu'])
    expect(claimRefresh(reg(false), ['iu'], NOW + 1000, staleA(), dir)).toEqual([])
    rmSync(dir, { recursive: true })
  })
  test('a claim older than 5 min is stale and replaced; releasing gives it back', () => {
    const dir = tmp()
    claimRefresh(reg(false), ['iu'], NOW, staleA(), dir)
    expect(claimRefresh(reg(false), ['iu'], NOW + 6 * 60_000, staleA(), dir)).toEqual(['iu'])
    releaseClaim('iu', dir)
    expect(claimRefresh(reg(false), ['iu'], NOW + 6 * 60_000 + 1, staleA(), dir)).toEqual(['iu'])
    rmSync(dir, { recursive: true })
  })
  test('only due, enabled, requested ids are claimed', () => {
    const dir = tmp()
    const stale2 = cacheOf(sample(1, 1, { age: 11 * 60_000 }), sample(1, 1, { age: 11 * 60_000 }))
    expect(claimRefresh(reg(false), ['iu', 'me'], NOW, stale2, dir)).toEqual(['iu'])
    expect(claimRefresh(reg(), ['iu'], NOW, cacheOf(sample(1, 1)), dir)).toEqual([])
    rmSync(dir, { recursive: true })
  })
  test('all: claims every enabled account whatever its sample age, the 5-min budget still holds', () => {
    const dir = tmp()
    const fresh = cacheOf(sample(1, 1), sample(1, 1))
    expect(claimRefresh(reg(), ['iu', 'me'], NOW, fresh, dir)).toEqual([]) // not due
    expect(claimRefresh(reg(), ['iu', 'me'], NOW, fresh, dir, false, true)).toEqual(['iu', 'me'])
    expect(claimRefresh(reg(), ['iu', 'me'], NOW + 1000, fresh, dir, false, true)).toEqual([]) // claimed a second ago
    expect(claimRefresh(reg(false), ['iu', 'me'], NOW + 6 * 60_000, fresh, dir, false, true)).toEqual(['iu']) // disabled stays out
    rmSync(dir, { recursive: true })
  })
  test('two concurrent claimers: exactly one wins', async () => {
    const dir = tmp()
    const lib = join(import.meta.dir, '..', 'src', 'index.ts')
    const code = `const reg = { accounts: { iu: { dir: null, plan: "x", units: { session: 1, weekly: 1 }, homeLanes: [], enabled: true } } }; console.log(JSON.stringify(L.claimRefresh(reg, ["iu"], Date.now(), L.emptyCache())))`
    const ps = Array.from({ length: 6 }, () =>
      Bun.spawn(['bun', '-e', `import * as L from ${JSON.stringify(lib)}; ${code}`], {
        env: { ...process.env, CLAUDE_ACCOUNTS_CACHE_DIR: dir },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    const outs = await Promise.all(
      ps.map(async (p) => {
        await p.exited
        return (await new Response(p.stdout).text()).trim()
      }),
    )
    expect(outs.filter((o) => o === '["iu"]').length).toBe(1)
    expect(outs.filter((o) => o === '[]').length).toBe(5)
    rmSync(dir, { recursive: true })
  })
})

const ok: SpawnResult = { status: 0, stdout: '{}', stderr: '' }

// Captured shape of GET /api/oauth/usage (2026-10-25, trimmed): extra keys and null windows are part of the contract.
const OAUTH_BODY = {
  five_hour: {
    utilization: 3.0,
    resets_at: '2026-10-24T23:49:59.964874+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day: {
    utilization: 89.0,
    resets_at: '2026-10-28T15:59:59.964894+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  iguana_necktie: {
    utilization: 0.0,
    resets_at: '2026-11-05T07:59:00+00:00',
    limit_dollars: 250,
    used_dollars: 0.0,
    remaining_dollars: 250.0,
    locked_reason: null,
  },
}
const TOKEN = 'sk-ant-oat01-SECRET-TOKEN-VALUE'
const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: 1 }, mcpOAuth: {} })

describe('OAuth usage source', () => {
  test('keychainService: default dir is the bare name, others the first 8 hex of sha256(abs dir)', () => {
    expect(keychainService(null)).toBe('Claude Code-credentials')
    const want = `Claude Code-credentials-${createHash('sha256').update('/home/x/.claude-me').digest('hex').slice(0, 8)}`
    expect(keychainService('/home/x/.claude-me')).toBe(want)
    expect(keychainService('/home/x/.claude-me/')).toBe(want) // resolve() drops the trailing slash
  })
  test('tokenFromCredentials reads claudeAiOauth.accessToken and rejects everything else', () => {
    expect(tokenFromCredentials(CREDS)).toBe(TOKEN)
    expect(tokenFromCredentials('not json')).toBeNull()
    expect(tokenFromCredentials('{}')).toBeNull()
    expect(tokenFromCredentials(JSON.stringify({ claudeAiOauth: { accessToken: '' } }))).toBeNull()
    expect(tokenFromCredentials(JSON.stringify({ claudeAiOauth: { accessToken: 5 } }))).toBeNull()
  })
  test('request shape matches fetch_usage.py', () => {
    expect(oauthUsageHeaders('T')).toEqual({
      Authorization: 'Bearer T',
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    })
  })
  test('sampleFromOAuthUsage maps utilization/resets_at, stamps both windows with now', () => {
    expect(sampleFromOAuthUsage(OAUTH_BODY, NOW)).toEqual({
      s: 3,
      s_reset: Math.round(Date.parse('2026-10-24T23:49:59.964874+00:00') / 1000),
      s_ts: NOW,
      w: 89,
      w_reset: Math.round(Date.parse('2026-10-28T15:59:59.964894+00:00') / 1000),
      w_ts: NOW,
      src: 'oauth',
    })
  })
  test('a window the body omits stays null; nothing usable or a non-object is no sample', () => {
    const onlyW = sampleFromOAuthUsage({ seven_day: { utilization: 10, resets_at: '2026-10-28T16:00:00+00:00' } }, NOW)!
    expect(onlyW).toMatchObject({ s: null, s_ts: null, s_reset: null, w: 10, w_ts: NOW })
    expect(sampleFromOAuthUsage({ five_hour: null, seven_day: null }, NOW)).toBeNull()
    expect(sampleFromOAuthUsage({ error: { type: 'rate_limit_error' } }, NOW)).toBeNull()
    expect(sampleFromOAuthUsage(null, NOW)).toBeNull()
    expect(sampleFromOAuthUsage('x', NOW)).toBeNull()
    expect(sampleFromOAuthUsage([OAUTH_BODY], NOW)).toBeNull()
    expect(sampleFromOAuthUsage({ five_hour: 'high', seven_day: [] }, NOW)).toBeNull()
    expect(
      sampleFromOAuthUsage(
        {
          five_hour: { resets_at: '2026-10-24T23:49:59+00:00' },
          seven_day: { utilization: '9', resets_at: '2026-10-28T16:00:00+00:00' },
        },
        NOW,
      ),
    ).toBeNull() // missing / non-numeric utilization
    expect(sampleFromOAuthUsage({ five_hour: { utilization: 3, resets_at: 1800000000 } }, NOW)).toBeNull() // resets_at must be a string
    expect(
      sampleFromOAuthUsage(
        { five_hour: { utilization: 3, resets_at: '2026-10-24T23:49:59+00:00' }, seven_day: { utilization: '9' } },
        NOW,
      ),
    ).toMatchObject({ s: 3, w: null }) // one bad window does not drop the good one
  })
})

describe('runRefresh', () => {
  interface Setup {
    keychain?: SpawnResult
    http?: HttpGet
    auth?: SpawnResult
    claudeStart?: SpawnResult // overrides the `auth status` answer entirely (ENOENT, timeout)
  }
  const kcOk: SpawnResult = { status: 0, stdout: `${CREDS}\n`, stderr: '' }
  const http200: HttpGet = async () => ({ status: 200, json: OAUTH_BODY })
  const loggedIn = (v: boolean): SpawnResult => ({ status: 0, stdout: JSON.stringify({ loggedIn: v }), stderr: '' })

  async function harness(
    t: Setup,
    o: { ids?: string[]; preAuthFailed?: string[]; seed?: Sample; registry?: Registry; verifiedAgoMs?: number } = {},
  ) {
    const dir = tmp()
    const ids = o.ids ?? ['iu']
    claimRefresh(reg(), ids, NOW, cacheOf(sample(1, 1, { age: 11 * 60_000 }), sample(1, 1, { age: 11 * 60_000 })), dir) // pre-claimed by the caller
    for (const id of o.preAuthFailed ?? []) setAuthFailed(id, true, NOW - 3600_000, dir)
    if (o.seed) for (const id of ids) saveSample(id, o.seed, dir)
    if (o.verifiedAgoMs !== undefined) for (const id of ids) markVerified(id, NOW - o.verifiedAgoMs, dir)
    const calls: { cmd: string; args: string[]; configDir: string | undefined }[] = []
    const urls: { url: string; headers: Record<string, string>; timeoutMs: number }[] = []
    const logs: string[] = []
    const results = await runRefresh({
      reg: o.registry ?? reg(),
      claudeBin: 'claude',
      baseEnv: { PATH: '/bin', USER: 'owner' },
      now: () => NOW,
      ids,
      dir,
      log: (m) => logs.push(m),
      spawn: (cmd, args, e) => {
        calls.push({ cmd, args, configDir: e.env.CLAUDE_CONFIG_DIR })
        if (cmd === '/usr/bin/security') return t.keychain ?? kcOk
        return t.claudeStart ?? t.auth ?? ok
      },
      httpGet: async (url, headers, timeoutMs) => {
        urls.push({ url, headers, timeoutMs })
        return (t.http ?? http200)(url, headers, timeoutMs)
      },
    })
    const claimHeld = !claimRefresh(reg(), ['iu'], NOW + 1000, cacheOf(sample(1, 1, { age: 11 * 60_000 })), dir).length
    const cache = loadCache(dir)
    const files = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
    const verified = readVerified('iu', dir)
    rmSync(dir, { recursive: true })
    return { results, cache, calls, urls, logs, claimHeld, files, verified }
  }

  test('endpoint sample: saved, fresh, claim kept as the budget, claude never spawned', async () => {
    const h = await harness({})
    expect(h.results).toEqual({ iu: 'fresh' })
    expect(h.cache.samples.iu).toMatchObject({ s: 3, w: 89, s_ts: NOW, src: 'oauth' })
    expect(h.calls.map((c) => c.cmd)).toEqual(['/usr/bin/security'])
    expect(h.calls[0].args).toEqual(['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'owner', '-w']) // -a: never the stale acct "unknown" twin
    expect(h.urls).toEqual([
      { url: 'https://api.anthropic.com/api/oauth/usage', headers: oauthUsageHeaders(TOKEN), timeoutMs: 10_000 },
    ])
    expect(h.claimHeld).toBe(true)
  })
  test('a non-default account reads its own suffixed Keychain service', async () => {
    const h = await harness({}, { ids: ['me'] })
    expect(h.calls[0].args[2]).toBe(keychainService('/home/x/.claude-me'))
    expect(h.results).toEqual({ me: 'fresh' })
  })
  test('a sample clears a recorded auth failure', async () => {
    const h = await harness({}, { preAuthFailed: ['iu'] })
    expect(h.cache.auth_failed.iu).toBeUndefined()
  })
  test('the token never reaches the logs or the cache files', async () => {
    const bad = await harness({
      http: async () => {
        throw new Error(`boom ${TOKEN}`)
      },
    })
    const ok200 = await harness({})
    for (const h of [bad, ok200]) {
      expect(h.logs.join('\n')).not.toContain(TOKEN)
      expect(h.files).not.toContain(TOKEN)
    }
  })
  test('no sample + `auth status` loggedIn=true clears the auth mark and answers auth-ok', async () => {
    const h = await harness(
      { keychain: { status: 44, stdout: '', stderr: 'The specified item could not be found' }, auth: loggedIn(true) },
      { preAuthFailed: ['iu'], seed: sample(1, 1, { age: 2 * H * 1000 }) },
    )
    expect(h.results).toEqual({ iu: 'auth-ok' })
    expect(h.cache.auth_failed.iu).toBeUndefined()
    expect(h.calls.map((c) => c.args[0])).toEqual(['find-generic-password', 'auth'])
    expect(h.urls).toEqual([]) // no token, no request
  })
  test('no sample + loggedIn=false sets the auth mark', async () => {
    const h = await harness({ keychain: { status: 44, stdout: '', stderr: '' }, auth: loggedIn(false) })
    expect(h.results).toEqual({ iu: 'auth-failed' })
    expect(h.cache.auth_failed.iu).toBe(true)
    expect(h.claimHeld).toBe(true)
  })
  test("auth status runs under that account's CLAUDE_CONFIG_DIR (unset for the default)", async () => {
    const me = await harness(
      { keychain: { status: 44, stdout: '', stderr: '' }, auth: loggedIn(true) },
      { ids: ['me'] },
    )
    expect(me.calls[1]).toMatchObject({ args: ['auth', 'status'], configDir: '/home/x/.claude-me' })
    const iu = await harness({ keychain: { status: 44, stdout: '', stderr: '' }, auth: loggedIn(true) })
    expect(iu.calls[1].configDir).toBeUndefined()
  })
  test.each([
    ['HTTP 429', async () => ({ status: 429, json: { error: 'rate' } })],
    ['HTTP 401', async () => ({ status: 401, json: { error: 'unauthorized' } })],
    ['unparseable body', async () => ({ status: 200, json: null })],
    [
      'network error',
      async () => {
        throw new Error('ECONNRESET')
      },
    ],
  ] as [string, HttpGet][])(
    'endpoint failure (%s) leaves the auth mark alone and falls through to the verdict',
    async (_n, http) => {
      const unknown = await harness({ http, auth: { status: 0, stdout: '', stderr: '' } }, { preAuthFailed: ['iu'] })
      expect(unknown.results).toEqual({ iu: 'unresolved' })
      expect(unknown.cache.auth_failed.iu).toBe(true) // untouched: only a verdict or a sample moves it
      expect(unknown.cache.samples.iu).toBeUndefined()
      const ok2 = await harness({ http, auth: loggedIn(true) }, { seed: sample(1, 1, { age: 2 * H * 1000 }) })
      expect(ok2.results).toEqual({ iu: 'auth-ok' })
      expect(ok2.cache.auth_failed.iu).toBeUndefined()
    },
  )
  test('logged in but no sample and the stored one older than 6 h (or missing) is `stale`, and the log names the account and age', async () => {
    const down: HttpGet = async () => ({ status: 404, json: null })
    const old = await harness({ http: down, auth: loggedIn(true) }, { seed: sample(1, 1, { age: 7 * H * 1000 }) })
    expect(old.results).toEqual({ iu: 'stale' })
    expect(old.cache.auth_failed.iu).toBeUndefined() // the login is fine; only the feed is dying
    expect(old.logs.join('\n')).toMatch(/refresh iu: logged in .* 7 h old/)
    const none = await harness({ http: down, auth: loggedIn(true) })
    expect(none.results).toEqual({ iu: 'stale' })
    expect(none.logs.join('\n')).toContain('missing')
    const young = await harness({ http: down, auth: loggedIn(true) }, { seed: sample(1, 1, { age: 5 * H * 1000 }) })
    expect(young.results).toEqual({ iu: 'auth-ok' })
  })
  test('auth-only fallback ignores a leftover Ultra session value: a stale weekly stays stale', async () => {
    const down: HttpGet = async () => ({ status: 404, json: null })
    const ultra: Registry = {
      accounts: { iu: { dir: null, plan: 'ultra', homeLanes: ['interactive'], enabled: true } },
    }
    const seed: Sample = { ...sample(50, 20, { age: 7 * H * 1000 }), s_ts: NOW - 60_000 } // fresh session half left over, weekly 7 h old
    const h = await harness({ http: down, auth: loggedIn(true) }, { seed, registry: ultra })
    expect(h.results).toEqual({ iu: 'stale' })
  })
  test('endpoint failure alone never sets the auth mark', async () => {
    const h = await harness({
      http: async () => ({ status: 401, json: null }),
      auth: { status: 0, stdout: '', stderr: '' },
    })
    expect(h.cache.auth_failed.iu).toBeUndefined()
  })
  test('keychain denied (locked) is no sample and no auth mark', async () => {
    const h = await harness({
      keychain: { status: 36, stdout: '', stderr: 'User interaction is not allowed.' },
      auth: { status: 0, stdout: '', stderr: '' },
    })
    expect(h.results).toEqual({ iu: 'unresolved' })
    expect(h.cache.auth_failed.iu).toBeUndefined()
    expect(h.logs.join('\n')).toContain('User interaction is not allowed.')
  })
  test('missing claude binary releases the claim, no verdict', async () => {
    const h = await harness({
      keychain: { status: 44, stdout: '', stderr: '' },
      claudeStart: { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawn claude ENOENT' } },
    })
    expect(h.results).toEqual({ iu: 'unresolved' })
    expect(h.claimHeld).toBe(false)
    expect(h.cache.auth_failed.iu).toBeUndefined()
  })
  test('any other spawn error releases the claim and logs its code', async () => {
    const h = await harness({
      keychain: { status: 44, stdout: '', stderr: '' },
      claudeStart: { status: null, stdout: '', stderr: '', error: { code: 'EACCES', message: 'spawn claude EACCES' } },
    })
    expect(h.results).toEqual({ iu: 'unresolved' })
    expect(h.claimHeld).toBe(false)
    expect(h.logs.join('\n')).toContain('EACCES')
  })
  test('`auth status` timeout keeps the claim, no verdict', async () => {
    const h = await harness({
      keychain: { status: 44, stdout: '', stderr: '' },
      claudeStart: { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT', message: 'timed out' } },
    })
    expect(h.results).toEqual({ iu: 'unresolved' })
    expect(h.claimHeld).toBe(true)
    expect(h.cache.auth_failed.iu).toBeUndefined()
  })
  test('no verdict while the login was proven < 6 h ago is deferred (exit 0), at 6 h or never it is unresolved', async () => {
    const hang: SpawnResult = {
      status: null,
      stdout: '',
      stderr: '',
      error: { code: 'ETIMEDOUT', message: 'timed out' },
    }
    const setup = { http: async () => ({ status: 503, json: null }), claudeStart: hang }
    const recent = await harness(setup, { verifiedAgoMs: 2 * H * 1000 })
    expect(recent.results).toEqual({ iu: 'deferred' })
    expect(recent.logs.join('\n')).toContain('login last proven 120 min ago')
    expect(recent.claimHeld).toBe(true)
    expect((await harness(setup, { verifiedAgoMs: 6 * H * 1000 })).results).toEqual({ iu: 'unresolved' })
    expect((await harness(setup)).results).toEqual({ iu: 'unresolved' })
  })
  test('a sample or loggedIn=true stamps the login as proven; a failed verdict does not', async () => {
    expect((await harness({})).verified).toBe(NOW)
    expect((await harness({ http: async () => ({ status: 404, json: null }), auth: loggedIn(true) })).verified).toBe(
      NOW,
    )
    expect(
      (await harness({ http: async () => ({ status: 404, json: null }), auth: loggedIn(false) })).verified,
    ).toBeNull()
  })
  test('each account is judged on its own', async () => {
    const dir = tmp()
    const r = await runRefresh({
      reg: reg(),
      claudeBin: 'claude',
      baseEnv: {},
      now: () => NOW,
      ids: ['iu', 'me'],
      dir,
      spawn: (cmd, a, e) =>
        cmd === '/usr/bin/security'
          ? a[2] === 'Claude Code-credentials'
            ? { status: 0, stdout: CREDS, stderr: '' }
            : { status: 44, stdout: '', stderr: '' }
          : e.env.CLAUDE_CONFIG_DIR
            ? loggedIn(false)
            : ok,
      httpGet: async () => ({ status: 200, json: OAUTH_BODY }),
    })
    rmSync(dir, { recursive: true })
    expect(r).toEqual({ iu: 'fresh', me: 'auth-failed' })
  })
})

describe('runRefresh: HTTP 401 renews the token via `claude auth status`', () => {
  const OLD = 'sk-ant-oat01-OLD-EXPIRED-TOKEN'
  const NEW = 'sk-ant-oat01-NEW-RENEWED-TOKEN'
  const creds = (t: string) => JSON.stringify({ claudeAiOauth: { accessToken: t, refreshToken: 'r', expiresAt: 1 } })
  const bearer = (h: Record<string, string>) => h.Authorization.slice('Bearer '.length)

  /** `renews`: whether `auth status` actually swaps the Keychain token (an expired login renews nothing). */
  async function run(o: { renews: boolean; loggedIn?: boolean; id?: string; seed?: Sample }) {
    const dir = tmp()
    const id = o.id ?? 'me'
    claimRefresh(reg(), [id], NOW, cacheOf(sample(1, 1, { age: 11 * 60_000 }), sample(1, 1, { age: 11 * 60_000 })), dir)
    if (o.seed) saveSample(id, o.seed, dir)
    let renewed = false
    const calls: { cmd: string; args: string[]; configDir: string | undefined }[] = []
    const gets: string[] = []
    const logs: string[] = []
    const results = await runRefresh({
      reg: reg(),
      claudeBin: 'claude',
      baseEnv: { PATH: '/bin' },
      now: () => NOW,
      ids: [id],
      dir,
      log: (m) => logs.push(m),
      spawn: (cmd, args, e) => {
        calls.push({ cmd, args, configDir: e.env.CLAUDE_CONFIG_DIR })
        if (cmd === '/usr/bin/security') return { status: 0, stdout: creds(renewed ? NEW : OLD), stderr: '' }
        renewed = o.renews
        return { status: 0, stdout: JSON.stringify({ loggedIn: o.loggedIn ?? true }), stderr: '' }
      },
      httpGet: async (_u, h) => {
        gets.push(bearer(h))
        return bearer(h) === NEW ? { status: 200, json: OAUTH_BODY } : { status: 401, json: { error: 'expired' } }
      },
    })
    const cache = loadCache(dir)
    const files = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
    rmSync(dir, { recursive: true })
    return { results, cache, calls, gets, logs, files }
  }
  const noSecrets = (h: { logs: string[]; files: string }) => {
    for (const t of [OLD, NEW]) {
      expect(h.logs.join('\n')).not.toContain(t)
      expect(h.files).not.toContain(t)
    }
  }

  test("401 -> auth status -> new token -> 200 gives a fresh sample, one status call, under the account's own dir", async () => {
    const h = await run({ renews: true })
    expect(h.results).toEqual({ me: 'fresh' })
    expect(h.cache.samples.me).toMatchObject({ s: 3, w: 89, s_ts: NOW, src: 'oauth' })
    expect(h.gets).toEqual([OLD, NEW])
    expect(h.calls.map((c) => c.args[0])).toEqual(['find-generic-password', 'auth', 'find-generic-password'])
    expect(h.calls[1]).toMatchObject({ args: ['auth', 'status'], configDir: '/home/x/.claude-me' })
    expect(h.logs.join('\n')).toContain('HTTP 401')
    noSecrets(h)
  })
  test('401 twice: no sample, the auth-status verdict still decides, and it is not run a second time', async () => {
    const ok = await run({ renews: false, seed: sample(1, 1, { age: 2 * H * 1000 }) })
    expect(ok.results).toEqual({ me: 'auth-ok' })
    expect(ok.gets).toEqual([OLD, OLD]) // exactly one retry
    expect(ok.calls.filter((c) => c.args[0] === 'auth')).toHaveLength(1)
    expect(ok.cache.auth_failed.me).toBeUndefined()
    const dead = await run({ renews: false, loggedIn: false })
    expect(dead.results).toEqual({ me: 'auth-failed' })
    expect(dead.cache.auth_failed.me).toBe(true)
    expect(dead.cache.samples.me).toBeUndefined()
    noSecrets(ok)
    noSecrets(dead)
  })
  test('a 401 for the default account renews with CLAUDE_CONFIG_DIR unset', async () => {
    const h = await run({ renews: true, id: 'iu' })
    expect(h.results).toEqual({ iu: 'fresh' })
    expect(h.calls[1].configDir).toBeUndefined()
  })
  test('other failures (429) never run auth status for the retry', async () => {
    const dir = tmp()
    claimRefresh(
      reg(),
      ['me'],
      NOW,
      cacheOf(sample(1, 1, { age: 11 * 60_000 }), sample(1, 1, { age: 11 * 60_000 })),
      dir,
    )
    const cmds: string[] = []
    await runRefresh({
      reg: reg(),
      claudeBin: 'claude',
      baseEnv: {},
      now: () => NOW,
      ids: ['me'],
      dir,
      spawn: (cmd, a) => {
        cmds.push(`${cmd.split('/').pop()} ${a[0]}`)
        return cmd === '/usr/bin/security'
          ? { status: 0, stdout: creds(OLD), stderr: '' }
          : { status: 0, stdout: '', stderr: '' }
      },
      httpGet: async () => ({ status: 429, json: null }),
    })
    rmSync(dir, { recursive: true })
    expect(cmds).toEqual(['security find-generic-password', 'claude auth']) // the single verdict fall-through, no retry call
  })
  test('a claude binary that cannot start gives the claim back and skips the retry', async () => {
    const dir = tmp()
    claimRefresh(
      reg(),
      ['me'],
      NOW,
      cacheOf(sample(1, 1, { age: 11 * 60_000 }), sample(1, 1, { age: 11 * 60_000 })),
      dir,
    )
    let gets = 0
    const r = await runRefresh({
      reg: reg(),
      claudeBin: 'claude',
      baseEnv: {},
      now: () => NOW,
      ids: ['me'],
      dir,
      spawn: (cmd) =>
        cmd === '/usr/bin/security'
          ? { status: 0, stdout: creds(OLD), stderr: '' }
          : { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawn claude ENOENT' } },
      httpGet: async () => {
        gets++
        return { status: 401, json: null }
      },
    })
    const held = !claimRefresh(
      reg(),
      ['me'],
      NOW + 1000,
      cacheOf(sample(1, 1, { age: 11 * 60_000 }), sample(1, 1, { age: 11 * 60_000 })),
      dir,
    ).length
    rmSync(dir, { recursive: true })
    expect(r).toEqual({ me: 'unresolved' })
    expect(gets).toBe(1)
    expect(held).toBe(false)
  })
})

describe('runRefresh: peer sample import', () => {
  const peerRow = (id: string, o: Record<string, unknown> = {}) => ({
    id,
    plan: 'x',
    enabled: true,
    five_hour: 40,
    seven_day: 55,
    five_hour_resets_at: NOW / 1000 + 3 * H,
    seven_day_resets_at: NOW / 1000 + 100 * H,
    age_s: 120,
    five_hour_age_s: 120,
    seven_day_age_s: 300,
    source: 'oauth',
    auth_ok: true,
    exhausted_until: null,
    ...o,
  })
  const loggedInStub = (v: boolean): SpawnResult => ({ status: 0, stdout: JSON.stringify({ loggedIn: v }), stderr: '' })

  async function run(
    peer: (() => unknown) | undefined,
    o: {
      ids?: string[]
      registry?: Registry
      seed?: [string, Sample]
      auth?: boolean
      authResult?: SpawnResult
      keychain?: SpawnResult
      http?: HttpGet
    } = {},
  ) {
    const dir = tmp()
    const ids = o.ids ?? ['me']
    const registry = o.registry ?? reg()
    if (o.seed) saveSample(o.seed[0], o.seed[1], dir)
    const calls: string[] = []
    const urls: string[] = []
    const logs: string[] = []
    const results = await runRefresh({
      reg: registry,
      claudeBin: 'claude',
      baseEnv: { PATH: '/bin', USER: 'owner' },
      now: () => NOW,
      ids,
      dir,
      log: (m) => logs.push(m),
      peerUsage: peer,
      spawn: (cmd, args) => {
        calls.push(cmd === '/usr/bin/security' ? 'security' : args[0])
        return cmd === '/usr/bin/security'
          ? (o.keychain ?? { status: 0, stdout: CREDS, stderr: '' })
          : (o.authResult ?? loggedInStub(o.auth ?? true))
      },
      httpGet: async (url, h, t) => {
        urls.push(url)
        return (o.http ?? (async () => ({ status: 200, json: OAUTH_BODY })))(url, h, t)
      },
    })
    const cache = loadCache(dir)
    const files = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
    rmSync(dir, { recursive: true })
    return { results, cache, calls, urls, logs, files }
  }

  test('a fresh peer sample replaces the GET: windows keep their original age, src peer, result fresh', async () => {
    const h = await run(() => ({ accounts: [peerRow('me')] }))
    expect(h.cache.samples.me).toEqual({
      s: 40,
      s_reset: NOW / 1000 + 3 * H,
      s_ts: NOW - 120_000,
      w: 55,
      w_reset: NOW / 1000 + 100 * H,
      w_ts: NOW - 300_000,
      src: 'peer',
    })
    expect(h.results).toEqual({ me: 'fresh' })
    expect(h.urls).toEqual([]) // no token read, no request
    expect(h.calls).toEqual(['auth']) // ...but the login verdict of THIS machine still runs
  })
  test('a fresh peer sample without a local verdict (unparseable auth status) is unresolved, never fresh', async () => {
    const h = await run(() => ({ accounts: [peerRow('me')] }), {
      authResult: { status: 0, stdout: 'garbage', stderr: '' },
    })
    expect(h.results).toEqual({ me: 'unresolved' })
    expect(h.urls).toEqual([])
  })
  test('peer auth state is never imported; the local verdict decides', async () => {
    const dead = await run(() => ({ accounts: [peerRow('me', { auth_ok: false })] }))
    expect(dead.cache.auth_failed.me).toBeUndefined() // loggedIn=true here
    expect(dead.results).toEqual({ me: 'fresh' })
    const out = await run(() => ({ accounts: [peerRow('me', { auth_ok: true })] }), { auth: false })
    expect(out.cache.auth_failed.me).toBe(true) // logged out here, whatever the peer says
    expect(out.results).toEqual({ me: 'auth-failed' })
  })
  test('a window the peer reports without an age gets no timestamp; a row without windows imports nothing', async () => {
    const h = await run(
      () => ({
        accounts: [
          peerRow('me', { five_hour_age_s: null, seven_day: null, seven_day_resets_at: null, seven_day_age_s: null }),
        ],
      }),
      { http: async () => ({ status: 500, json: null }) },
    )
    expect(h.cache.samples.me).toMatchObject({ s: 40, s_ts: null, w: null, w_ts: null, src: 'peer' })
    expect(h.urls.length).toBe(1) // an undated window is never "fresh": the GET still runs
    const none = await run(() => ({ accounts: [peerRow('me', { five_hour: null, seven_day: null })] }), {
      http: async () => ({ status: 500, json: null }),
    })
    expect(none.cache.samples.me).toBeUndefined()
    expect(none.urls.length).toBe(1) // not imported -> the normal GET path
  })
  test('mergeSample keeps the newer window: a fresher local sample survives the import', async () => {
    const local: Sample = {
      s: 12,
      s_reset: NOW / 1000 + 4 * H,
      s_ts: NOW - 5_000,
      w: 30,
      w_reset: NOW / 1000 + 90 * H,
      w_ts: NOW - 5 * 60_000,
      src: 'statusline',
    }
    const h = await run(() => ({ accounts: [peerRow('me')] }), { seed: ['me', local] })
    expect(h.cache.samples.me).toMatchObject({ s: 12, s_ts: NOW - 5_000, w: 55, w_ts: NOW - 300_000 }) // s: local is newer; w: peer (5 min) is as new as local (5 min) -> the incoming wins a tie
    expect(h.results).toEqual({ me: 'fresh' })
  })
  test("an old peer sample is stored but the GET still runs; the endpoint's newer numbers win", async () => {
    const h = await run(() => ({ accounts: [peerRow('me', { five_hour_age_s: 3600, seven_day_age_s: 3600 })] }))
    expect(h.urls.length).toBe(1)
    expect(h.cache.samples.me).toMatchObject({ s: 3, w: 89, src: 'oauth', s_ts: NOW })
    expect(h.results).toEqual({ me: 'fresh' })
  })
  test('an old peer sample is the fallback when the GET fails: logged in, sample under 6 h -> auth-ok', async () => {
    const h = await run(() => ({ accounts: [peerRow('me', { five_hour_age_s: 3600, seven_day_age_s: 3600 })] }), {
      http: async () => ({ status: 401, json: null }),
    })
    expect(h.cache.samples.me).toMatchObject({ s: 40, src: 'peer' })
    expect(h.results).toEqual({ me: 'auth-ok' })
  })
  test('only locally registered, enabled accounts are imported', async () => {
    const h = await run(() => ({ accounts: [peerRow('iu'), peerRow('ghost'), peerRow('me')] }), {
      registry: reg(false),
      ids: ['iu'],
    })
    expect(Object.keys(h.cache.samples)).toEqual(['iu']) // me is disabled here, ghost is unknown
  })
  test('a future exhausted_until becomes a mark; a past one is ignored', async () => {
    const future = await run(() => ({ accounts: [peerRow('me', { exhausted_until: NOW / 1000 + 600 })] }))
    expect(future.cache.exhausted.me).toBe(NOW / 1000 + 600)
    const past = await run(() => ({ accounts: [peerRow('me', { exhausted_until: NOW / 1000 - 600 })] }))
    expect(past.cache.exhausted.me).toBeUndefined()
  })
  test('an unreachable or garbled peer is one log line and the run goes on unchanged', async () => {
    const down = await run(() => {
      throw new Error('peer command failed (rc=255)')
    })
    expect(down.logs.filter((l) => l.includes('peer'))).toEqual([
      'refresh: peer usage unavailable: peer command failed (rc=255)',
    ])
    expect(down.results).toEqual({ me: 'fresh' })
    expect(down.cache.samples.me).toMatchObject({ src: 'oauth' })
    for (const garbage of [null, 'nope', {}, { accounts: 'x' }, { accounts: [null, 7, { id: 5 }] }]) {
      const g = await run(async () => garbage)
      expect(g.logs.filter((l) => l.includes('peer')).length).toBeLessThanOrEqual(1)
      expect(g.results).toEqual({ me: 'fresh' })
      expect(g.cache.samples.me).toMatchObject({ src: 'oauth' })
    }
    expect((await run(() => ({ accounts: 'x' }))).logs.filter((l) => l.includes('peer'))).toEqual([
      'refresh: peer usage unreadable, no samples imported',
    ])
  })
  test('no peerUsage dep (or nothing to refresh) means no fetch', async () => {
    let fetched = 0
    const h = await run(undefined)
    expect(h.cache.samples.me).toMatchObject({ src: 'oauth' })
    await run(
      () => {
        fetched++
        return { accounts: [] }
      },
      { ids: [] },
    )
    expect(fetched).toBe(0)
  })
  test('the import fetches the peer once per run, however many accounts', async () => {
    let fetched = 0
    const both = reg(true)
    const h = await run(
      () => {
        fetched++
        return { accounts: [peerRow('iu'), peerRow('me')] }
      },
      { registry: both, ids: ['iu', 'me'] },
    )
    expect(fetched).toBe(1)
    expect(h.results).toEqual({ iu: 'fresh', me: 'fresh' })
    expect(h.urls).toEqual([])
  })
  test('no token and nothing but peer-shaped data reaches the cache files', async () => {
    const h = await run(() => ({ accounts: [peerRow('me')] }))
    expect(h.files).not.toContain(TOKEN)
  })
})

describe('statusline record proves the login', () => {
  test('a record carrying rate_limits clears a failed mark; the mark can be set again by a verdict', () => {
    const dir = tmp()
    setAuthFailed('me', true, NOW, dir)
    expect(loadCache(dir).auth_failed.me).toBe(true)
    recordSample('me', { s: 12, w: 30, s_reset: NOW / 1000 + 100, w_reset: NOW / 1000 + 1000 }, NOW + 1000, dir)
    expect(loadCache(dir).auth_failed.me).toBeUndefined()
    setAuthFailed('me', true, NOW + 2000, dir)
    expect(loadCache(dir).auth_failed.me).toBe(true)
    rmSync(dir, { recursive: true })
  })
})

describe('refreshBeforePick', () => {
  async function run(cache: Cache, lane = 'bulk', enabledB = false) {
    const dir = tmp()
    const calls = { sync: [] as string[][], detach: [] as string[][] }
    const r = await refreshBeforePick({
      reg: reg(enabledB),
      lane,
      now: NOW,
      cache,
      claim: (ids) => claimRefresh(reg(enabledB), ids, NOW, cache, dir),
      runSync: (ids) => {
        calls.sync.push(ids)
      },
      detach: (ids) => {
        calls.detach.push(ids)
      },
    })
    const files = readdirSync(dir)
    rmSync(dir, { recursive: true })
    return { r, calls, files }
  }
  test('stale sample: no blocking refresh, claimed and detached', async () => {
    const { r, calls, files } = await run(staleA())
    expect(r).toEqual({ sync: [], background: ['iu'] })
    expect(calls).toEqual({ sync: [], detach: [['iu']] })
    expect(files).toEqual(['iu.refresh.claim'])
  })
  test('fresh sample schedules nothing', async () => {
    expect((await run(cacheOf(sample(10, 10)))).r).toEqual({ sync: [], background: [] })
  })
  test('no usable sample on a bulk lane: synchronous; a stale neighbour in the background', async () => {
    const { r, calls } = await run(cacheOf(undefined, sample(10, 10, { age: 11 * 60_000 })), 'bulk', true)
    expect(r).toEqual({ sync: ['iu'], background: ['me'] })
    expect(calls).toEqual({ sync: [['iu']], detach: [['me']] })
  })
  test('a sample older than 6 h counts as no sample', async () => {
    expect((await run(cacheOf(sample(10, 10, { age: 7 * H * 1000 })))).r).toEqual({ sync: ['iu'], background: [] })
  })
  test('interactive: a stale sample is claimed and refreshed detached, never blocking', async () => {
    const { r, calls, files } = await run(staleA(), 'interactive')
    expect(r).toEqual({ sync: [], background: ['iu'] })
    expect(calls).toEqual({ sync: [], detach: [['iu']] })
    expect(files).toEqual(['iu.refresh.claim'])
  })
  test('interactive: an account without any usable sample is still only refreshed in the background', async () => {
    const { r, calls } = await run(cacheOf(sample(10, 10, { age: 7 * H * 1000 })), 'interactive')
    expect(r).toEqual({ sync: [], background: ['iu'] })
    expect(calls.sync).toEqual([])
  })
  test('interactive: a fresh sample or a claim inside the 5-min budget schedules nothing', async () => {
    expect((await run(cacheOf(sample(10, 10)), 'interactive')).r).toEqual({ sync: [], background: [] })
    const dir = tmp()
    const detach: string[][] = []
    const cache = staleA()
    const go = () =>
      refreshBeforePick({
        reg: reg(false),
        lane: 'interactive',
        now: NOW,
        cache,
        claim: (ids) => claimRefresh(reg(false), ids, NOW, cache, dir),
        runSync: () => {
          throw new Error('sync')
        },
        detach: (ids) => {
          detach.push(ids)
        },
      })
    await go()
    await go()
    rmSync(dir, { recursive: true })
    expect(detach).toEqual([['iu']])
  })
})

describe('CLI (isolated HOME)', () => {
  const CLI = join(import.meta.dir, '..', 'bin', 'claude-account.ts')
  const home = tmp()
  const bin = join(home, 'bin')
  const marker = join(home, 'claude-ran')
  const dir = join(home, 'cache')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch ${marker}\nexit 0\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(join(bin, 'security'), '#!/bin/sh\nexit 44\n') // no Keychain token: the endpoint is never called from tests
  chmodSync(join(bin, 'security'), 0o755)
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexit 255\n') // the peer is unreachable by default (ssh reads the real ~/.ssh/config whatever $HOME says)
  chmodSync(join(bin, 'ssh'), 0o755)
  const registry = join(home, 'registry.json')
  writeFileSync(registry, JSON.stringify(reg(false))) // iu only: the second account is disabled
  const base = {
    ...(process.env as Record<string, string>),
    HOME: home,
    CLAUDE_ACCOUNTS_REGISTRY: registry,
    CLAUDE_ACCOUNTS_CACHE_DIR: dir,
    CLAUDE_ACCOUNTS_PICKS: join(home, 'picks.jsonl'),
    CLAUDE_ACCOUNTS_SECURITY_BIN: join(bin, 'security'),
    CLAUDE_ACCOUNTS_INTEGRATIONS: join(home, 'no-integrations.json'),
    PATH: `${bin}:${process.env.PATH}`,
  }
  delete (base as Record<string, string | undefined>).CLAUDE_CONFIG_DIR
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const t = Date.now()
    const r = Bun.spawnSync(['bun', CLI, ...args], { env: { ...base, ...env }, stdout: 'pipe', stderr: 'pipe' })
    return { rc: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString(), ms: Date.now() - t }
  }
  const seed = (ageMs: number) => {
    rmSync(marker, { force: true })
    rmSync(dir, { recursive: true, force: true })
    const ts = Date.now() - ageMs
    saveSample('iu', { s: 5, w: 5, s_reset: null, w_reset: null, s_ts: ts, w_ts: ts, src: 't' }, dir)
  }

  test("expiry and usage read the login from the account's own Keychain item (fake security, fixtures)", () => {
    const D = 86400_000
    const two = join(home, 'registry2.json')
    writeFileSync(
      two,
      JSON.stringify({ accounts: { ...reg().accounts, me: { ...reg().accounts.me, dir: join(home, '.claude-me') } } }),
    )
    const items = join(home, 'kc')
    mkdirSync(items, { recursive: true })
    const blob = (r: number) =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'SECRET-A',
          refreshToken: 'SECRET-R',
          expiresAt: Date.now() + 3600_000,
          refreshTokenExpiresAt: r,
        },
      })
    writeFileSync(join(items, keychainService(null)), blob(Date.now() + 20 * D))
    writeFileSync(join(items, keychainService(join(home, '.claude-me'))), blob(Date.now() + 5 * D)) // inside the 7-day window
    const stub = join(bin, 'security-fixture')
    writeFileSync(
      stub,
      `#!/bin/sh\n[ "$1" = find-generic-password ] && [ -f "${items}/$3" ] && { cat "${items}/$3"; exit 0; }\nexit 44\n`,
    )
    chmodSync(stub, 0o755)
    const env = { CLAUDE_ACCOUNTS_REGISTRY: two, CLAUDE_ACCOUNTS_SECURITY_BIN: stub }
    const j = JSON.parse(cli(['expiry', '--json'], env).out)
    expect(
      j.accounts.map((a: { id: string; grade: string; days_left: number }) => [a.id, a.grade, Math.round(a.days_left)]),
    ).toEqual([
      ['iu', 'PASS', 20],
      ['me', 'WARN', 5],
    ])
    const text = cli(['expiry'], env)
    expect(text.rc).toBe(0)
    expect(text.out).toMatch(/^iu {2}PASS .*\nme {2}WARN /)
    expect(text.out + text.err).not.toContain('SECRET')
    expect(j.accounts.map((a: { default: boolean; severity: string }) => [a.default, a.severity])).toEqual([
      [true, 'PASS'],
      [false, 'WARN'],
    ])
    // usage is a pure file read: no Keychain access, no login fields (the statusline calls it)
    const probe = join(home, 'security-called')
    rmSync(probe, { force: true })
    writeFileSync(stub, `#!/bin/sh\ntouch "${probe}"\nexit 44\n`)
    const u = cli(['usage'], env).out
    cli(['usage', '--json'], env)
    expect(existsSync(probe)).toBe(false)
    expect(u).not.toContain('login')
    const dead = cli(['expiry', '--json'], { ...env, CLAUDE_ACCOUNTS_SECURITY_BIN: join(bin, 'security') }) // exit 44 everywhere: Keychain unreadable
    expect(JSON.parse(dead.out).accounts.map((a: { grade: string }) => a.grade)).toEqual(['WARN', 'WARN'])
  })

  test('expiry --ids reads named accounts even when disabled and reports the detected plan; an unknown id is an error', () => {
    const svc = keychainService('/home/x/.claude-me')
    const item = join(home, 'kc-me.json')
    writeFileSync(
      item,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'SECRET-A',
          refreshToken: 'SECRET-R',
          expiresAt: Date.now() + 3600_000,
          refreshTokenExpiresAt: Date.now() + 25 * 86400_000,
          rateLimitTier: 'default_claude_max_5x',
        },
      }),
    )
    const stub = join(bin, 'security-ids')
    writeFileSync(
      stub,
      `#!/bin/sh\n[ "$1" = find-generic-password ] && [ "$3" = "${svc}" ] && { cat "${item}"; exit 0; }\nexit 44\n`,
    )
    chmodSync(stub, 0o755)
    const env = { CLAUDE_ACCOUNTS_SECURITY_BIN: stub }
    const only = cli(['expiry', '--json', '--ids', 'me'], env) // me is disabled in the default registry
    expect(only.rc).toBe(0)
    expect(
      JSON.parse(only.out).accounts.map((a: { id: string; plan_detected: string; tier: string; grade: string }) => [
        a.id,
        a.plan_detected,
        a.tier,
        a.grade,
      ]),
    ).toEqual([['me', 'max', 'default_claude_max_5x', 'PASS']])
    expect(only.out + only.err).not.toContain('SECRET')
    expect(JSON.parse(cli(['expiry', '--json'], env).out).accounts.map((a: { id: string }) => a.id)).toEqual(['iu']) // without --ids the disabled account stays out
    const bad = cli(['expiry', '--ids', 'nope'], env)
    expect(bad.rc).toBe(2)
    expect(bad.err).toContain('unknown account nope')
  })

  const integrations = (name: string, body: unknown) => {
    const p = join(home, `integrations-${name}.json`)
    writeFileSync(p, JSON.stringify(body))
    return { CLAUDE_ACCOUNTS_INTEGRATIONS: p }
  }
  const script = (name: string, body: string) => {
    const p = join(bin, name)
    writeFileSync(p, `#!/bin/sh\n${body}\n`)
    chmodSync(p, 0o755)
    return p
  }

  test("refresh --all imports the peer's usage through integrations.peerUsage once, counts it as a fresh sample, and survives a dead peer", () => {
    const peerJson = join(home, 'peer-usage.json')
    const callLog = join(home, 'peer-args')
    const peer = script('peer-usage', `echo "$@" >> "${callLog}"\ncat "${peerJson}"`)
    const nowS = Math.floor(Date.now() / 1000)
    writeFileSync(
      peerJson,
      JSON.stringify({
        default_account: 'iu',
        accounts: [
          {
            id: 'iu',
            plan: 'max20x',
            enabled: true,
            five_hour: 21,
            seven_day: 44,
            five_hour_resets_at: nowS + 3600,
            seven_day_resets_at: nowS + 86400 * 3,
            five_hour_age_s: 30,
            seven_day_age_s: 30,
            auth_ok: true,
            exhausted_until: null,
          },
        ],
      }),
    )
    seed(60 * 60_000) // a stale local sample: without the peer this is the "neither a sample nor a verdict" exit 1
    rmSync(callLog, { force: true })
    const okBin = join(home, 'bin-peer-ok')
    mkdirSync(okBin, { recursive: true })
    writeFileSync(join(okBin, 'claude'), `#!/bin/sh\necho '{"loggedIn":true}'\n`) // a peer sample counts only with this machine's own verdict
    chmodSync(join(okBin, 'claude'), 0o755)
    const r = cli(['refresh', '--all'], {
      ...integrations('peer', { peerUsage: [peer, 'usage', '--json'] }),
      PATH: `${okBin}:${bin}:${process.env.PATH}`,
    })
    expect(r.rc).toBe(0)
    expect(readFileSync(callLog, 'utf8').trim().split('\n')).toEqual(['usage --json'])
    expect(loadCache(dir).samples.iu).toMatchObject({ s: 21, w: 44, src: 'peer' })
    // a dead peer: one log line, and the run behaves exactly as it did before the import existed
    seed(60 * 60_000)
    const dead = cli(['refresh', '--all'], integrations('dead', { peerUsage: [script('peer-dead', 'exit 255')] }))
    expect(dead.rc).toBe(1)
    expect(dead.err.split('\n').filter((l) => l.includes('peer usage'))).toHaveLength(1)
    expect(dead.err).toContain('no fresh sample and no auth verdict for iu')
    // no integration configured: no peer, same exit
    seed(60 * 60_000)
    expect(cli(['refresh', '--all']).rc).toBe(1)
  })

  test("integrations: the registry's key is read, the machine's overlay file wins key by key, a malformed one switches only its feature off", () => {
    const peerJson = join(home, 'peer-usage2.json')
    const nowS = Math.floor(Date.now() / 1000)
    writeFileSync(
      peerJson,
      JSON.stringify({
        accounts: [
          {
            id: 'iu',
            five_hour: 7,
            seven_day: 8,
            five_hour_resets_at: nowS + 3600,
            seven_day_resets_at: nowS + 86400,
            five_hour_age_s: 1,
            seven_day_age_s: 1,
          },
        ],
      }),
    )
    const loggedIn = join(home, 'bin-logged-in')
    mkdirSync(loggedIn, { recursive: true })
    writeFileSync(join(loggedIn, 'claude'), `#!/bin/sh\necho '{"loggedIn":true}'\n`)
    chmodSync(join(loggedIn, 'claude'), 0o755)
    const env = { PATH: `${loggedIn}:${bin}:${process.env.PATH}` }
    const reg1 = join(home, 'registry-integrations.json')
    writeFileSync(
      reg1,
      JSON.stringify({
        ...reg(false),
        integrations: { peerUsage: [script('peer-from-registry', `echo '{"accounts":[]}'`)] },
      }),
    )
    const viaRegistry = { ...env, CLAUDE_ACCOUNTS_REGISTRY: reg1 }
    seed(60 * 60_000)
    cli(['refresh', '--all'], viaRegistry) // the registry's peer answers an empty list: nothing imported
    expect(loadCache(dir).samples.iu.src).toBe('t')
    seed(60 * 60_000)
    cli(['refresh', '--all'], {
      ...viaRegistry,
      ...integrations('overlay', { peerUsage: [script('peer-from-overlay', `cat "${peerJson}"`)] }),
    })
    expect(loadCache(dir).samples.iu).toMatchObject({ s: 7, w: 8, src: 'peer' })
    seed(60 * 60_000)
    const bad = cli(['refresh', '--all'], { ...env, ...integrations('bad', { peerUsage: 'ssh somewhere' }) })
    expect(bad.err).toContain('claude-account: integrations: peerUsage')
    expect(bad.rc).toBe(0) // logged in, the stored sample is only an hour old
  })

  test('health: the first configured transport that answers wins, a last resort prints its note, an unreadable login is never ok, a silent peer is unreachable', () => {
    const usageJson = JSON.stringify({ default_account: 'iu', accounts: [{ id: 'iu', auth_ok: true, age_s: 30 }] })
    const exp = (severity: string, days: number | null) =>
      JSON.stringify({
        accounts: [
          { id: 'iu', severity, days_left: days, expired: false, refresh_expires_at: days === null ? null : 1 },
        ],
      })
    const payload = (e: string) => `${usageJson}\n@@\n${e}\n@@\n`
    const okOut = join(home, 'peer-ok.txt')
    const unreadableOut = join(home, 'peer-unreadable.txt')
    writeFileSync(okOut, payload(exp('PASS', 12)))
    writeFileSync(unreadableOut, payload(exp('WARN', null)))
    const good = script('snap-good', `cat "${okOut}"`)
    const down = script('snap-down', 'exit 99')
    const plain = script('snap-plain', `cat "${unreadableOut}"`)
    const cfg = (snapshots: unknown[]) =>
      integrations(`health-${Math.random().toString(36).slice(2)}`, {
        health: { local: 'here', fix: 'relogin {id} --machine {machine}', peer: { name: 'there', snapshots } },
      })
    const run = (env: Record<string, string>) => {
      const r = cli(['health', '--json'], env)
      const rows = (
        JSON.parse(r.out).rows as {
          machine: string
          check: string
          state: string
          detail: string
          via?: string
          fix: string | null
        }[]
      ).filter((x) => x.machine === 'there')
      return { rows, err: r.err, text: cli(['health'], env).out }
    }
    const first = run(
      cfg([
        { via: 'core', argv: [good] },
        { via: 'plain', argv: [plain], note: 'went over the plain transport' },
      ]),
    )
    expect(first.rows).toMatchObject([{ state: 'ok', detail: '12 d left', via: 'core', fix: null }])
    expect(first.err).not.toContain('NOTE')
    const second = run(
      cfg([
        { via: 'core', argv: [down] },
        { via: 'plain', argv: [plain], note: 'went over the plain transport' },
      ]),
    )
    expect(second.rows).toMatchObject([{ state: 'warn', detail: 'login expiry unreadable (via plain)', via: 'plain' }])
    expect(second.err).toContain('NOTE there: went over the plain transport')
    expect(second.text).toMatch(/^NOTE there: went over the plain transport/m)
    expect(() =>
      JSON.parse(cli(['health', '--json'], cfg([{ via: 'plain', argv: [plain], note: 'n' }])).out),
    ).not.toThrow() // the note never reaches the JSON on stdout
    const none = run(cfg([{ via: 'core', argv: [down] }]))
    expect(none.rows).toMatchObject([{ check: 'reach', state: 'fail', detail: 'unreachable' }])
    expect(cli(['health'], cfg([{ via: 'core', argv: [down] }])).rc).toBe(1)
    // this machine's own rows carry the configured name and fix; without a peer there are no peer rows
    const local = JSON.parse(cli(['health', '--json'], cfg([{ via: 'core', argv: [good] }])).out).rows.filter(
      (x: { machine: string }) => x.machine === 'here',
    )
    expect(local.length).toBeGreaterThan(0)
    expect(
      JSON.parse(cli(['health', '--json']).out).rows.every((x: { machine: string }) => x.machine !== 'there'),
    ).toBe(true)
  })

  test("health --wake runs the configured notify once per change and re-pushes the peer's pending asks younger than 24 h", async () => {
    const noteLog = join(home, 'notes.log')
    const pushLog = join(home, 'pushes.log')
    rmSync(noteLog, { force: true })
    rmSync(pushLog, { force: true })
    const nowS = Math.floor(Date.now() / 1000)
    const snap = join(home, 'peer-wake.txt')
    writeFileSync(
      snap,
      `${JSON.stringify({ default_account: 'iu', accounts: [{ id: 'iu', auth_ok: false, age_s: 1 }] })}\n@@\n${JSON.stringify({ accounts: [] })}\n@@\n20261119T080000 ${nowS - 60}\nold ${nowS - 3 * 86400}\n`,
    )
    const env = integrations('wake', {
      health: {
        local: 'here',
        notify: [script('notify', `echo "$1" >> "${noteLog}"`), '{message}'],
        peer: {
          name: 'there',
          snapshots: [{ via: 'core', argv: [script('snap-wake', `cat "${snap}"`)] }],
          repush: [script('repush', `echo "$1" >> "${pushLog}"`), '{id}'],
        },
      },
    })
    cli(['health', '--wake'], env)
    for (let i = 0; i < 100 && !existsSync(pushLog); i++) await Bun.sleep(50)
    expect(readFileSync(pushLog, 'utf8').trim().split('\n')).toEqual(['20261119T080000']) // the 3-day-old ask stays
    expect(readFileSync(noteLog, 'utf8')).toContain('there/iu')
    cli(['health', '--wake'], env) // the same picture: the notify is muted
    expect(readFileSync(noteLog, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('refresh --all asks for a re-login of a dead login once per 24 h through integrations.reloginAsk', async () => {
    const asks = join(home, 'asks.log')
    const ask = script('relogin-stub', `echo "$@" >> "${asks}"`)
    const deadBin = join(home, 'bin-dead')
    mkdirSync(deadBin, { recursive: true })
    writeFileSync(join(deadBin, 'claude'), `#!/bin/sh\necho '{"loggedIn": false}'\n`)
    chmodSync(join(deadBin, 'claude'), 0o755)
    const cache2 = join(home, 'cache-ask')
    rmSync(asks, { force: true })
    rmSync(cache2, { recursive: true, force: true })
    const env = {
      ...integrations('ask', { reloginAsk: [ask, '{id}', '--ask', '--reason', '{reason}'] }),
      CLAUDE_ACCOUNTS_CACHE_DIR: cache2,
      PATH: `${deadBin}:${bin}:${process.env.PATH}`,
    }
    expect(cli(['refresh', '--all'], env).rc).toBe(0)
    for (let i = 0; i < 100 && !existsSync(asks); i++) await Bun.sleep(50)
    expect(readFileSync(asks, 'utf8').trim()).toBe('iu --ask --reason login is dead')
    rmSync(join(cache2, 'iu.refresh.claim'), { force: true }) // let the second run through the 5-min refresh budget
    expect(cli(['refresh', '--all'], env).rc).toBe(0)
    await Bun.sleep(300)
    expect(readFileSync(asks, 'utf8').trim().split('\n')).toHaveLength(1) // muted for 24 h
    expect(existsSync(join(cache2, 'iu.relogin-ask.json'))).toBe(true)
    // a plain `refresh` (no --all) and `refresh --ids` never ask
    rmSync(asks, { force: true })
    rmSync(join(cache2, 'iu.relogin-ask.json'), { force: true })
    rmSync(join(cache2, 'iu.refresh.claim'), { force: true })
    cli(['refresh', '--ids', 'iu'], env)
    await Bun.sleep(300)
    expect(existsSync(asks)).toBe(false)
    // nobody to ask (no command configured): nothing is stamped
    rmSync(join(cache2, 'iu.refresh.claim'), { force: true })
    expect(
      cli(['refresh', '--all'], { CLAUDE_ACCOUNTS_CACHE_DIR: cache2, PATH: `${deadBin}:${bin}:${process.env.PATH}` })
        .rc,
    ).toBe(0)
    expect(existsSync(join(cache2, 'iu.relogin-ask.json'))).toBe(false)
  })

  test('latest: newest transcript of the cwd under $HOME/.claude/projects; exit 1 when there is none', () => {
    const cwd = join(home, 'work', 'proj')
    const pd = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, '11111111-aaaa.jsonl'), '')
    expect(cli(['latest', cwd]).out).toBe('11111111-aaaa')
    expect(cli(['latest', join(home, 'elsewhere')]).rc).toBe(1)
  })

  test('the detached refresh a pick spawns appends its stderr to the keepalive log', async () => {
    seed(20 * 60_000) // stale sample: the pick claims iu and refreshes it in a detached child
    const log = join(home, 'Library', 'Logs', 'claude-accounts-keepalive.log')
    rmSync(log, { force: true })
    const r = cli(['pick', '--lane', 'bulk'])
    expect(r.out).toBe('unset CLAUDE_CONFIG_DIR') // the child's output never reaches the pick's stdout
    for (let i = 0; i < 100 && !(existsSync(log) && readFileSync(log, 'utf8').includes('no Keychain token')); i++)
      await Bun.sleep(50)
    expect(readFileSync(log, 'utf8')).toContain('refresh iu: no Keychain token')
    seed(60_000)
  })
  test('pick prints the line; interactive and bulk both give unset', () => {
    seed(60_000)
    expect(cli(['pick', '--lane', 'bulk'])).toMatchObject({ rc: 0, out: 'unset CLAUDE_CONFIG_DIR' })
    expect(cli(['pick', '--lane', 'interactive'])).toMatchObject({ rc: 0, out: 'unset CLAUDE_CONFIG_DIR' })
  })
  test('pick --dry answers like pick but writes no picks line and refreshes nothing', () => {
    seed(20 * 60_000) // stale: a real pick would spawn a background refresh
    const picks = join(home, 'picks.jsonl')
    rmSync(picks, { force: true })
    expect(cli(['pick', '--lane', 'bulk', '--dry', '--why'])).toMatchObject({ rc: 0 })
    expect(existsSync(picks)).toBe(false)
    expect(existsSync(marker)).toBe(false)
    seed(60_000) // fresh: the real pick must not leave a detached refresh behind for the next test
    expect(cli(['pick', '--lane', 'bulk']).rc).toBe(0)
    expect(existsSync(picks)).toBe(true)
  })
  test('pick with an unreadable registry still answers, and says why on stderr', () => {
    const r = cli(['pick', '--lane', 'bulk'], { CLAUDE_ACCOUNTS_REGISTRY: join(home, 'missing.json') })
    expect(r).toMatchObject({ rc: 4, out: 'unset CLAUDE_CONFIG_DIR' })
    expect(r.err).toContain('registry unreadable')
    expect(
      cli(['pick', '--lane', 'bulk', '--why'], { CLAUDE_ACCOUNTS_REGISTRY: join(home, 'missing.json') }).out,
    ).toContain('reason=registry-error')
  })
  test('a pick with an unwritable cache dir still prints a line', () => {
    seed(20 * 60_000)
    writeFileSync(join(home, 'notadir'), '')
    const r = cli(['pick', '--lane', 'bulk'], { CLAUDE_ACCOUNTS_CACHE_DIR: join(home, 'notadir') })
    expect(r.out).toBe('spill') // nothing readable -> the bulk spill signal, never silence
    expect(r.rc).toBe(3)
    expect(r.err).toContain('refresh skipped')
  })
  test('usage --json keeps its shape', () => {
    seed(60_000)
    const j = JSON.parse(cli(['usage', '--json']).out)
    expect(Object.keys(j.accounts[0]).sort()).toEqual(
      [
        'age_s',
        'auth_ok',
        'enabled',
        'exhausted_until',
        'five_hour',
        'five_hour_age_s',
        'five_hour_resets_at',
        'id',
        'plan',
        'session_limit',
        'seven_day',
        'seven_day_age_s',
        'seven_day_resets_at',
        'source',
      ].sort(),
    )
    expect(j.default_account).toBe('iu')
    expect(j.accounts[0]).toMatchObject({ id: 'iu', five_hour: 5, seven_day: 5, auth_ok: true })
  })
  test('account / --badge: unregistered dir prints ?, unset prints the id', () => {
    expect(cli(['account']).out).toBe('iu')
    expect(cli(['account', '--badge']).out).toBe('')
    expect(cli(['account'], { CLAUDE_CONFIG_DIR: '/nowhere' }).out).toBe('?')
    expect(cli(['account', '--badge'], { CLAUDE_CONFIG_DIR: '/nowhere' }).out).toBe('?')
  })
  test('env: valid account, unknown id, disabled account', () => {
    expect(cli(['env', 'iu'])).toMatchObject({ rc: 0, out: 'unset CLAUDE_CONFIG_DIR' })
    expect(cli(['env', 'nope']).rc).toBe(2)
    expect(cli(['env']).rc).toBe(2)
    const both = join(home, 'both.json')
    writeFileSync(both, JSON.stringify(reg(true)))
    expect(cli(['env', 'me'], { CLAUDE_ACCOUNTS_REGISTRY: both })).toMatchObject({
      rc: 0,
      out: "export CLAUDE_CONFIG_DIR='/home/x/.claude-me'",
    })
    expect(cli(['env', 'me']).rc).toBe(2) // disabled in the default fixture
  })
  test('record and exhausted write their own files', () => {
    seed(60_000)
    expect(cli(['record', '--account', 'iu', '--s', '33', '--s-reset', '1800000000']).rc).toBe(0)
    expect(cli(['exhausted', '--account', 'iu', '--until', '1800000999']).rc).toBe(0)
    const c = loadCache(dir)
    expect(c.samples.iu).toMatchObject({ s: 33, w: 5 })
    expect(JSON.parse(readFileSync(join(dir, 'iu.statusline.json'), 'utf8')).ts).toBeGreaterThan(0)
    expect(c.exhausted.iu).toBe(1800000999)
  })
  test('refresh --ids retries an auth-failed account inside the cooldown; a plain refresh does not', () => {
    seed(20 * 60_000)
    setAuthFailed('iu', true, Date.now(), dir)
    expect(cli(['refresh']).rc).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(cli(['refresh', '--ids', 'iu']).rc).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })
  test('refresh --all exits 1 when the account got neither a fresh sample nor a verdict', () => {
    seed(60_000)
    const r = cli(['refresh', '--all']) // the fake claude exits 0 and fetches nothing
    expect(r.rc).toBe(1)
    expect(r.err).toContain('no fresh sample and no auth verdict for iu')
  })
  test('refresh --all: logged in without an endpoint sample exits 1 when the stored sample is older than 6 h, 0 when younger', () => {
    const loggedInBin = join(home, 'bin-loggedin')
    mkdirSync(loggedInBin, { recursive: true })
    writeFileSync(join(loggedInBin, 'claude'), `#!/bin/sh\necho '{"loggedIn":true}'\n`)
    chmodSync(join(loggedInBin, 'claude'), 0o755)
    const env = { PATH: `${loggedInBin}:${bin}:${process.env.PATH}` }
    seed(7 * 3600_000)
    const old = cli(['refresh', '--all'], env)
    expect(old.rc).toBe(1)
    expect(old.err).toMatch(/refresh iu: logged in .* 7 h old/)
    expect(old.err).toContain('iu logged in but still without a fresh sample')
    seed(5 * 3600_000)
    rmSync(join(dir, 'iu.refresh.claim'), { force: true })
    expect(cli(['refresh', '--all'], env).rc).toBe(0)
  })
  test('--account / env reject prototype keys', () => {
    for (const id of ['constructor', '__proto__', 'toString']) {
      expect(cli(['record', '--account', id, '--s', '1']).rc).toBe(2)
      expect(cli(['exhausted', '--account', id, '--until', '1800000999']).rc).toBe(2)
      expect(cli(['env', id]).rc).toBe(2)
    }
  })
  test('refresh --ids applies the due filter; --claimed bypasses the claim', () => {
    seed(60_000)
    expect(cli(['refresh', '--ids', 'iu']).rc).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(cli(['refresh', '--claimed', 'me']).rc).toBe(0) // disabled, even when claimed
    expect(existsSync(marker)).toBe(false)
    expect(cli(['refresh', '--claimed', 'iu']).rc).toBe(0)
    expect(existsSync(marker)).toBe(true)
    seed(20 * 60_000)
    expect(cli(['refresh', '--ids', 'iu']).rc).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(join(dir, 'iu.refresh.claim'))).toBe(true)
    rmSync(home, { recursive: true, force: true })
  })
})

describe('type guards', () => {
  const dir = tmp()
  const regFile = (accounts: unknown) => {
    const p = join(dir, `reg-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(p, JSON.stringify({ accounts }))
    return p
  }
  const good = { dir: null, plan: 'p', units: { session: 1, weekly: 1 }, homeLanes: ['x'], enabled: true }
  test('loadRegistry accepts a good registry and rejects malformed accounts', () => {
    expect(Object.keys(loadRegistry(regFile({ iu: good })).accounts)).toEqual(['iu'])
    expect(() => loadRegistry(regFile({ iu: { ...good, enabled: 'yes' } }))).toThrow(/malformed/)
    expect(() => loadRegistry(regFile({ iu: { ...good, homeLanes: 'bulk' } }))).toThrow(/malformed/)
    expect(() => loadRegistry(regFile({ iu: { ...good, units: {} } }))).toThrow(/malformed/)
    expect(() => loadRegistry(regFile({ 'a/b': good }))).toThrow(/bad account id/)
    expect(() => loadRegistry(regFile({ spill: good }))).toThrow(/bad account id/) // the pick's no-headroom signal
    expect(() => loadRegistry(regFile({ me: { ...good, dir: '~/.claude-me' } }))).toThrow(/default/)
    expect(() => loadRegistry(regFile(null))).toThrow()
  })
  test('loadCache drops malformed sample files', () => {
    const d = tmp()
    saveSample('iu', sample(1, 2), d)
    writeFileSync(join(d, 'b.sample.json'), JSON.stringify({ s: 'lots' }))
    writeFileSync(join(d, 'c.sample.json'), 'not json')
    expect(Object.keys(loadCache(d).samples)).toEqual(['iu'])
    expect(isSample({ ...sample(1, 2), s_ts: 'x' })).toBe(false)
    rmSync(d, { recursive: true })
  })
  test('claimRefresh: an unreadable claim is a lost race, other ids still proceed', () => {
    const d = tmp()
    mkdirSync(join(d, 'iu.refresh.claim')) // EEXIST, and readFileSync on a directory throws
    const r = reg()
    const stale2 = cacheOf(sample(1, 1, { age: 11 * 60_000 }), sample(1, 1, { age: 11 * 60_000 }))
    expect(claimRefresh(r, ['iu', 'me'], NOW, stale2, d)).toEqual(['me'])
    rmSync(d, { recursive: true })
  })
})

describe('expiring weekly ceiling', () => {
  const meCalm = sample(10, 2, { wReset: NOW / 1000 + 6.5 * 24 * H })
  test('93% weekly resetting within 24 h stays eligible', () => {
    expect(
      pick(reg(), cacheOf(sample(1, 93, { wReset: NOW / 1000 + 20 * H }), meCalm), 'interactive', NOW),
    ).toMatchObject({ picked: 'iu' })
  })
  test('98% weekly resetting within 24 h is out', () => {
    expect(
      pick(reg(), cacheOf(sample(1, 98, { wReset: NOW / 1000 + 20 * H }), meCalm), 'interactive', NOW),
    ).toMatchObject({ picked: 'me' })
  })
  test('93% weekly with the reset days away is out', () => {
    expect(
      pick(reg(), cacheOf(sample(1, 93, { wReset: NOW / 1000 + 60 * H }), meCalm), 'interactive', NOW),
    ).toMatchObject({ picked: 'me' })
  })
})

// ── plans without a 5 h session window (Ultra) ─────────────────────────────────────────────────────────────────
describe('plan tiers: Max has a 5 h window, Ultra only a weekly one', () => {
  const ultraReg = (): Registry => ({
    accounts: {
      iu: { dir: null, plan: 'ultra', homeLanes: ['interactive', 'headless'], enabled: true },
      me: { dir: '/home/x/.claude-me', plan: 'max', homeLanes: ['bulk'], enabled: true },
    },
  })
  const acct = (plan: string) => ({ dir: null, plan, homeLanes: [], enabled: true })

  test('plan names: max/ultra, the legacy maxNx still reads (as a Max with a session window)', () => {
    expect(planTier('max5x')).toBe('max')
    expect(planTier(' MAX20x ')).toBe('max')
    expect(planTier('ultra')).toBe('ultra')
    expect(hasSessionLimit(acct('ultra'))).toBe(false)
    for (const p of ['max', 'max5x', 'max20x', 'pro']) expect(hasSessionLimit(acct(p))).toBe(true)
    expect(accountUnits(acct('ultra'))).toEqual({ session: 4, weekly: 2 })
    expect(accountUnits(acct('max'))).toEqual({ session: 1, weekly: 1 })
    expect(accountUnits(acct('max20x'))).toEqual({ session: 4, weekly: 2 })
  })
  test('the fixture registry names the real tiers', () => {
    const r = loadRegistry(join(import.meta.dir, 'fixtures', 'registry.json'))
    expect(Object.values(r.accounts).every((a) => ['max', 'ultra'].includes(a.plan))).toBe(true)
    expect(r.accounts.iu.plan).toBe('ultra')
  })
  test('Ultra is never blocked or demoted by a stale 5 h sample; the same sample blocks a Max', () => {
    const frozen = { ...sample(97, 10), s_ts: NOW - 60_000 } // a leftover 97% session half, young enough to be judged
    expect(pick(ultraReg(), cacheOf(frozen, sample(10, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'iu',
      reason: 'home',
    })
    const hot = { ...sample(85, 10) } // above SESSION_SOFT_MAX: a Max is the last choice, Ultra is not
    expect(pick(ultraReg(), cacheOf(hot, sample(10, 10)), 'interactive', NOW).picked).toBe('iu')
    const maxReg = ultraReg()
    maxReg.accounts.iu.plan = 'max'
    expect(pick(maxReg, cacheOf(frozen, sample(10, 10)), 'interactive', NOW).picked).toBe('me')
    expect(pick(maxReg, cacheOf(hot, sample(10, 10)), 'interactive', NOW).picked).toBe('me')
  })
  test('Max keeps the 5 h logic: SESSION_MAX blocks, SESSION_SOFT_MAX demotes, the emptier window wins', () => {
    const r = ultraReg()
    r.accounts.iu.plan = 'max'
    expect(pick(r, cacheOf(sample(SESSION_MAX, 10), sample(10, 10)), 'interactive', NOW).picked).toBe('me')
    expect(pick(r, cacheOf(sample(SESSION_SOFT_MAX, 10), sample(10, 10)), 'interactive', NOW).picked).toBe('me')
    expect(pick(r, cacheOf(sample(70, 10), sample(10, 10)), 'interactive', NOW)).toMatchObject({
      picked: 'me',
      reason: 'session',
    })
  })
  test('Ultra takes no part in the session move, as home or as the alternative', () => {
    const meFull = sample(75, 10)
    expect(pick(ultraReg(), cacheOf(sample(5, 10), meFull), 'bulk', NOW).picked).not.toBe('iu') // me is home for bulk, iu's 5% is no emptier window
    expect(pick(ultraReg(), cacheOf(sample(5, 10), meFull), 'bulk', NOW).reason).not.toBe('session')
  })
  test('withoutSessionWindows strips only the plans without a session limit', () => {
    const c = withoutSessionWindows(ultraReg(), cacheOf(sample(50, 20), sample(50, 20)))
    expect(c.samples.iu).toMatchObject({ s: null, s_reset: null, s_ts: null, w: 20 })
    expect(c.samples.me).toMatchObject({ s: 50, w: 20 })
  })
  test('mergeSample drops a stored session half when the endpoint answers with a weekly window only', () => {
    const prev = { ...sample(88, 30), s_ts: NOW - 3 * 3600_000, w_ts: NOW - 3 * 3600_000 }
    const inc: Sample = {
      s: null,
      s_reset: null,
      s_ts: null,
      w: 31,
      w_reset: NOW / 1000 + 100 * H,
      w_ts: NOW,
      src: 'oauth',
    }
    expect(mergeSample(prev, inc)).toMatchObject({ s: null, s_reset: null, s_ts: null, w: 31, w_ts: NOW })
    // a delayed weekly-only answer older than the stored session reading keeps that newer session
    const newerS = { ...sample(88, 30), s_ts: NOW - 1000, w_ts: NOW - 3 * 3600_000 }
    expect(mergeSample(newerS, { ...inc, w_ts: NOW - 60_000 })).toMatchObject({ s: 88, s_ts: NOW - 1000, w: 31 })
    expect(mergeSample(newerS, { ...inc, w_ts: NOW })).toMatchObject({ s: null, s_ts: null, w: 31 })
    // a feed that merely omits the window (statusline, peer) still keeps what we know
    expect(mergeSample(prev, { ...inc, src: 'statusline' })).toMatchObject({ s: 88 })
    // an endpoint answer with nothing at all is no evidence
    expect(mergeSample(prev, { ...inc, w: null, w_reset: null, w_ts: null })).toMatchObject({ s: 88 })
  })
  test('saveSample for a plan without a session limit never stores or keeps a session half', () => {
    const d = tmp()
    saveSample('iu', { ...sample(88, 30), src: 'statusline' }, d) // a leftover from before the plan was known
    saveSample(
      'iu',
      { s: 90, s_reset: NOW / 1000, s_ts: NOW, w: 31, w_reset: NOW / 1000 + 100 * H, w_ts: NOW, src: 'statusline' },
      d,
      false,
    )
    expect(loadCache(d).samples.iu).toMatchObject({ s: null, s_reset: null, s_ts: null, w: 31 })
    recordSample('iu', { s: 77, w: 32 }, NOW, d, false)
    expect(loadCache(d).samples.iu).toMatchObject({ s: null, w: 32 })
    rmSync(d, { recursive: true })
  })
  test('dueIds ignores a leftover session timestamp: an Ultra with a fresh weekly window is not due', () => {
    const old = { ...sample(88, 30), s_ts: NOW - 20 * 60_000 } // weekly fresh (1 min), session 20 min old
    expect(dueIds(ultraReg(), cacheOf(old, sample(1, 1)), NOW)).toEqual([])
    const maxReg = ultraReg()
    maxReg.accounts.iu.plan = 'max'
    expect(dueIds(maxReg, cacheOf(old, sample(1, 1)), NOW)).toEqual(['iu'])
  })
})

describe("rank: the picker's order of every eligible account", () => {
  const D = 24 * H
  const order = (c: Cache, lane: string) => rank({ reg: reg3(), cache: c, lane, nowMs: NOW })
  const iu = sample(10, 80, { wReset: NOW / 1000 + 32 * H })
  const me = sample(4, 54, { wReset: NOW / 1000 + 46 * H })
  const me2 = sample(5, 11, { wReset: NOW / 1000 + 5.5 * D })
  test('bulk lane: the soonest reset inside the 72 h horizon first (v1.9), then home', () => {
    const r = order(cache3(iu, me, me2), 'bulk')
    expect(r.map((e) => e.account)).toEqual(['iu', 'me', 'me2'])
    expect(r.every((e) => typeof e.weight === 'number')).toBe(true)
  })
  test('an ineligible account is absent', () => {
    expect(order(cache3(sample(10, 96), me, me2), 'bulk').map((e) => e.account)).not.toContain('iu')
    const failed: Cache = { ...cache3(iu, me, me2), auth_failed: { me: true } }
    expect(order(failed, 'bulk').map((e) => e.account)).not.toContain('me')
  })
  test('no eligible account: empty order', () => {
    expect(order(cache3(sample(10, 96), sample(10, 96), sample(10, 96)), 'bulk')).toEqual([])
  })
  test('interactive lane starts with iu and has no fallback entry', () => {
    const r = order(cache3(sample(10, 10), me, me2), 'interactive')
    expect(r[0].account).toBe('iu')
    expect(r.some((e) => e.reason === 'interactive-fallback')).toBe(false)
    expect(order(cache3(sample(10, 96), sample(10, 96), sample(10, 96)), 'interactive')).toEqual([])
  })
})

describe('boundedSpawnSync', () => {
  test('a helper holding the capture pipe is killed with the group: returns at the deadline, ETIMEDOUT', () => {
    const n = 20000 + Math.floor(Math.random() * 9000) // unique, so no other process (or this run's own command line) matches below
    const t0 = Date.now()
    const r = boundedSpawnSync('/bin/sh', ['-c', `sleep ${n} & wait`], { timeoutMs: 1000 })
    expect(Date.now() - t0).toBeLessThan(8000)
    expect(r.error?.code).toBe('ETIMEDOUT')
    expect(r.status).toBeNull()
    const left = Bun.spawnSync(['/bin/sh', '-c', `/bin/ps -axo command | /usr/bin/grep -c '[s]leep ${n}' || true`])
      .stdout.toString()
      .trim()
    expect(left).toBe('0')
  })
  test('passes status and output through, and reports a missing binary as ENOENT', () => {
    const ok = boundedSpawnSync('/bin/sh', ['-c', 'echo hi; echo err >&2; exit 3'], { timeoutMs: 5000 })
    expect(ok).toEqual({ status: 3, stdout: 'hi\n', stderr: 'err\n' })
    expect(boundedSpawnSync('/nonexistent/claude', ['auth', 'status'], { timeoutMs: 5000 }).error?.code).toBe('ENOENT')
  })
})

describe('help (--help lists every verb the dispatch accepts and never runs one)', () => {
  const CLI = join(import.meta.dir, '..', 'bin', 'claude-account.ts')
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf8')
  // The verbs `main` dispatches: the `case "<verb>":` labels of its switch.
  const dispatched = (() => {
    const body = src.slice(src.indexOf('switch (cmd) {'), src.indexOf('default:', src.indexOf('switch (cmd) {')))
    return [...body.matchAll(/^ {4}case "([a-z-]+)":/gm)].map((m) => m[1])
  })()

  test('the dispatch was found (the parse below is not vacuous)', () => {
    expect(dispatched.length).toBeGreaterThanOrEqual(13)
  })
  test('every dispatched verb is in the top-level help and has its own help', () => {
    const top = helpText()
    for (const v of dispatched) {
      expect(top, `verb '${v}' missing from helpText()`).toContain(`claude-account ${v}`)
      expect(verbHelp(v), `no verb help for '${v}'`).not.toBeNull()
    }
  })
  test('the help lists no verb the dispatch does not accept', () => {
    expect(VERBS.map((v) => v.name).sort()).toEqual([...dispatched].sort())
  })
  test("verbs meant for a job or a hook sit under 'not for agents' with their caller", () => {
    const [agents, jobs] = helpText().split('Not for agents')
    for (const v of VERBS) expect(v.caller ? jobs : agents).toContain(`claude-account ${v.name}`)
    expect(jobs).toContain('statusline')
  })

  const home = tmp()
  const bin = join(home, 'bin')
  mkdirSync(bin)
  const touched = join(home, 'touched')
  for (const b of ['claude', 'security', 'ssh']) {
    writeFileSync(join(bin, b), `#!/bin/sh\ntouch ${touched}\nexit 1\n`)
    chmodSync(join(bin, b), 0o755)
  }
  const cacheDir = join(home, 'cache')
  const picks = join(home, 'picks.jsonl')
  const env = {
    ...(process.env as Record<string, string>),
    HOME: home,
    CLAUDE_ACCOUNTS_REGISTRY: join(home, 'no-such-registry.json'),
    CLAUDE_ACCOUNTS_CACHE_DIR: cacheDir,
    CLAUDE_ACCOUNTS_PICKS: picks,
    CLAUDE_ACCOUNTS_SECURITY_BIN: join(bin, 'security'),
    PATH: `${bin}:${process.env.PATH}`,
  }
  const cli = (args: string[]) => {
    const r = Bun.spawnSync(['bun', CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    return { rc: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
  }

  test('--help, -h, help and a bare call print the verbs on stdout, exit 0, with no registry', () => {
    for (const args of [['--help'], ['-h'], ['help'], []]) {
      const r = cli(args)
      expect(r.rc, args.join(' ')).toBe(0)
      for (const v of dispatched) expect(r.out).toContain(`claude-account ${v}`)
    }
    expect(cli(['help', 'pick']).out).toContain('--lane')
  })
  test('<verb> --help has no side effect: no cache, no pick log, no Keychain, ssh or claude call', () => {
    for (const v of dispatched) {
      const r = cli([v, '--help'])
      expect(r.rc, v).toBe(0)
      expect(r.out, v).toContain(`claude-account ${v}`)
      expect(r.err, v).toBe('')
    }
    // the flags a verb takes before --help must not be acted on either
    expect(cli(['pick', '--lane', 'interactive', '--help']).rc).toBe(0)
    expect(cli(['record', '--account', 'iu', '--s', '5', '--help']).rc).toBe(0)
    expect(existsSync(cacheDir)).toBe(false)
    expect(existsSync(picks)).toBe(false)
    expect(existsSync(touched)).toBe(false)
  })
  test('an unknown verb is still a usage error that names the real verbs', () => {
    const r = cli(['frobnicate'])
    expect(r.rc).toBe(2)
    expect(r.err).toContain('rank')
    expect(r.err).toContain('health')
  })
})
