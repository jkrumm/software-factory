// One weekly figure per account (packages/accounts/docs/accounts.md §Sources of a sample): the newest usable reading across the
// statusline feed, the peer sample and the usage endpoint's weekly_all limit is the one an account is judged by, and the health
// line blames the token only when the endpoint call itself failed with an auth error.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Cache,
  type HttpGet,
  type Registry,
  type Sample,
  buildStatus,
  closure,
  emptyCache,
  emptyOverrides,
  gradeMachine,
  loadCache,
  resolveModes,
  runRefresh,
  sampleFromOAuthUsage,
  saveSample,
  statusLine,
} from '../src/index.ts'

const NOW = Date.parse('2026-11-22T12:06:00Z')
const H = 3600_000
const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-source-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const reg = (): Registry => ({
  accounts: {
    iu: { dir: null, plan: 'ultra', homeLanes: ['interactive', 'headless'], enabled: true },
    me: { dir: '/home/x/.claude-me', plan: 'max', homeLanes: ['bulk'], enabled: true },
  },
})

/** The usage endpoint's body for an ultra account, as `claude-account usage --json` recorded it on 2026-11-22: no five_hour, no seven_day, the weekly figure only in limits[]. */
const ULTRA_BODY = {
  five_hour: null,
  seven_day: null,
  limits: [
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 97,
      severity: 'critical',
      resets_at: '2026-11-25T16:00:00.252705+00:00',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 94,
      severity: 'critical',
      resets_at: '2026-11-25T16:00:00.252858+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
  weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 47, allowance_percent_of_weekly: 50 }],
}
/** A max account's body: both windows, and the same weekly figure in limits[] (recorded 2026-11-22, trimmed). */
const MAX_BODY = {
  five_hour: { utilization: 17, resets_at: '2026-11-22T14:40:00.806941+00:00' },
  seven_day: { utilization: 88, resets_at: '2026-11-26T06:00:00.806963+00:00' },
  limits: [
    { kind: 'session', percent: 17, resets_at: '2026-11-22T14:40:00.806941+00:00', scope: null },
    { kind: 'weekly_all', percent: 88, resets_at: '2026-11-26T06:00:00.806963+00:00', scope: null },
  ],
}
const RESET = Math.round(Date.parse('2026-11-25T16:00:00.252705+00:00') / 1000)

const statusline = (w: number, ageMs: number): Sample => ({
  s: null,
  s_reset: null,
  s_ts: null,
  w,
  w_reset: RESET,
  w_ts: NOW - ageMs,
  src: 'statusline',
})
const status = (cache: Cache) =>
  buildStatus({
    reg: reg(),
    cache,
    views: resolveModes(reg(), emptyOverrides(), cache, NOW),
    history: {},
    nowMs: NOW,
    machine: 'mini',
  })
const iuOf = (cache: Cache) => status(cache).accounts.find((a) => a.id === 'iu')!
const weekly = (cache: Cache) => iuOf(cache).limits.find((l) => l.kind === 'weekly_all')

describe('the usage endpoint body of an ultra account', () => {
  test('its weekly_all limit is the weekly window of the sample', () => {
    expect(sampleFromOAuthUsage(ULTRA_BODY, NOW)).toMatchObject({
      s: null,
      w: 97,
      w_reset: RESET,
      w_ts: NOW,
      src: 'oauth',
      w_src: 'limits',
      limits_ts: NOW,
    })
  })
  test('a body with seven_day keeps it as the weekly window', () => {
    const s = sampleFromOAuthUsage(MAX_BODY, NOW)!
    expect(s).toMatchObject({ s: 17, w: 88, w_ts: NOW })
    expect(s).not.toHaveProperty('w_src')
  })
  test('a weekly_all limit without a percent or a reset is no window: the body stays no sample', () => {
    const limits = (l: Record<string, unknown>) => ({ limits: [{ kind: 'weekly_all', ...l }] })
    expect(sampleFromOAuthUsage(limits({ percent: 97 }), NOW)).toBeNull()
    expect(sampleFromOAuthUsage(limits({ resets_at: '2026-11-25T16:00:00+00:00' }), NOW)).toBeNull()
  })

  test("the account's weekly percent, forecast and closed reason come from the limit, whatever a peer sample said before", () => {
    const dir = tmp()
    // the 2026-11-22 state of iu: a peer window of 18 % read 6 h ago
    saveSample('iu', { ...statusline(18, 22_961_000), src: 'peer' }, dir, false, NOW)
    saveSample('iu', sampleFromOAuthUsage(ULTRA_BODY, NOW)!, dir, false, NOW)
    const cache = loadCache(dir)
    expect(cache.samples.iu).toMatchObject({ w: 97, w_ts: NOW, w_reset: RESET })
    const a = iuOf(cache)
    expect(weekly(cache)).toMatchObject({ percent: 97, source: 'oauth', age_s: 0 })
    expect(a.closed).toMatchObject({ closed: 'weekly-ceiling' })
    expect(a.forecast).not.toBeNull()
    expect(a.forecast!.weekly_at_reset).toBeGreaterThanOrEqual(97)
    expect(statusLine(a, NOW)).toContain('weekly 97 %')
  })
})

