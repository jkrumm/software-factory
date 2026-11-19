import { describe, expect, test } from 'bun:test'
import { type Cache, type Registry, type Sample, SPILL, emptyCache, pick } from '../src/index.ts'

// A three-week simulation of the picker against the shape of the real load: sticky sessions (a session stays on the
// account it was picked for), a day/night demand curve, three lanes, staggered weekly resets and Max 5h windows.
// It judges the rule by its outcome: the weekly % each account reaches at its reset (unused = lost) and the work that
// found no account (blocked). Units: one "Max-week" is the weekly quota of a Max account (Ultra has 2).

const STEP_MS = 15 * 60_000
const HOUR = 3600_000
const WEEK = 7 * 24 * HOUR
const T0 = Date.UTC(2026, 10, 2, 0, 0) // a Monday
/** A Max 5h window holds this share of its weekly quota. */
const SESSION_SHARE = 1 / 8
/** Max-weeks one session burns per step. */
const RATE = 0.002
const SESSION_STEPS = 8

interface Acct {
  id: string
  weeklyUnits: number
  sessionUnits: number | null
  resetOffsetH: number
}
interface Scenario {
  name: string
  demand: number
  mix: Record<string, number>
  reg: Registry
  accts: Acct[]
  seed?: number
  weeks?: number
  policy?: 'picker' | 'factory'
  start?: Record<string, number>
  t0?: number
}

const ACCTS: Acct[] = [
  { id: 'iu', weeklyUnits: 2, sessionUnits: null, resetOffsetH: 24 + 16 }, // Tue 16:00
  { id: 'me', weeklyUnits: 1, sessionUnits: 1, resetOffsetH: 48 + 6 }, // Wed 06:00
  { id: 'me2', weeklyUnits: 1, sessionUnits: 1, resetOffsetH: 5 * 24 + 18 }, // Sat 18:00
]
export const REG: Registry = {
  accounts: {
    iu: { dir: null, plan: 'ultra', homeLanes: ['interactive', 'headless'], enabled: true },
    me: { dir: '/x/.claude-me', plan: 'max', homeLanes: ['bulk'], enabled: true },
    me2: { dir: '/x/.claude-me2', plan: 'max', homeLanes: ['bulk'], enabled: true },
  },
}

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
const dayCurve = (ms: number) => {
  const h = new Date(ms).getUTCHours()
  return h >= 8 && h < 23 ? 1.4 : 0.35
}

export interface SimResult {
  /** weekly % at each reset after the first week, per account */
  atReset: Record<string, number[]>
  /** share of demanded work that found no account */
  blocked: number
  /** sessions that hit a wall mid-run and had to move */
  moved: number
  picks: Record<string, number>
  /** hours from the start until each account first reached 98 % */
  firstFull: Record<string, number | null>
}

