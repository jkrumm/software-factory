import { describe, expect, test } from 'bun:test'
import {
  hygieneClass,
  type LightFacts,
  lightRule,
  moveUpWhy,
  type StruggleFacts,
} from '../../src/domains/leads/light.ts'

const facts = (over: Partial<LightFacts> = {}): LightFacts => ({
  kind: 'feature',
  size: null,
  spec: false,
  hygieneKey: null,
  unroutedMonitor: false,
  movedUp: 0,
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

  test("triage's small starts light only behind the tripwire, and never with a design choice", () => {
    expect(lightRule(facts({ size: 'small' }))).toBeNull()
    expect(lightRule(facts({ size: 'small', triageSmall: true }))).toBe('triage:small')
    expect(lightRule(facts({ size: 'small', spec: true, triageSmall: true }))).toBeNull()
    expect(lightRule(facts({ size: 'medium', triageSmall: true }))).toBeNull()
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
