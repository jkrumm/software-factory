import { describe, expect, test } from 'bun:test'
import {
  evaluate,
  type Finding,
  type RuleName,
  type Sample,
  type SystemView,
} from '../../src/domains/intake/beszel-rules.ts'
import { DEFAULT_THRESHOLDS } from '../../src/domains/intake/infra.ts'

const MIN = 60_000
const NOW = new Date('2026-11-07T12:00:00.000Z')
const T = DEFAULT_THRESHOLDS

const base: Sample = {
  at: NOW,
  memPct: 50,
  swapUsedGb: 0,
  swapTotalGb: 16,
  diskPct: 40,
  diskUsedGb: 40,
  diskTotalGb: 100,
  load1: 0.5,
}

/** `count` samples, one a minute, the newest `endAgo` minutes before NOW; `f` gets the minutes before the newest. */
function series(count: number, f: (fromEnd: number, index: number) => Partial<Sample>, endAgo = 0): Sample[] {
  return Array.from({ length: count }, (_, index) => {
    const fromEnd = count - 1 - index
    return { ...base, at: new Date(NOW.getTime() - (fromEnd + endAgo) * MIN), ...f(fromEnd, index) }
  })
}

const system = (extra: Partial<SystemView> = {}): SystemView => ({
  name: 'macmini',
  status: 'up',
  threads: 8,
  updated: null,
  ...extra,
})

const find = (samples: Sample[], rule: RuleName, sys = system()): Finding =>
  evaluate(samples, sys, T, NOW).find((f) => f.rule === rule) as Finding

const minuteOf = (d: Date | null) => d?.toISOString().slice(0, 16)

describe.each([
  { rule: 'memory' as const, hot: { memPct: 95 }, cold: { memPct: 60 }, sustain: 15 },
  { rule: 'swap' as const, hot: { swapUsedGb: 9 }, cold: { swapUsedGb: 1 }, sustain: 10 },
  { rule: 'load' as const, hot: { load1: 30 }, cold: { load1: 5 }, sustain: 15 },
  { rule: 'disk' as const, hot: { diskPct: 93 }, cold: { diskPct: 60 }, sustain: 10 },
])('$rule', ({ rule, hot, cold, sustain }) => {
  test('breach: every sample of the sustain window, since is the start of the run', () => {
    const samples = series(40, (fromEnd) => (fromEnd < 20 ? hot : cold))
    const f = find(samples, rule)
    expect(f.state).toBe('breach')
    expect(minuteOf(f.since)).toBe(minuteOf(new Date(NOW.getTime() - 19 * MIN)))
    expect(f.numbers.minutesSustained).toBe(19)
    expect(f.numbers.latest).not.toBeNull()
    expect(f.numbers.windowMax).not.toBeNull()
    expect(f.numbers.threshold).not.toBeNull()
  })

  test('hold: one cool sample inside the window', () => {
    const samples = series(40, (fromEnd) => (fromEnd === 3 ? cold : hot))
    expect(find(samples, rule).state).toBe('hold')
  })

  test('hold: the hot run is shorter than the window', () => {
    const samples = series(40, (fromEnd) => (fromEnd < sustain - 3 ? hot : cold))
    expect(find(samples, rule).state).toBe('hold')
  })

  test('clear: all samples of the clear window below, recovered is the start of the cool run', () => {
    const samples = series(40, (fromEnd) => (fromEnd < 12 ? cold : hot))
    const f = find(samples, rule)
    expect(f.state).toBe('clear')
    expect(minuteOf(f.recovered)).toBe(minuteOf(new Date(NOW.getTime() - 11 * MIN)))
  })

  test('hold below coverage: too few samples in the window', () => {
    const samples = series(40, () => hot).filter((_, i) => i % 3 === 0 || i === 39)
    expect(find(samples, rule).state).toBe('hold')
  })

  test('hold when the newest sample is stale', () => {
    expect(
      find(
        series(40, () => hot, 5),
        rule,
      ).state,
    ).toBe('hold')
  })

  test('a paused system has no findings', () => {
    expect(
      evaluate(
        series(40, () => hot),
        system({ status: 'paused' }),
        T,
        NOW,
      ),
    ).toEqual([])
  })
})

describe('load per thread', () => {
  test('the limit is 3 per thread, or 20 when the threads are unknown', () => {
    const samples = series(20, () => ({ load1: 13 }))
    expect(find(samples, 'load', system({ threads: 4 })).state).toBe('breach')
    expect(find(samples, 'load', system({ threads: null })).state).toBe('clear')
    expect(find(samples, 'load', system({ threads: 8 })).state).toBe('clear')
  })
})