describe('the newest usable reading wins, whichever feed it came from', () => {
  const weeklyAfter = (steps: Sample[]) => {
    const dir = tmp()
    for (const s of steps) saveSample('iu', s, dir, false, NOW)
    return loadCache(dir).samples.iu
  }
  const endpointAt = (ageMs: number) => {
    const s = sampleFromOAuthUsage(ULTRA_BODY, NOW - ageMs)!
    return s
  }

  test('a statusline sample newer than the endpoint one is in force', () => {
    expect(weeklyAfter([endpointAt(3 * H), statusline(60, 13_000)])).toMatchObject({ w: 60, src: 'statusline' })
    expect(weeklyAfter([statusline(60, 13_000), endpointAt(3 * H)])).toMatchObject({ w: 60, src: 'statusline' })
  })
  test('an endpoint limit newer than the statusline sample is in force', () => {
    const x = weeklyAfter([statusline(95, 5 * H), endpointAt(60_000)])
    expect(x).toMatchObject({ w: 97, w_src: 'limits', w_ts: NOW - 60_000 })
    expect(weeklyAfter([endpointAt(60_000), statusline(95, 5 * H)])).toMatchObject({ w: 97, w_src: 'limits' })
  })
  test('a stored sample whose limit set is newer than its window reads as the limit', () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    const stored = { ...statusline(18, 22_961_000), src: 'peer', limits: ULTRA_BODY.limits, limits_ts: NOW - 154_000 }
    writeFileSync(join(dir, 'iu.sample.json'), JSON.stringify(stored))
    expect(loadCache(dir).samples.iu).toMatchObject({ w: 97, w_ts: NOW - 154_000, w_src: 'limits' })
  })
  test('a newer statusline window drops the limit mark', () => {
    const x = weeklyAfter([endpointAt(3 * H), statusline(60, 1_000)])
    expect(x).not.toHaveProperty('w_src')
  })
  test('with no usable sample from any source the account is still closed as no-sample', () => {
    const empty: Sample = { s: null, s_reset: null, s_ts: null, w: null, w_reset: null, w_ts: null, src: 'oauth' }
    const cache: Cache = { ...emptyCache(), samples: { iu: empty } }
    expect(closure(reg(), cache, 'iu', NOW)).toMatchObject({ closed: 'no-sample' })
  })
})

describe('refresh with an ultra account', () => {
  const TOKEN = 'oat-SECRET'
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: 1 }, mcpOAuth: {} })
  const run = async (http: HttpGet) => {
    const dir = tmp()
    saveSample('iu', { ...statusline(18, 22_961_000), src: 'peer' }, dir, false, NOW)
    const results = await runRefresh({
      reg: reg(),
      claudeBin: 'claude',
      baseEnv: { PATH: '/bin', USER: 'owner' },
      now: () => NOW,
      ids: ['iu'],
      dir,
      spawn: (cmd) =>
        cmd === '/usr/bin/security'
          ? { status: 0, stdout: `${creds}\n`, stderr: '' }
          : { status: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' },
      httpGet: http,
    })
    return { results, cache: loadCache(dir) }
  }

  test('the answered call is a fresh weekly sample, not no-sample', async () => {
    const r = await run(async () => ({ status: 200, json: ULTRA_BODY }))
    expect(r.results).toEqual({ iu: 'fresh' })
    expect(r.cache.samples.iu).toMatchObject({ w: 97, w_ts: NOW })
    expect(r.cache.endpoint?.iu).toEqual({ at: NOW, status: 200, outcome: 'ok' })
    expect(closure(reg(), r.cache, 'iu', NOW)).toMatchObject({ closed: 'weekly-ceiling' })
  })
  test('an endpoint call that answered without a weekly window is recorded as that', async () => {
    const r = await run(async () => ({ status: 200, json: { five_hour: null, seven_day: null, limits: [] } }))
    expect(r.cache.endpoint?.iu).toEqual({ at: NOW, status: 200, outcome: 'no-weekly' })
  })
  test('an auth error, a 429 and no answer are told apart', async () => {
    expect((await run(async () => ({ status: 403, json: null }))).cache.endpoint?.iu.outcome).toBe('auth')
    expect((await run(async () => ({ status: 429, json: null }))).cache.endpoint?.iu).toMatchObject({
      outcome: 'http',
      status: 429,
    })
    expect(
      (
        await run(async () => {
          throw new Error('timeout')
        })
      ).cache.endpoint?.iu,
    ).toMatchObject({ outcome: 'unreachable', status: null })
  })
})