export function simulate(sc: Scenario): SimResult {
  const rng = lcg(sc.seed ?? 7)
  const weeks = sc.weeks ?? 3
  const totalUnits = sc.accts.reduce((s, a) => s + a.weeklyUnits, 0)
  // spawns per step so the average demand equals sc.demand × the pool's weekly quota
  const meanCurve = (15 * 1.4 + 9 * 0.35) / 24
  const spawnRate = (sc.demand * totalUnits) / (WEEK / STEP_MS) / (RATE * SESSION_STEPS) / meanCurve
  const t0 = sc.t0 ?? T0
  const st = Object.fromEntries(
    sc.accts.map((a) => {
      let wReset = T0 + a.resetOffsetH * HOUR
      while (wReset <= t0) wReset += WEEK
      return [a.id, { w: sc.start?.[a.id] ?? 0, s: 0, sEnd: 0, wReset }]
    }),
  )
  const firstFull: Record<string, number | null> = Object.fromEntries(sc.accts.map((a) => [a.id, null]))
  const atReset: Record<string, number[]> = Object.fromEntries(sc.accts.map((a) => [a.id, []]))
  const picks: Record<string, number> = {}
  let sessions: { account: string; left: number; lane: string }[] = []
  let acc = 0,
    demanded = 0,
    unmet = 0,
    moved = 0
  const lanes = Object.entries(sc.mix)
  const cacheAt = (now: number): Cache => {
    const samples: Record<string, Sample> = {}
    for (const a of sc.accts) {
      const x = st[a.id]
      const open = a.sessionUnits !== null && x.sEnd > now
      samples[a.id] = {
        s: a.sessionUnits === null ? null : open ? Math.round(x.s) : 0,
        w: Math.floor(x.w),
        s_reset: a.sessionUnits === null ? null : Math.round((open ? x.sEnd : now + 5 * HOUR) / 1000),
        w_reset: Math.round(x.wReset / 1000),
        s_ts: now - 60_000,
        w_ts: now - 60_000,
        src: 'sim',
      }
    }
    return { ...emptyCache(), samples }
  }
  const walled = (id: string, now: number) => {
    const a = sc.accts.find((x) => x.id === id)!,
      x = st[id]
    return x.w >= 100 || (a.sessionUnits !== null && x.sEnd > now && x.s >= 100)
  }
  const choose = (lane: string, now: number): string | null => {
    if (sc.policy === 'factory' && lane !== 'interactive') {
      // software-factory pickAccount: the most room in the tightest window (5h or weekly), no reset timing
      const c = cacheAt(now)
      const room = (id: string) =>
        Math.min(100 - (c.samples[id].w ?? 0), c.samples[id].s === null ? 100 : 100 - (c.samples[id].s ?? 0))
      const best = sc.accts
        .map((a) => a.id)
        .filter((id) => !walled(id, now))
        .sort((a, b) => room(b) - room(a))[0]
      return best ?? null
    }
    const p = pick(sc.reg, cacheAt(now), lane, now, rng)
    if (p.picked === SPILL || walled(p.picked, now)) return null
    return p.picked
  }
  for (let now = t0; now < t0 + weeks * WEEK; now += STEP_MS) {
    for (const a of sc.accts) {
      const x = st[a.id]
      if (now >= x.wReset) {
        if (sc.start || now - t0 >= WEEK) atReset[a.id].push(Math.round(x.w))
        x.w = 0
        x.wReset += WEEK
      }
      if (a.sessionUnits !== null && x.sEnd <= now) x.s = 0
      if (x.w >= 98 && firstFull[a.id] === null) firstFull[a.id] = Math.round((now - t0) / HOUR)
    }
    acc += spawnRate * dayCurve(now)
    while (acc >= 1) {
      acc -= 1
      let r = rng() * lanes.reduce((s, [, w]) => s + w, 0)
      const lane = lanes.find(([, w]) => (r -= w) < 0)?.[0] ?? lanes[0][0]
      sessions.push({ account: '', left: SESSION_STEPS, lane })
    }
    for (const se of sessions) {
      demanded += RATE
      if (!se.account || walled(se.account, now)) {
        if (se.account) moved++
        const id = choose(se.lane, now)
        if (!id) {
          unmet += RATE
          se.left--
          continue
        }
        se.account = id
        picks[id] = (picks[id] ?? 0) + 1
      }
      const a = sc.accts.find((x) => x.id === se.account)!,
        x = st[a.id]
      x.w += (100 * RATE) / a.weeklyUnits
      if (a.sessionUnits !== null) {
        if (x.sEnd <= now) {
          x.sEnd = now + 5 * HOUR
          x.s = 0
        }
        x.s += (100 * RATE) / (a.sessionUnits * SESSION_SHARE)
      }
      se.left--
    }
    sessions = sessions.filter((se) => se.left > 0)
  }
  return { atReset, blocked: demanded ? unmet / demanded : 0, moved, picks, firstFull }
}

