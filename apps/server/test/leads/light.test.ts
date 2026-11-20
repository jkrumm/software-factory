import { describe, expect, test } from 'bun:test'
import {
  judgeLightGate,
  moveUpBound,
  moveUpTimeBound,
  regressionGap,
  type SeatFigures,
  TRIPWIRE_CONFIDENCE,
  TRIPWIRE_Z,
  tripwireFrom,
} from '@software-factory/contract'
import {
  hygieneClass,
  type LightFacts,
  lightRule,
  moveUpWhy,
  outOfScope,
  type StruggleFacts,
} from '../../src/domains/leads/light.ts'

const facts = (over: Partial<LightFacts> = {}): LightFacts => ({
  kind: 'feature',
  size: null,
  spec: false,
  hygieneKey: null,
  unroutedMonitor: false,
  movedUp: 0,
  text: 'tidy a log line',
  triageSmall: false,
  ...over,
})

describe('lightRule', () => {
  test('every hygiene finding starts light, by probe, judgment kind or declared probe name, whatever its size', () => {
    expect(lightRule(facts({ hygieneKey: 'links:docs/guide.md' }))).toBe('hygiene:links')
    expect(lightRule(facts({ hygieneKey: 'judgment:stale:docs/x.md' }))).toBe('hygiene:stale')
    expect(lightRule(facts({ hygieneKey: 'probe:readme' }))).toBe('hygiene:readme')
    expect(lightRule(facts({ hygieneKey: 'deps' }))).toBe('hygiene:deps')
    // what the catalogue once kept on the lead row, and a size triage called medium or left empty
    expect(lightRule(facts({ hygieneKey: 'check' }))).toBe('hygiene:check')
    expect(lightRule(facts({ hygieneKey: 'advisories', size: 'medium' }))).toBe('hygiene:advisories')
    expect(lightRule(facts({ hygieneKey: 'unused:exports', size: null }))).toBe('hygiene:unused')
    expect(lightRule(facts({ hygieneKey: 'judgment:slop:docs/x.md', size: 'large' }))).toBe('hygiene:slop')
  })

  test('kind docs and a monitor with no route start light', () => {
    expect(lightRule(facts({ kind: 'docs' }))).toBe('kind:docs')
    expect(lightRule(facts({ unroutedMonitor: true }))).toBe('alert:route')
  })

  test("triage's small starts light only while the tripwire is met, and never with a design choice", () => {
    expect(lightRule(facts({ size: 'small' }))).toBeNull()
    expect(lightRule(facts({ size: 'small', triageSmall: true }))).toBe('triage:small')
    expect(lightRule(facts({ size: 'small', spec: true, triageSmall: true }))).toBeNull()
    expect(lightRule(facts({ size: 'medium', triageSmall: true }))).toBeNull()
    expect(lightRule(facts({ size: null, triageSmall: true }))).toBeNull()
  })

  test('a small whose words name a migration, security or a public surface stays on the lead row', () => {
    const small = (text: string) => lightRule(facts({ size: 'small', triageSmall: true, text }))
    expect(small('rename a log field in the digest')).toBe('triage:small')
    expect(small('add migration 1100 for the seat column')).toBeNull()
    expect(small('rotate the bearer token: security policy')).toBeNull()
    expect(small('check the authorization of GET /v1/kpis')).toBeNull()
    expect(small('new route /v1/light for the gate')).toBeNull()
    expect(small('edit apps/server/migrations/1100_x.sql')).toBeNull()
    expect(small('the author of the doc')).toBe('triage:small')
    expect(outOfScope('a secret in the log')).toBe(true)
    expect(outOfScope('cost tokens per Issue')).toBe(false)
  })

  test('an Issue moved up once never starts light again', () => {
    expect(lightRule(facts({ kind: 'docs', movedUp: 1 }))).toBeNull()
  })

  test('hygieneClass reads the class a key names', () => {
    expect(hygieneClass('retired:docs/a.md')).toBe('retired')
    expect(hygieneClass('probe:agentsmd')).toBe('agentsmd')
  })
})