describe('swap_growth', () => {
  const growing = (fromEnd: number) => ({ swapUsedGb: 6 - fromEnd * 0.05 })

  test('breach: the newest median is 2 GB over the oldest and at least 1 GB', () => {
    const f = find(series(120, growing), 'swap_growth')
    expect(f.state).toBe('breach')
    expect(f.since).not.toBeNull()
    expect(f.numbers.growthGb).toBeGreaterThanOrEqual(2)
    expect(f.numbers.threshold).toBe(2)
  })

  test('clear: flat swap, now and clearMin ago', () => {
    const f = find(
      series(120, () => ({ swapUsedGb: 3 })),
      'swap_growth',
    )
    expect(f.state).toBe('clear')
    expect(f.recovered).not.toBeNull()
  })

  test('hold: the swap fell only a few minutes ago', () => {
    const shape = (fromEnd: number) => ({ swapUsedGb: fromEnd < 7 ? 0 : fromEnd >= 110 ? 0.2 : 6 })
    expect(find(series(120, shape), 'swap_growth').state).toBe('hold')
  })

  test('a short history and a stale series hold, a small growth clears', () => {
    expect(find(series(15, growing), 'swap_growth').state).toBe('hold')
    expect(
      find(
        series(120, (fromEnd) => ({ swapUsedGb: 0.9 - fromEnd * 0.005 })),
        'swap_growth',
      ).state,
    ).toBe('clear')
    expect(find(series(120, growing, 6), 'swap_growth').state).toBe('hold')
  })
})

describe('disk filling fast', () => {
  const filling = (fromEnd: number) => ({ diskUsedGb: 70 - fromEnd * 0.1, diskPct: 70 - fromEnd * 0.1 })

  test('breach below the percent threshold when full in under 24 h', () => {
    const f = find(series(120, filling), 'disk')
    expect(f.state).toBe('breach')
    expect(f.label).toBe('disk filling fast')
    expect(f.numbers.hoursToFull).toBeLessThan(24)
    expect(f.numbers.growthGbPerHour).toBeGreaterThan(0.5)
  })

  test('slow growth, a nearly empty disk or a flat disk is no breach', () => {
    expect(
      find(
        series(120, (e) => ({ diskUsedGb: 70 - e * 0.005, diskPct: 70 })),
        'disk',
      ).state,
    ).toBe('clear')
    expect(
      find(
        series(120, (e) => ({ diskUsedGb: 30 - e * 0.1, diskPct: 30 - e * 0.1 })),
        'disk',
      ).state,
    ).toBe('clear')
    expect(
      find(
        series(120, () => ({ diskUsedGb: 70, diskPct: 70 })),
        'disk',
      ).state,
    ).toBe('clear')
  })
})

describe('silent', () => {
  test('breach: the newest sample is older than 10 min, since is that sample', () => {
    const f = find(
      series(30, () => ({}), 15),
      'silent',
    )
    expect(f.state).toBe('breach')
    expect(minuteOf(f.since)).toBe(minuteOf(new Date(NOW.getTime() - 15 * MIN)))
  })

  test('breach: the system record down for that long, even with fresh samples', () => {
    const f = find(
      series(30, () => ({})),
      'silent',
      system({ status: 'down', updated: new Date(NOW.getTime() - 12 * MIN) }),
    )
    expect(f.state).toBe('breach')
  })

  test('hold: stale for 5 min only, or down for 3 min', () => {
    expect(
      find(
        series(30, () => ({}), 5),
        'silent',
      ).state,
    ).toBe('hold')
    expect(
      find(
        series(30, () => ({})),
        'silent',
        system({ status: 'down', updated: new Date(NOW.getTime() - 3 * MIN) }),
      ).state,
    ).toBe('hold')
  })

  test('clear: fresh and covered; recovered starts after the last gap', () => {
    const samples = series(30, () => ({})).filter((_, i) => i < 10 || i > 14)
    const f = find(samples, 'silent')
    expect(f.state).toBe('clear')
    expect(minuteOf(f.recovered)).toBe(minuteOf(new Date(NOW.getTime() - 14 * MIN)))
  })

  test('silent speaks without fresh samples; the other rules hold', () => {
    const findings = evaluate(
      series(30, () => ({ memPct: 99 }), 15),
      system(),
      T,
      NOW,
    )
    expect(findings.filter((f) => f.state !== 'hold').map((f) => f.rule)).toEqual(['silent'])
  })
})
