// The policy lab's simulation (packages/accounts/docs/accounts.md §The policy lab): weeks of sticky sessions against staggered weekly
// resets and 5 h windows, on a load model (load-model.ts), judged by the weekly percent each account reaches at its reset
// (unused = lost), the work that found no account (blocked) and the sessions that hit a wall and moved. Pure and seeded:
// the same scenario gives the same result.
import {
  type Cache,
  type PolicyName,
  type Registry,
  type Sample,
  DEFAULT_POLICY,
  POLICY_NAMES,
  SPILL,
  emptyCache,
  pickWith,
  required,
  requiredAt,
} from './policy.ts'
import { type LaneClass, type LoadModel, curveAt, fixedSessions, sessionHoursAt, sessionRatio } from './load-model.ts'

const STEP_MS = 15 * 60_000
const HOUR_MS = 3600_000
const WEEK_MS = 7 * 24 * HOUR_MS
/** A Monday 00:00 UTC: the week the reset offsets count from. */
export const SIM_T0 = Date.UTC(2026, 10, 2, 0, 0)

export interface SimAccount {
  id: string
  plan: string
  weeklyUnits: number
  /** null: no 5 h window (Ultra) */
  sessionUnits: number | null
  /** hours after SIM_T0 of the first weekly reset */
  resetOffsetH: number
}

/** The lane each class of the measured mix is simulated as. */
export const LANE_OF_CLASS: Record<LaneClass, string> = {
  interactive: 'interactive',
  headless: 'headless',
  bulk: 'bulk',
  homeless: 'lead',
}

/** What a custom chooser sees (a reference policy that is not a picker policy, such as the factory's former roomLeft). */
export interface ChooseCtx {
  lane: string
  now: number
  cache: Cache
  walled: (id: string) => boolean
}

export interface Scenario {
  accts: SimAccount[]
  /** the registry the picker sees; default: poolRegistry(accts) */
  reg?: Registry
  /** the pool's demand as a share of its weekly capacity */
  demand: number
  model: LoadModel
  /** default: the registry's live policy, else v1.9 */
  policy?: PolicyName
  /** replaces the picker */
  choose?: (c: ChooseCtx) => string | null
  /** lane -> weight; default: the model's mix (LANE_OF_CLASS) */
  mix?: Record<string, number>
  seed?: number
  weeks?: number
  /** weekly percent per account at t0; set, the first week's resets count too */
  start?: Record<string, number>
  t0?: number
}

export interface SimResult {
  /** weekly % at each reset after the first week, per account */
  atReset: Record<string, number[]>
  /** capacity-weighted share of the weekly quota used at those resets (0..1) */
  used: number
  /** share of the demanded work that found no account */
  blocked: number
  /** sessions that hit a wall mid-run and had to move */
  moved: number
  picks: Record<string, number>
  sessions: number
  /** hours from the start until each account first reached 98 % */
  firstFull: Record<string, number | null>
}

/** A registry for a simulated pool: the first account owns the interactive and headless lanes, every Max the bulk lane. */
export function poolRegistry(accts: SimAccount[]): Registry {
  return {
    accounts: Object.fromEntries(
      accts.map((a, i) => [
        a.id,
        {
          dir: i === 0 ? null : `/sim/.claude-${a.id}`,
          plan: a.plan,
          units: { session: a.sessionUnits ?? 4, weekly: a.weeklyUnits },
          homeLanes: i === 0 ? ['interactive', 'headless'] : a.sessionUnits === null ? [] : ['bulk'],
          enabled: true,
        },
      ]),
    ),
  }
}

const PLANS: [string, number, number | null][] = [
  ['ultra', 2, null],
  ['max', 1, 1],
  ['max', 1, 1],
  ['max', 1, 1],
  ['ultra', 2, null],
  ['max', 1, 1],
  ['max', 1, 1],
  ['ultra', 2, null],
]
/** Reset offsets (h after Monday 00:00 UTC): the first three are this machine's (Tue 16:00, Wed 06:00, Sat 18:00). */
const OFFSETS = [40, 54, 138, 96, 12, 117, 75, 160]