const MIX = { interactive: 0.25, lead: 0.55, bulk: 0.2 }
const full = (r: SimResult) =>
  Object.values(r.atReset)
    .flat()
    .filter((w) => w >= 98).length
const all = (r: SimResult) => Object.values(r.atReset).flat().length
const report = (name: string, r: SimResult) =>
  console.log(
    `SIM ${name}: at reset ${Object.entries(r.atReset)
      .map(([id, ws]) => `${id} [${ws.join(',')}]`)
      .join(
        '  ',
      )} | full@h ${JSON.stringify(r.firstFull)} | blocked ${(100 * r.blocked).toFixed(1)}% | moved ${r.moved}`,
  )
const run = (name: string, sc: Omit<Scenario, 'name'>) => {
  const r = simulate({ name, ...sc })
  report(name, r)
  return r
}

// this week (2026-11-19, Thu 08:00): iu 12 %, me 0 % (just reset), me2 91 %; Fable on iu, drain me2
const THU = Date.UTC(2026, 10, 5, 8, 0)
const base = { mix: MIX, reg: REG, accts: ACCTS }

describe('picker simulation: three weeks of sticky sessions against staggered resets', () => {
  test('demand above the pool: every window ends at the wall', () => {
    const r = run('saturated 1.2x', { ...base, demand: 1.2 })
    for (const ws of Object.values(r.atReset)) for (const w of ws) expect(w).toBeGreaterThanOrEqual(98)
  })
  test('demand equal to the pool: nothing blocked, iu and me2 at the wall, me within 10 points', () => {
    const r = run('full 1.0x', { ...base, demand: 1.0 })
    expect(r.blocked).toBe(0)
    for (const w of [...r.atReset.iu, ...r.atReset.me2]) expect(w).toBeGreaterThanOrEqual(98)
    for (const w of r.atReset.me) expect(w).toBeGreaterThanOrEqual(90)
  })
  test('lead-heavy demand behaves like the mixed one', () => {
    const r = run('lead-heavy 1.0x', { ...base, demand: 1.0, mix: { interactive: 0.1, lead: 0.9 } })
    expect(r.blocked).toBe(0)
    for (const w of [...r.atReset.iu, ...r.atReset.me2]) expect(w).toBeGreaterThanOrEqual(98)
  })
  test('demand below the pool: the slack lands on one account, the others reach the wall (earliest reset first)', () => {
    const r = run('busy 0.85x', { ...base, demand: 0.85 })
    expect(r.blocked).toBe(0)
    expect(full(r)).toBeGreaterThanOrEqual(all(r) - 2)
    for (const w of r.atReset.iu) expect(w).toBeGreaterThanOrEqual(98)
  })
  test('half demand: nothing blocked, no session moved', () => {
    const r = run('half 0.5x', { ...base, demand: 0.5 })
    expect(r.blocked).toBe(0)
    expect(r.moved).toBe(0)
  })
  test("the factory's roomLeft policy (most room in the tightest window) fills fewer windows than the picker", () => {
    for (const d of [1.0, 0.85]) {
      const picker = simulate({ name: '', ...base, demand: d })
      const factory = run(`factory roomLeft ${d}x`, { ...base, demand: d, policy: 'factory' })
      expect(full(picker)).toBeGreaterThan(full(factory))
    }
  })
  test('week of 11-19: drain me2 fills it within hours, Fable keeps iu mostly free', () => {
    for (const d of [1.0, 0.7]) {
      const r = run(`week of 11-19 fable iu + drain me2 ${d}x`, {
        ...base,
        demand: d,
        reg: { ...REG, fable: 'iu', drain: ['me2'] },
        start: { iu: 12, me: 0, me2: 91 },
        t0: THU,
        weeks: 1,
      })
      expect(r.firstFull.me2).toBeLessThanOrEqual(6)
      expect(r.blocked).toBe(0)
      expect(r.atReset.iu[0]).toBeLessThanOrEqual(70)
    }
  })
})
