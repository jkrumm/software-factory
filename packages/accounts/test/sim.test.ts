import { describe, expect, test } from 'bun:test'
import {
  type ChooseCtx,
  type LoadModel,
  type Registry,
  type Scenario,
  type SimAccount,
  type SimResult,
  simulate,
} from '../src/index.ts'

// The three-week simulation (src/sim.ts) on the load model guessed before it was measured: sticky 2 h sessions, a
// day/night curve, three lanes, staggered weekly resets and Max 5h windows. These assertions are v1.9's findings on that
// model (packages/accounts/docs/accounts.md §Why v1.9); the measured model and the candidates are test/lab.test.ts.

/** The guessed model: a Max 5h window holds 1/8 of its week, a session burns 0.002 Max-weeks per 15 min for 2 h, day 08-23 UTC at 1.4, night at 0.35. */
export const GUESSED: LoadModel = {
  v: 1,
  measured_at: '2026-11-19T00:00:00.000Z',
  range: { from: '2026-11-19T00:00:00.000Z', to: '2026-11-19T00:00:00.000Z' },
  sources: { counts: 'guessed, not measured' },
  session_hours: [
    [0, 2],
    [1, 2],
  ],
  units_per_session_hour: 0.008,
  weekly_per_session_point: { max: 1 / 8, ultra: null },
  demand: 1,
  curve: {
    hour_of_day_utc: Array.from({ length: 24 }, (_, h) => (h >= 8 && h < 23 ? 1.4 : 0.35)),
    day_of_week: [1, 1, 1, 1, 1, 1, 1],
  },
  mix: { interactive: 0.25, headless: 0, bulk: 0.2, homeless: 0.55 },
}

const ACCTS: SimAccount[] = [
  { id: 'iu', plan: 'ultra', weeklyUnits: 2, sessionUnits: null, resetOffsetH: 24 + 16 }, // Tue 16:00
  { id: 'me', plan: 'max', weeklyUnits: 1, sessionUnits: 1, resetOffsetH: 48 + 6 }, // Wed 06:00
  { id: 'me2', plan: 'max', weeklyUnits: 1, sessionUnits: 1, resetOffsetH: 5 * 24 + 18 }, // Sat 18:00
]
export const REG: Registry = {
  accounts: {
    iu: { dir: null, plan: 'ultra', homeLanes: ['interactive', 'headless'], enabled: true },
    me: { dir: '/x/.claude-me', plan: 'max', homeLanes: ['bulk'], enabled: true },
    me2: { dir: '/x/.claude-me2', plan: 'max', homeLanes: ['bulk'], enabled: true },
  },
}

/** The software-factory's former pickAccount: the most room in the tightest window (5h or weekly), no reset timing. */
const roomLeft = (c: ChooseCtx): string | null => {
  if (c.lane === 'interactive') return c.walled('iu') ? null : 'iu'
  const room = (id: string) =>
    Math.min(
      100 - (c.cache.samples[id].w ?? 0),
      c.cache.samples[id].s === null ? 100 : 100 - (c.cache.samples[id].s ?? 0),
    )
  return (
    Object.keys(c.cache.samples)
      .filter((id) => !c.walled(id))
      .sort((a, b) => room(b) - room(a))[0] ?? null
  )
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
const base = { mix: MIX, reg: REG, accts: ACCTS, model: GUESSED }
const run = (name: string, sc: Omit<Scenario, 'accts' | 'model'> & Partial<Scenario>) => {
  const r = simulate({ ...base, ...sc })
  report(name, r)
  return r
}

// this week (2026-11-19, Thu 08:00): iu 12 %, me 0 % (just reset), me2 91 %; Fable on iu, drain me2
const THU = Date.UTC(2026, 10, 5, 8, 0)

describe('picker simulation: three weeks of sticky sessions against staggered resets (guessed load)', () => {
  test('demand above the pool: every window ends at the wall', () => {
    const r = run('saturated 1.2x', { demand: 1.2 })
    for (const ws of Object.values(r.atReset)) for (const w of ws) expect(w).toBeGreaterThanOrEqual(98)
  })
  test('demand equal to the pool: nothing blocked, iu and me2 at the wall, me within 10 points', () => {
    const r = run('full 1.0x', { demand: 1.0 })
    expect(r.blocked).toBe(0)
    for (const w of [...r.atReset.iu, ...r.atReset.me2]) expect(w).toBeGreaterThanOrEqual(98)
    for (const w of r.atReset.me) expect(w).toBeGreaterThanOrEqual(90)
  })
  test('lead-heavy demand behaves like the mixed one', () => {
    const r = run('lead-heavy 1.0x', { demand: 1.0, mix: { interactive: 0.1, lead: 0.9 } })
    expect(r.blocked).toBe(0)
    for (const w of [...r.atReset.iu, ...r.atReset.me2]) expect(w).toBeGreaterThanOrEqual(98)
  })
  test('demand below the pool: the slack lands on one account, the others reach the wall (earliest reset first)', () => {
    const r = run('busy 0.85x', { demand: 0.85 })
    expect(r.blocked).toBe(0)
    expect(full(r)).toBeGreaterThanOrEqual(all(r) - 2)
    for (const w of r.atReset.iu) expect(w).toBeGreaterThanOrEqual(98)
  })
  test('half demand: nothing blocked, no session moved', () => {
    const r = run('half 0.5x', { demand: 0.5 })
    expect(r.blocked).toBe(0)
    expect(r.moved).toBe(0)
  })
  test("the factory's roomLeft policy (most room in the tightest window) fills fewer windows than the picker", () => {
    for (const d of [1.0, 0.85]) {
      const picker = simulate({ ...base, demand: d })
      const factory = run(`factory roomLeft ${d}x`, { demand: d, choose: roomLeft })
      expect(full(picker)).toBeGreaterThan(full(factory))
    }
  })
  test('week of 11-19: drain me2 fills it within hours, Fable keeps iu mostly free', () => {
    for (const d of [1.0, 0.7]) {
      const r = run(`week of 11-19 fable iu + drain me2 ${d}x`, {
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