/** A pool of `n` (1..8) accounts of mixed plans with staggered resets: one Ultra, then Max and Ultra in a fixed pattern. */
export function mixedPool(n: number): SimAccount[] {
  if (!Number.isInteger(n) || n < 1 || n > PLANS.length) throw new Error(`a pool has 1 to ${PLANS.length} accounts`)
  return PLANS.slice(0, n).map(([plan, weeklyUnits, sessionUnits], i) => ({
    id: `${plan === 'ultra' ? 'u' : 'm'}${i + 1}`,
    plan,
    weeklyUnits,
    sessionUnits,
    resetOffsetH: requiredAt(OFFSETS, i),
  }))
}

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32

const stepsOf = (hours: number) => Math.max(1, Math.round((hours * HOUR_MS) / STEP_MS))

/** Mean steps a session runs, over the model's length distribution. */
function meanSteps(m: LoadModel): number {
  if (fixedSessions(m)) return stepsOf(requiredAt(m.session_hours, 0)[1])
  const n = 1000
  let s = 0
  for (let i = 0; i < n; i++) s += stepsOf(sessionHoursAt(m, (i + 0.5) / n))
  return s / n
}

/** The mix as lane weights. */
export const mixOf = (m: LoadModel): Record<string, number> =>
  Object.fromEntries(Object.entries(m.mix).map(([c, w]) => [LANE_OF_CLASS[c as LaneClass], w]))

