import { expect, test } from 'bun:test'
import type { ThroughputModel } from '@software-factory/contract'
import {
  classRows,
  dayWords,
  epochLine,
  gbNumber,
  gbOf,
  hostFigures,
  hostTrends,
  hoursWords,
  kpiValue,
  levelHeight,
  minutesWords,
  msWords,
  percentWords,
  progress,
  queueWords,
  RECENT_SPAN,
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

test('the queue and epoch words: a reason by name, hours with a decimal, a day short, and what a cut window says', () => {
  expect(queueWords('memory')).toBe('Host memory')
  expect(queueWords('unheard')).toBe('unheard')
  expect(hoursWords(9)).toBe('9.0 h')
  expect(dayWords('2026-11-13')).toBe('13 Nov')
  const epoch = (cut: boolean) =>
    ({
      hours: 168,
      epoch: { at: '2026-11-12T00:00:00.000Z', cut, countingSince: cut ? '2026-11-12T00:00:00.000Z' : null },
    }) as ThroughputModel
  expect(epochLine(epoch(false))).toStartWith('Counting since ')
  expect(epochLine(epoch(true))).toContain('the 7 days window starts there')
  expect(epochLine({ hours: 24, epoch: null } as ThroughputModel)).toBeNull()
})

const GIB = 1024 ** 3

const hostModel = (now: ThroughputModel['host']['now']): ThroughputModel =>
  ({
    hours: 24,
    host: {
      now,
      signals: {
        pressureMinutes: { normal: 1400, warning: 30, critical: 10, unread: 0 },
        load: { p50: 3.14, max: 20.2 },
        cpuBusyPct: { p50: 22.4, max: 71 },
        memoryUsedBytes: { p50: 38 * GIB, max: 52.26 * GIB },
        swapUsedBytes: { p50: 1 * GIB, max: 3 * GIB },
      },
    },
  }) as unknown as ThroughputModel

test('GB are 1024 cubed, one decimal under 100', () => {
  expect([gbNumber(41.25 * GIB), gbNumber(64 * GIB), gbNumber(0.34 * GIB), gbNumber(128.4 * GIB)]).toEqual([
    '41.3',
    '64',
    '0.3',
    '128',
  ])
  expect(gbOf(41.2 * GIB, 64 * GIB)).toBe('41.2 of 64 GB')
})

test('the host row reads amounts: CPU percent, GB of the RAM and of the swap, load against its ceiling on named cores', () => {
  const figures = hostFigures(
    hostModel({
      at: '2026-11-16T10:00:00.000Z',
      cpuBusyPct: 34.6,
      load: 4.2,
      loadCeiling: 36,
      cores: 12,
      ramBytes: 64 * GIB,
      memoryUsedBytes: 41.2 * GIB,
      swapUsedBytes: 2.5 * GIB,
      swapTotalBytes: 8 * GIB,
      pressureLevel: 1,
    }),
  )
  expect(figures.cpu.value).toBe('35 %')
  expect(figures.cpu.sub).toBe('Typical 22 %, peak 71 % over 24 hours.')
  expect(figures.memory.value).toBe('41.2 of 64 GB')
  expect(figures.memory.sub).toBe('64 % of the RAM. Typical 38 GB, peak 52.3 GB over 24 hours.')
  expect(figures.swap.value).toBe('2.5 of 8 GB')
  expect(figures.swap.fill).toBeCloseTo(2.5 / 64)
  expect(figures.load.value).toBe('4.2 of 36')
  // load 4.2 on 12 cores is 35 % of one thread per core: how load differs from CPU percent
  expect(figures.load.sub).toBe('12 cores, so 35 % of one thread each. Typical 3.1, peak 20.2 over 24 hours.')
  expect(figures.load.fill).toBeCloseTo(4.2 / 36)
  expect(figures.pressure.value).toBe('Normal')
  expect(figures.pressure.sub).toBe('40 of 1440 minutes at warning or critical over 24 hours.')
})

test('a figure the host did not read is a dash with its reason, never zero', () => {
  const none = hostFigures(hostModel(null))
  for (const key of ['cpu', 'memory', 'swap', 'pressure', 'load'] as const) {
    expect(none[key].value).toBeNull()
    expect(none[key].fill).toBeNull()
  }
  const partial = hostFigures(
    hostModel({
      at: '2026-11-16T10:00:00.000Z',
      cpuBusyPct: null,
      load: 2,
      loadCeiling: null,
      cores: null,
      ramBytes: null,
      memoryUsedBytes: null,
      swapUsedBytes: 1 * GIB,
      swapTotalBytes: null,
      pressureLevel: null,
    }),
  )
  expect(partial.cpu.value).toBeNull()
  expect(partial.memory.value).toBeNull()
  expect(partial.swap.value).toBe('1 GB')
  expect(partial.load.value).toBe('2')
})

test('the host cards trend: 15 one-minute samples are 15 points, the newest being the figure the card reads', () => {
  const samples = Array.from({ length: 15 }, (_, i) => ({
    at: new Date(Date.UTC(2026, 10, 16, 10, i)).toISOString(),
    cpuBusyPct: 10 + i,
    memoryUsedBytes: (20 + i) * GIB,
    swapUsedBytes: i === 3 ? null : i * 0.1 * GIB,
    load: 1 + i / 2,
  }))
  const newest = samples[14] as (typeof samples)[number]
  const model = hostModel({
    at: newest.at,
    cpuBusyPct: newest.cpuBusyPct,
    load: newest.load,
    loadCeiling: 36,
    cores: 12,
    ramBytes: 64 * GIB,
    memoryUsedBytes: newest.memoryUsedBytes,
    swapUsedBytes: newest.swapUsedBytes,
    swapTotalBytes: 8 * GIB,
    pressureLevel: 1,
  })
  model.host.recent = samples
  const trends = hostTrends(model)
  const figures = hostFigures(model)
  expect(trends.cpu.values).toEqual(samples.map((s) => 10 + samples.indexOf(s)))
  expect(trends.memory.values).toHaveLength(15)
  expect(trends.swap.values[3]).toBeNull()
  expect(trends.load.values.at(-1)).toBe(8)
  expect(trends.cpu.labels).toHaveLength(15)
  // the last point reads exactly as the card's figure
  for (const key of ['cpu', 'memory', 'swap', 'load'] as const)
    expect(trends[key].format(trends[key].values.at(-1) as number)).toBe(figures[key].value as string)
  expect(RECENT_SPAN).toBe('last 15 min')
})

test('a host with no recent minute has no points', () => {
  const model = hostModel(null)
  model.host.recent = []
  expect(hostTrends(model).cpu.values).toEqual([])
})