describe('moveUpWhy', () => {
  const struggle = (over: Partial<StruggleFacts> = {}): StruggleFacts => ({
    light: true,
    stalls: 0,
    outOfDepth: false,
    shipRefusals: 0,
    regressedWatch: null,
    ...over,
  })

  test('a light lead moves up on its second stall, its second refused ship, depth or a first-watch regression', () => {
    expect(moveUpWhy(struggle({ stalls: 1 }))).toBeNull()
    expect(moveUpWhy(struggle({ stalls: 2 }))).toBe('the light lead stalled 2 times')
    expect(moveUpWhy(struggle({ shipRefusals: 1 }))).toBeNull()
    expect(moveUpWhy(struggle({ shipRefusals: 2 }))).toContain('refused 2 times')
    expect(moveUpWhy(struggle({ stalls: 1, outOfDepth: true }))).toContain('beyond its seat')
    expect(moveUpWhy(struggle({ regressedWatch: 1 }))).toContain('first watch')
    expect(moveUpWhy(struggle({ regressedWatch: 2 }))).toBeNull()
  })

  test('a lead on any other seat is never moved', () => {
    expect(moveUpWhy(struggle({ light: false, stalls: 5, outOfDepth: true, regressedWatch: 1 }))).toBeNull()
  })
})

describe('the light gate', () => {
  const figures = (over: Partial<SeatFigures> = {}): SeatFigures => ({
    finishedWatches: 40,
    finishedPassRate: 0.95,
    movedUpShare: null,
    ...over,
  })
  // a seat from its counts: passes of watches
  const seat = (passed: number, watches: number, over: Partial<SeatFigures> = {}) =>
    figures({ finishedWatches: watches, finishedPassRate: passed / watches, ...over })
  // today's 3-day reading of 2026-11-18: light 71 of 75, lead 515 of 527
  const lead = seat(515, 527)
  const light = (passed: number, watches: number) => seat(passed, watches, { movedUpShare: 0.17 })

  test('the move-up bound is the share at which light plus a follow-up costs what the lead row costs', () => {
    // 0.15 + share * 2.70 = 2.70 at share 0.944
    expect(moveUpBound({ lightAttempt: 0.15, leadAttempt: 2.7, followUpAttempt: 2.7 })).toBeCloseTo(0.9444, 3)
    // a dearer follow-up (a hard Issue) lowers it: 0.15 + share * 5.40 = 2.70 at share 0.472
    expect(moveUpBound({ lightAttempt: 0.15, leadAttempt: 2.7, followUpAttempt: 5.4 })).toBeCloseTo(0.4722, 3)
    // light dearer than lead: no share is cheaper
    expect(moveUpBound({ lightAttempt: 3, leadAttempt: 2.7, followUpAttempt: 2.7 })).toBe(0)
    expect(moveUpBound({ lightAttempt: null, leadAttempt: 2.7, followUpAttempt: 2.7 })).toBeNull()
    expect(moveUpBound({ lightAttempt: 0.15, leadAttempt: 2.7, followUpAttempt: 0 })).toBeNull()
  })

  test('the time bound is the same break-even in minutes', () => {
    const MIN = 60_000
    // a light attempt that finishes takes 9 min against the lead row's 35, one that moves up spent 19 before the lead took
    // over: 26 min saved against 19 wasted, even at share 26 / 45
    const time = moveUpTimeBound({ lightFinishMs: 9 * MIN, movedMs: 19 * MIN, leadMs: 35 * MIN })
    expect(time).toBeCloseTo(0.5778, 3)
    expect(moveUpTimeBound({ lightFinishMs: null, movedMs: 19 * MIN, leadMs: 35 * MIN })).toBeNull()
    // light no faster than the lead row: no share saves; a move-up that wastes nothing: any share does
    expect(moveUpTimeBound({ lightFinishMs: 40 * MIN, movedMs: 19 * MIN, leadMs: 35 * MIN })).toBe(0)
    expect(moveUpTimeBound({ lightFinishMs: 9 * MIN, movedMs: 0, leadMs: 35 * MIN })).toBe(1)
  })

  test("opens on today's figures: a 3.06 point gap on 75 watches is not shown", () => {
    const verdict = judgeLightGate({ light: light(71, 75), lead, bound: 0.94 })
    expect(verdict.met).toBe(true)
    expect(verdict.failing).toEqual([])
    // the point gap is over the 3 points; its lower bound at 95 % is under zero
    expect(verdict.passGap?.points).toBeCloseTo(3.06, 1)
    expect(verdict.passGap?.lower).toBeCloseTo(-0.15, 1)
  })

  test('stays closed where light is clearly worse: 80 of 100 against lead 515 of 527', () => {
    const verdict = judgeLightGate({ light: light(80, 100), lead, bound: 0.94 })
    expect(verdict.met).toBe(false)
    expect(verdict.passGap?.lower).toBeCloseTo(11.8, 0)
    expect(verdict.failing).toHaveLength(1)
    expect(verdict.failing[0]).toContain('shown more than 3 points under')
  })

  test('the line sits between 90 and 92 of 100, and 8 of 10 is shown worse already', () => {
    expect(judgeLightGate({ light: light(90, 100), lead, bound: 0.94 }).met).toBe(false)
    expect(judgeLightGate({ light: light(92, 100), lead, bound: 0.94 }).met).toBe(true)
    expect(judgeLightGate({ light: light(8, 10), lead, bound: 0.94 }).met).toBe(false)
    // few watches that all passed show nothing
    expect(judgeLightGate({ light: light(10, 10), lead, bound: 0.94 }).met).toBe(true)
  })

  test('a gap is read in the other direction too: light ahead of lead is never shown worse', () => {
    expect(judgeLightGate({ light: light(75, 75), lead: seat(450, 527), bound: 0.94 }).met).toBe(true)
  })

  test('regressions are shown, never a condition', () => {
    // light regressed 4 in 117 Issues, lead 12 in 619: not shown higher, and not read by the gate
    const gap = regressionGap({ light: { regressions: 4, issues: 117 }, lead: { regressions: 12, issues: 619 } })
    expect(gap?.gap).toBeCloseTo(4 / 117 - 12 / 619, 5)
    expect(gap?.lower).toBeLessThan(0)
    // clearly more: 20 in 100 against 12 in 619
    const worse = regressionGap({ light: { regressions: 20, issues: 100 }, lead: { regressions: 12, issues: 619 } })
    expect(worse?.lower).toBeGreaterThan(0.05)
    expect(regressionGap({ light: { regressions: 0, issues: 0 }, lead: { regressions: 1, issues: 5 } })).toBeNull()
  })

  test('narrows when too many Issues move up for the bound the cost sets', () => {
    expect(judgeLightGate({ light: seat(71, 75, { movedUpShare: 0.5 }), lead, bound: 0.47 }).met).toBe(false)
    expect(judgeLightGate({ light: seat(71, 75, { movedUpShare: 0.46 }), lead, bound: 0.47 }).met).toBe(true)
  })

  test('a move-up is not a failed pass: a heavy move-up share under the bound still widens', () => {
    expect(judgeLightGate({ light: seat(71, 75, { movedUpShare: 0.4 }), lead, bound: 0.94 }).met).toBe(true)
  })

  test('is not measured, and so closed, with too few finished first watches, no cost or no rate', () => {
    expect(judgeLightGate({ light: light(9, 9), lead, bound: 0.94 }).met).toBeNull()
    expect(judgeLightGate({ light: light(71, 75), lead, bound: null }).met).toBeNull()
    expect(
      judgeLightGate({ light: figures({ finishedPassRate: null, movedUpShare: 0.1 }), lead, bound: 0.94 }).met,
    ).toBeNull()
    expect(
      judgeLightGate({ light: light(71, 75), lead: figures({ finishedPassRate: null }), bound: 0.94 }).met,
    ).toBeNull()
  })

  test('a broken condition is false even when another is not measured', () => {
    const verdict = judgeLightGate({ light: light(80, 100), lead, bound: null })
    expect(verdict.met).toBe(false)
    expect(verdict.failing).toHaveLength(2)
  })
})