export function simulate(sc: Scenario): SimResult {
  const rng = lcg(sc.seed ?? 7)
  const weeks = sc.weeks ?? 3
  const m = sc.model
  const reg = sc.reg ?? poolRegistry(sc.accts)
  const policy = sc.policy ?? (reg.policy as PolicyName | undefined) ?? DEFAULT_POLICY
  if (!POLICY_NAMES.includes(policy)) throw new Error(`unknown policy '${policy}'`)
  const mix = Object.entries(sc.mix ?? mixOf(m)).filter(([, w]) => w > 0)
  const mixTotal = mix.reduce((s, [, w]) => s + w, 0)
  // the policy reads the demand it is simulated under, as a live measurement of the recent demand would
  const load: LoadModel = {
    ...m,
    demand: sc.demand,
    mix: { ...m.mix, interactive: (mix.find(([l]) => l === 'interactive')?.[1] ?? 0) / mixTotal },
  }
  const perStep = (m.units_per_session_hour * STEP_MS) / HOUR_MS
  const totalUnits = sc.accts.reduce((s, a) => s + a.weeklyUnits, 0)
  // spawns per step at curve 1, so the mean demand equals sc.demand × the pool's weekly quota
  const spawnRate = (sc.demand * totalUnits) / (WEEK_MS / STEP_MS) / (perStep * meanSteps(m))
  const ratio = (a: SimAccount) => (sessionRatio(m, a.plan) ?? 1 / 8) * (a.sessionUnits ?? 1)
  const t0 = sc.t0 ?? SIM_T0
  const st = Object.fromEntries(
    sc.accts.map((a) => {
      let wReset = SIM_T0 + a.resetOffsetH * HOUR_MS
      while (wReset <= t0) wReset += WEEK_MS
      return [a.id, { w: sc.start?.[a.id] ?? 0, s: 0, sEnd: 0, wReset }]
    }),
  )
  const byId = new Map(sc.accts.map((a) => [a.id, a]))
  const firstFull: Record<string, number | null> = Object.fromEntries(sc.accts.map((a) => [a.id, null]))
  const atReset: Record<string, number[]> = Object.fromEntries(sc.accts.map((a) => [a.id, []]))
  const picks: Record<string, number> = {}
  let sessions: { account: string; left: number; lane: string }[] = []
  let acc = 0
  let demanded = 0
  let unmet = 0
  let moved = 0
  let spawned = 0
  const cacheAt = (now: number): Cache => {
    const samples: Record<string, Sample> = {}
    for (const a of sc.accts) {
      const x = required(st, a.id)
      const open = a.sessionUnits !== null && x.sEnd > now
      samples[a.id] = {
        s: a.sessionUnits === null ? null : open ? Math.round(x.s) : 0,
        w: Math.floor(x.w),
        s_reset: a.sessionUnits === null ? null : Math.round((open ? x.sEnd : now + 5 * HOUR_MS) / 1000),
        w_reset: Math.round(x.wReset / 1000),
        s_ts: now - 60_000,
        w_ts: now - 60_000,
        src: 'sim',
      }
    }
    return { ...emptyCache(), samples }
  }
  const walled = (id: string, now: number) => {
    const a = byId.get(id)!
    const x = required(st, id)
    return x.w >= 100 || (a.sessionUnits !== null && x.sEnd > now && x.s >= 100)
  }
  const choose = (lane: string, now: number): string | null => {
    const cache = cacheAt(now)
    if (sc.choose) return sc.choose({ lane, now, cache, walled: (id) => walled(id, now) })
    const p = pickWith(policy, { reg, cache, lane, nowMs: now, rng, load })
    if (p.picked === SPILL || walled(p.picked, now)) return null
    return p.picked
  }
  const fixed = fixedSessions(m)
  for (let now = t0; now < t0 + weeks * WEEK_MS; now += STEP_MS) {
    for (const a of sc.accts) {
      const x = required(st, a.id)
      if (now >= x.wReset) {
        if (sc.start || now - t0 >= WEEK_MS) required(atReset, a.id).push(Math.round(x.w))
        x.w = 0
        x.wReset += WEEK_MS
      }
      if (a.sessionUnits !== null && x.sEnd <= now) x.s = 0
      if (x.w >= 98 && firstFull[a.id] === null) firstFull[a.id] = Math.round((now - t0) / HOUR_MS)
    }
    acc += spawnRate * curveAt(m, now)
    while (acc >= 1) {
      acc -= 1
      let r = rng() * mixTotal
      const lane = mix.find(([, w]) => (r -= w) < 0)?.[0] ?? requiredAt(mix, 0)[0]
      const steps = stepsOf(fixed ? requiredAt(m.session_hours, 0)[1] : sessionHoursAt(m, rng()))
      sessions.push({ account: '', left: steps, lane })
      spawned++
    }
    for (const se of sessions) {
      demanded += perStep
      if (!se.account || walled(se.account, now)) {
        if (se.account) moved++
        const id = choose(se.lane, now)
        if (!id) {
          unmet += perStep
          se.left--
          continue
        }
        se.account = id
        picks[id] = (picks[id] ?? 0) + 1
      }
      const a = byId.get(se.account)!
      const x = required(st, a.id)
      x.w += (100 * perStep) / a.weeklyUnits
      if (a.sessionUnits !== null) {
        if (x.sEnd <= now) {
          x.sEnd = now + 5 * HOUR_MS
          x.s = 0
        }
        x.s += (100 * perStep) / ratio(a)
      }
      se.left--
    }
    sessions = sessions.filter((se) => se.left > 0)
  }
  let usedUnits = 0
  let quotaUnits = 0
  for (const a of sc.accts)
    for (const w of required(atReset, a.id)) {
      usedUnits += (Math.min(100, w) / 100) * a.weeklyUnits
      quotaUnits += a.weeklyUnits
    }
  return {
    atReset,
    used: quotaUnits ? usedUnits / quotaUnits : 0,
    blocked: demanded ? unmet / demanded : 0,
    moved,
    picks,
    sessions: spawned,
    firstFull,
  }
}

// ── compare ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const COMPARE_DEMANDS = [0.85, 0.9, 1.0, 1.1, 1.2]
export const COMPARE_POOLS = [1, 2, 3, 5, 8]
/** Seeds per cell: enough that a seed's luck (which account a burst lands on) stays under the noise bar of `verdicts`. */
export const COMPARE_SEEDS = [7, 11, 13, 17, 19, 23, 29, 31, 37, 41]

export interface Cell {
  policy: PolicyName
  demand: number
  accounts: number
  /** means over the seeds */
  used: number
  blocked: number
  /** summed over the seeds */
  moved: number
  /** used per seed, in COMPARE_SEEDS order: the paired difference against the default policy */
  usedBySeed: number[]
}