describe('health says why there is no quota sample', () => {
  const row = (endpoint: { outcome: string; status: number | null } | null | undefined) =>
    gradeMachine('mini', {
      usage: { default_account: 'iu', accounts: [{ id: 'iu', auth_ok: true, age_s: 6 * 3600 + 10, endpoint }] },
      expiry: null,
      pending: null,
    }).find((r) => r.check === 'quota')!

  test("'token rejected' only for an auth error of the endpoint call, with the re-login as the fix", () => {
    expect(row({ outcome: 'auth', status: 401 })).toMatchObject({
      detail: 'no quota sample for 6 h (token rejected: usage endpoint HTTP 401)',
      fix: 'claude-relogin iu --machine mini',
    })
  })
  test('an answered call without a weekly window says that, and sends nobody to a re-login', () => {
    expect(row({ outcome: 'no-weekly', status: 200 })).toMatchObject({
      detail: 'no quota sample for 6 h (the usage endpoint answered with no weekly window)',
      fix: null,
    })
    expect(row({ outcome: 'http', status: 429 })).toMatchObject({
      detail: expect.stringContaining('HTTP 429'),
      fix: null,
    })
    expect(row({ outcome: 'unreachable', status: null }).fix).toBeNull()
    expect(row({ outcome: 'ok', status: 200 })).toMatchObject({
      detail: expect.stringContaining('call succeeded'),
      fix: null,
    })
  })
  test('no recorded call (an older peer) makes no claim about the token', () => {
    for (const e of [null, undefined]) {
      expect(row(e).detail).not.toContain('token rejected')
      expect(row(e).fix).toBeNull()
    }
  })
})

interface UsageRow {
  seven_day: number | null
  seven_day_source: string | null
  source: string | null
  limits: { kind: string; percent: number; in_force?: boolean }[]
}

describe('usage --json says which weekly figure is in force', () => {
  const CLI = join(import.meta.dir, '..', 'bin', 'claude-account.ts')
  const usage = (setup: (dir: string, now: number) => void) => {
    const home = tmp()
    const dir = join(home, 'cache')
    const registry = join(home, 'registry.json')
    writeFileSync(registry, JSON.stringify({ accounts: { iu: reg().accounts.iu } }))
    setup(dir, Date.now())
    const r = Bun.spawnSync(['bun', CLI, 'usage', '--json'], {
      env: {
        ...(process.env as Record<string, string>),
        HOME: home,
        CLAUDE_ACCOUNTS_REGISTRY: registry,
        CLAUDE_ACCOUNTS_CACHE_DIR: dir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).toBe(0)
    return (JSON.parse(r.stdout.toString()) as { accounts: UsageRow[] }).accounts[0]
  }

  test('the endpoint limit newer than the stored window is the seven_day figure and says so', () => {
    const row = usage((dir, now) => {
      saveSample('iu', { ...statusline(18, 22_961_000), w_ts: now - 22_961_000, src: 'peer' }, dir, false, now)
      saveSample('iu', sampleFromOAuthUsage(ULTRA_BODY, now - 154_000)!, dir, false, now)
    })
    expect(row).toMatchObject({ seven_day: 97, seven_day_source: 'oauth', source: 'oauth' })
    expect(row.limits.find((l) => l.kind === 'weekly_all')).toMatchObject({
      percent: 97,
      in_force: true,
    })
  })
  test('an older limit is marked as not in force when the statusline is newer', () => {
    const row = usage((dir, now) => {
      saveSample('iu', sampleFromOAuthUsage(ULTRA_BODY, now - 3 * H)!, dir, false, now)
      saveSample('iu', { ...statusline(60, 0), w_ts: now - 13_000 }, dir, false, now)
    })
    expect(row).toMatchObject({ seven_day: 60, seven_day_source: 'statusline' })
    expect(row.limits.find((l) => l.kind === 'weekly_all')).toMatchObject({
      percent: 97,
      in_force: false,
    })
  })
})
