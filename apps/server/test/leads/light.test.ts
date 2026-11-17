import { describe, expect, test } from 'bun:test'
import { judgeLightGate, moveUpBound, type SeatFigures } from '@software-factory/contract'
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
  test('a mechanical hygiene class starts light, by probe, judgment kind or declared probe name', () => {
    expect(lightRule(facts({ hygieneKey: 'links:docs/guide.md' }))).toBe('hygiene:links')
    expect(lightRule(facts({ hygieneKey: 'judgment:stale:docs/x.md' }))).toBe('hygiene:stale')
    expect(lightRule(facts({ hygieneKey: 'probe:readme' }))).toBe('hygiene:readme')
    expect(lightRule(facts({ hygieneKey: 'deps' }))).toBe('hygiene:deps')
  })

  test('a hygiene class that needs judgment stays on the lead row', () => {
    expect(lightRule(facts({ hygieneKey: 'check' }))).toBeNull()
    expect(lightRule(facts({ hygieneKey: 'judgment:slop:docs/x.md' }))).toBeNull()
    expect(lightRule(facts({ hygieneKey: 'cochange:a|b' }))).toBeNull()
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
    regressionsPerIssue: 0.03,
    movedUpShare: null,
    ...over,
  })
  const lead = figures({ finishedWatches: 900, finishedPassRate: 0.956, regressionsPerIssue: 0.05 })
  const light = (over: Partial<SeatFigures> = {}) => figures({ movedUpShare: 0.17, ...over })

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

  test("widens on the owner's first figures: 94.9 against 95.6, 17 % moved up", () => {
    const verdict = judgeLightGate({ light: light({ finishedPassRate: 0.949 }), lead, bound: 0.94 })
    expect(verdict).toEqual({ met: true, failing: [] })
  })

  test("narrows when the window's pass rate falls more than 3 points under lead's", () => {
    const verdict = judgeLightGate({ light: light({ finishedPassRate: 0.92 }), lead, bound: 0.94 })
    expect(verdict.met).toBe(false)
    expect(verdict.failing).toHaveLength(1)
    expect(judgeLightGate({ light: light({ finishedPassRate: 0.926 }), lead, bound: 0.94 }).met).toBe(true)
  })

  test('narrows when light regresses more per Issue than lead', () => {
    const verdict = judgeLightGate({ light: light({ regressionsPerIssue: 0.06 }), lead, bound: 0.94 })
    expect(verdict.met).toBe(false)
    expect(judgeLightGate({ light: light({ regressionsPerIssue: 0.05 }), lead, bound: 0.94 }).met).toBe(true)
  })

  test('narrows when too many Issues move up for the bound the cost sets', () => {
    expect(judgeLightGate({ light: light({ movedUpShare: 0.5 }), lead, bound: 0.47 }).met).toBe(false)
    expect(judgeLightGate({ light: light({ movedUpShare: 0.46 }), lead, bound: 0.47 }).met).toBe(true)
  })

  test('a move-up is not a failed pass: a heavy move-up share under the bound still widens', () => {
    expect(judgeLightGate({ light: light({ movedUpShare: 0.4 }), lead, bound: 0.94 }).met).toBe(true)
  })

  test('is not measured, and so closed, with too few finished first watches, no cost or no rate', () => {
    expect(judgeLightGate({ light: light({ finishedWatches: 9 }), lead, bound: 0.94 }).met).toBeNull()
    expect(judgeLightGate({ light: light(), lead, bound: null }).met).toBeNull()
    expect(judgeLightGate({ light: light({ regressionsPerIssue: null }), lead, bound: 0.94 }).met).toBeNull()
    expect(judgeLightGate({ light: light(), lead: figures({ finishedPassRate: null }), bound: 0.94 }).met).toBeNull()
  })

  test('a broken condition is false even when another is not measured', () => {
    const verdict = judgeLightGate({ light: light({ regressionsPerIssue: 0.09 }), lead, bound: null })
    expect(verdict.met).toBe(false)
    expect(verdict.failing).toHaveLength(2)
  })
})