export interface Verdict {
  policy: PolicyName
  /** mean capacity-weighted quota used at reset over the grid, and v1.9's */
  used: number
  baselineUsed: number
  /** mean paired difference (same pool, demand and seed) and its standard error */
  usedGain: number
  usedGainSe: number
  moved: number
  baselineMoved: number
  /** cells at demand 1.0 or below where it blocks more work than v1.9 (a pool too small for the demand curve blocks under every policy) */
  blockedWorse: { demand: number; accounts: number; blocked: number; baseline: number }[]
  /** more used beyond the noise (gain > 2 standard errors), no more moved sessions, no work blocked that v1.9 does not block at demand 1.0 or below */
  beats: boolean
  why: string
}

export interface Comparison {
  weeks: number
  seeds: number[]
  cells: Cell[]
  verdicts: Verdict[]
}

/** Every policy over the demand range and the pool sizes, each cell the mean of COMPARE_SEEDS runs. */
export function compare(o: {
  model: LoadModel
  weeks?: number
  demands?: number[]
  pools?: number[]
  seeds?: number[]
  policies?: PolicyName[]
}): Comparison {
  const weeks = o.weeks ?? 3
  const seeds = o.seeds ?? COMPARE_SEEDS
  const policies = o.policies ?? POLICY_NAMES
  const cells: Cell[] = []
  for (const policy of policies)
    for (const accounts of o.pools ?? COMPARE_POOLS)
      for (const demand of o.demands ?? COMPARE_DEMANDS) {
        const runs = seeds.map((seed) =>
          simulate({ accts: mixedPool(accounts), demand, model: o.model, policy, seed, weeks }),
        )
        const mean = (f: (r: SimResult) => number) => runs.reduce((s, r) => s + f(r), 0) / runs.length
        cells.push({
          policy,
          demand,
          accounts,
          used: mean((r) => r.used),
          blocked: mean((r) => r.blocked),
          moved: runs.reduce((s, r) => s + r.moved, 0),
          usedBySeed: runs.map((r) => r.used),
        })
      }
  return { weeks, seeds, cells, verdicts: verdicts(cells) }
}

/** Blocked shares closer than this are equal (one session-step of a three-week run). */
const BLOCKED_EPS = 1e-4

/** Each candidate against the default policy, by the acceptance rule of packages/accounts/docs/accounts.md §The policy lab. */
export function verdicts(cells: Cell[]): Verdict[] {
  const of = (p: PolicyName) => cells.filter((c) => c.policy === p)
  const used = (cs: Cell[]) => cs.reduce((s, c) => s + c.used, 0) / Math.max(1, cs.length)
  const moved = (cs: Cell[]) => cs.reduce((s, c) => s + c.moved, 0)
  const base = of(DEFAULT_POLICY)
  const baseOf = (c: Cell) => base.find((b) => b.demand === c.demand && b.accounts === c.accounts)
  return [...new Set(cells.map((c) => c.policy))]
    .filter((p) => p !== DEFAULT_POLICY)
    .map((policy) => {
      const cs = of(policy).filter((c) => baseOf(c))
      const diffs = cs.flatMap((c) => c.usedBySeed.map((u, i) => u - requiredAt(baseOf(c)!.usedBySeed, i)))
      const gain = diffs.reduce((s, d) => s + d, 0) / Math.max(1, diffs.length)
      const se =
        diffs.length > 1
          ? Math.sqrt(diffs.reduce((s, d) => s + (d - gain) ** 2, 0) / (diffs.length - 1) / diffs.length)
          : Number.POSITIVE_INFINITY
      const blockedWorse = cs
        .filter((c) => c.demand <= 1 && c.blocked > baseOf(c)!.blocked + BLOCKED_EPS)
        .map((c) => ({ demand: c.demand, accounts: c.accounts, blocked: c.blocked, baseline: baseOf(c)!.blocked }))
      const v = {
        policy,
        used: used(cs),
        baselineUsed: used(base),
        usedGain: gain,
        usedGainSe: se,
        moved: moved(cs),
        baselineMoved: moved(base),
        blockedWorse,
      }
      const fails = [
        ...(gain > 2 * se ? [] : ['no more quota used at reset beyond the noise']),
        ...(v.moved <= v.baselineMoved ? [] : ['more moved sessions']),
        ...(blockedWorse.length ? ['more work blocked at demand 1.0 or below'] : []),
      ]
      return { ...v, beats: !fails.length, why: fails.length ? fails.join(', ') : 'wins on every count' }
    })
}
