import { expect, test } from 'bun:test'
import type { FindingClass, Kpi } from '@software-factory/contract'
import {
  classWords,
  formatKpi,
  sampleWords,
  targetStatus,
  targetWords,
  windowOf,
  windowWords,
} from '../src/lib/improve.ts'

const kpi = (over: Partial<Kpi>): Kpi => ({
  key: 'avoidable_touches',
  label: 'x',
  value: 0.25,
  unit: 'per_issue',
  n: 4,
  count: 1,
  target: { kind: 'between', min: 0.05, max: 0.07 },
  measured: true,
  definition: '',
  ...over,
})

test('windowOf takes 7, 30 or 90 and falls back to 7', () => {
  expect(windowOf('30')).toBe(30)
  expect(windowOf('90')).toBe(90)
  expect(windowOf('7')).toBe(7)
  expect(windowOf('12')).toBe(7)
  expect(windowOf(undefined)).toBe(7)
})

test('formatKpi by unit, and why a value is missing', () => {
  expect(formatKpi(kpi({}))).toBe('0.25')
  expect(formatKpi(kpi({ unit: 'share', value: 0.912 }))).toBe('91%')
  expect(formatKpi(kpi({ unit: 'usd', value: 0.74 }))).toBe('$0.74')
  expect(formatKpi(kpi({ unit: 'points', value: 3.26 }))).toBe('3.3')
  expect(formatKpi(kpi({ unit: 'ms', value: 37 * 60_000 }))).toBe('37 min')
  expect(formatKpi(kpi({ unit: 'ms', value: 8.8 * 3_600_000 }))).toBe('8.8 h')
  expect(formatKpi(kpi({ unit: 'ms', value: 2.1 * 86_400_000 }))).toBe('2.1 d')
  expect(formatKpi(kpi({ value: null }))).toBe('No data')
  expect(formatKpi(kpi({ value: null, measured: false }))).toBe('Not measured')
})

test('targetWords and targetStatus are literal', () => {
  expect(targetWords(kpi({}))).toBe('0.05 to 0.07')
  expect(targetWords(kpi({ target: { kind: 'at_most', min: null, max: 0.25 } }))).toBe('at most 0.25')
  expect(targetWords(kpi({ unit: 'share', target: { kind: 'at_least', min: 0.9, max: null } }))).toBe('at least 90%')
  expect(targetWords(kpi({ target: { kind: 'trend', min: null, max: null } }))).toBe('Trend only')
  expect(targetWords(kpi({ target: { kind: 'unset', min: null, max: null } }))).toBe('No target')

  expect(targetStatus(kpi({ value: 0.06 }))).toBe('met')
  expect(targetStatus(kpi({ value: 0.01 }))).toBe('missed')
  expect(targetStatus(kpi({ value: 0.3 }))).toBe('missed')
  expect(targetStatus(kpi({ value: 0.25, target: { kind: 'at_most', min: null, max: 0.25 } }))).toBe('met')
  expect(targetStatus(kpi({ value: 0.8, target: { kind: 'at_least', min: 0.9, max: null } }))).toBe('missed')
  expect(targetStatus(kpi({ target: { kind: 'trend', min: null, max: null } }))).toBe('trend')
  expect(targetStatus(kpi({ target: { kind: 'unset', min: null, max: null } }))).toBe('no_target')
  expect(targetStatus(kpi({ value: null }))).toBe('no_data')
  expect(targetStatus(kpi({ value: null, measured: false }))).toBe('not_measured')
})

test('sampleWords and windowWords', () => {
  expect(sampleWords({ key: 'asks', n: 13 })).toBe('13 Issues')
  expect(sampleWords({ key: 'worth_asking', n: 1 })).toBe('1 Decision')
  expect(sampleWords({ key: 'queue_wait_p90', n: 0 })).toBe('0 samples')
  expect(windowWords({ from: '2026-11-01T00:00:00Z', to: '2026-11-08T10:00:00Z' })).toBe('2026-11-01 to 2026-11-08')
})

test('classWords: a held class says when it is asked again, a probation class how it files', () => {
  const cls: FindingClass = {
    loop: 'hygiene',
    repo: 'app',
    class: 'cochange',
    status: 'held',
    issues: 5,
    decided: 4,
    noise: 3,
    share: 0.75,
    open: 0,
    heldUntil: '2026-11-15T10:00:00.000Z',
  }
  expect(classWords(cls)).toBe('3 of 4 dropped or cancelled, asked again 2026-11-15')
  expect(classWords({ ...cls, status: 'probation' })).toBe(
    '3 of 4 dropped or cancelled, one Issue at a time until one closes done',
  )
})