test('the reported confidence and the z the gaps are bound at are one level', () => {
  expect(TRIPWIRE_CONFIDENCE).toBe(0.95)
  expect(TRIPWIRE_Z).toBeCloseTo(1.6449, 4)
})

describe('tripwireFrom', () => {
  const now = new Date('2026-11-18T12:00:00Z')
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000)
  const at = (days: number, count: number) => Array.from({ length: count }, () => daysAgo(days))

  test('is the last 3 days when they hold 100 finished light watches', () => {
    expect(tripwireFrom({ now, watchAts: at(1, 100) })).toEqual(daysAgo(3))
  })

  test('reaches back to the day of the 100th newest watch when 3 days hold fewer', () => {
    expect(tripwireFrom({ now, watchAts: [...at(1, 75), ...at(5, 40)] })).toEqual(daysAgo(5))
  })

  test('is at most 14 days, whatever is found, and the whole 14 with fewer than 100', () => {
    expect(tripwireFrom({ now, watchAts: [...at(1, 75), ...at(20, 40)] })).toEqual(daysAgo(14))
    expect(tripwireFrom({ now, watchAts: at(1, 5) })).toEqual(daysAgo(14))
    expect(tripwireFrom({ now, watchAts: [] })).toEqual(daysAgo(14))
  })
})
