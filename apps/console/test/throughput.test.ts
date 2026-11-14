import { expect, test } from 'bun:test'
import type { ThroughputModel } from '@software-factory/contract'
import {
  classRows,
  kpiValue,
  levelHeight,
  minutesWords,
  msWords,
  percentWords,
  progress,
  splitRows,
  throughputWindowOf,
} from '../src/lib/throughput.ts'

const byClass = (rows: [string, number, number][]): ThroughputModel =>
  ({
    host: {
      byClass: rows.map(([name, footprintMib, share]) => ({
        class: name,
        footprintMib,
        peakMib: footprintMib,
        cpuSeconds: 0,
        cores: 0,
        procs: 0,
        share,
      })),
    },
  }) as unknown as ThroughputModel

test('a window is one of the three, anything else the day', () => {
  expect([24, 168, 336, '168'].map(throughputWindowOf)).toEqual([24, 168, 336, 168])
  expect([5, 'x', undefined, 0].map(throughputWindowOf)).toEqual([24, 24, 24, 24])
})

test('classes come largest first, ties in the fixed order', () => {
  const rows = classRows(
    byClass([
      ['other', 0, 0],
      ['lead', 100, 0.1],
      ['system', 800, 0.8],
      ['step', 100, 0.1],
      ['factory', 0, 0],
    ]),
  )
  expect(rows.map((r) => r.class)).toEqual(['system', 'lead', 'step', 'factory', 'other'])
  expect(rows[0]?.label).toBe('System')
})

test('the split is in the order a lead lives it, with shares over the parts and none with no time', () => {
  const split = {
    turnSeconds: 600,
    stepSeconds: 300,
    slotWaitSeconds: 0,
    ciSeconds: 600,
    mergeLockSeconds: 0,
    ownerSeconds: 0,
    idleSeconds: 0,
  }
  const rows = splitRows(split)
  expect(rows.map((r) => r.key)).toEqual([
    'turnSeconds',
    'stepSeconds',
    'slotWaitSeconds',
    'ciSeconds',
    'mergeLockSeconds',
    'ownerSeconds',
    'idleSeconds',
  ])
  expect(rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1, 9)
  expect(rows[0]?.share).toBe(0.4)
  expect(new Set(rows.map((r) => r.slot)).size).toBe(7)
  expect(splitRows({ ...split, turnSeconds: 0, stepSeconds: 0, ciSeconds: 0 }).every((r) => r.share === 0)).toBe(true)
})

test('figures read in words, a missing one as a dash', () => {
  expect(percentWords(0.004)).toBe('<1 %')
  expect(percentWords(0)).toBe('0 %')
  expect(percentWords(0.2495)).toBe('25 %')
  expect(minutesWords(45)).toBe('45 min')
  expect(minutesWords(90)).toBe('1.5 h')
  expect(msWords(null)).toBe('–')
  expect(msWords(900)).toBe('900 ms')
  expect(msWords(2500)).toBe('2.5 s')
  expect(msWords(180_000)).toBe('3 min')
  expect(kpiValue('step_peak_mib', 3000)).toBe('2.9 GiB')
  expect(kpiValue('step_peak_mib', null)).toBe('–')
  expect(kpiValue('unknown_kpi', 12.4)).toBe('12')
})

test('the kernel pressure levels are heights 0, 1 and 2, and an unread level is a gap', () => {
  expect([1, 2, 4, null].map(levelHeight)).toEqual([0, 1, 2, null])
})

test('progress is the share of the way to the target, null without an after', () => {
  const finding = (before: number, target: number, after: number | null) =>
    ({ before, target, after }) as ThroughputModel['improvements'][number]
  expect(progress(finding(100, 50, 75))).toBe(0.5)
  expect(progress(finding(100, 50, 40))).toBe(1.2)
  expect(progress(finding(100, 50, 120))).toBe(-0.4)
  expect(progress(finding(100, 50, null))).toBeNull()
  expect(progress(finding(50, 50, 40))).toBeNull()
})
