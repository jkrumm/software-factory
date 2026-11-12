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
  /** A 100 GB disk at 86% growing 10 GB over the 200 min window. */
  const filling = (fromEnd: number) => ({ diskUsedGb: 86 - fromEnd * 0.05, diskPct: 86 - fromEnd * 0.05 })
  /** The mini: 900 GB, 80% used, 180 GB free. `burst(fromEnd)` is the scratch write on top. */
  const mini = (burst: (fromEnd: number) => number) => (fromEnd: number) => ({
    diskUsedGb: 720 + burst(fromEnd),
    diskPct: 80,
    diskTotalGb: 900,
  })

  test('breach below the percent threshold when a steady fill is full in under 24 h', () => {
    const f = find(series(200, filling), 'disk')
    expect(f.state).toBe('breach')
    expect(f.label).toBe('disk filling fast')
    expect(f.numbers.hoursToFull).toBeLessThan(24)
    expect(f.numbers.growthGbPerHour).toBeGreaterThan(0.5)
  })

  test('the overnight pattern never breaches: a 3 to 15 GB rise freed within minutes at 80% used, 180 GB free', () => {
    for (const gbRise of [3, 15]) {
      for (const [lasting, freedAgo] of [
        [8, 0], // still on the disk at evaluation
        [8, 20], // freed 20 min ago
        [8, 90], // freed long ago
      ] as const) {
        const burst = (e: number) => (e < freedAgo + lasting && e >= freedAgo ? gbRise : 0)
        expect(find(series(200, mini(burst)), 'disk').state).not.toBe('breach')
      }
    }
  })

  test('below the free-space floor a burst at one end of the window is still no fill', () => {
    // 500 GB disk at 86% (past the floor), +15 GB for the last 40 min: full in 12 h by the slope, but not sustained.
    const tight = (e: number) => ({ diskUsedGb: 430 + (e < 40 ? 15 : 0), diskPct: 86, diskTotalGb: 500 })
    expect(find(series(200, tight), 'disk').state).not.toBe('breach')
  })

  test('a swing that rose mid-window and was partly freed is no fill', () => {
    const swung = (e: number) => ({
      diskUsedGb: 430 + (e >= 70 && e < 130 ? 30 : e < 70 ? 10 : 0),
      diskPct: 86,
      diskTotalGb: 500,
    })
    expect(find(series(200, swung), 'disk').state).not.toBe('breach')
  })

  test('a round-build sawtooth is no fill: a build 150 min in is steep, but the last round freed its copy 225 min ago', () => {
    // 900 GB disk at ~87%; a 0.2 GB/min build for the last 150 min. `freedAgo` is when the previous round's copy was removed.
    const sawtooth = (freedAgo: number | null) => (e: number) => ({
      diskUsedGb: 780 + (e < 150 ? (150 - e) * 0.2 : freedAgo !== null && e >= freedAgo ? 30 : 0),
      diskPct: 87,
      diskTotalGb: 900,
    })
    expect(find(series(240, sawtooth(225)), 'disk').state).not.toBe('breach')
    // The same climb with no decline before it is a fill.
    expect(find(series(240, sawtooth(null)), 'disk').state).toBe('breach')
  })

  test('a fill that crossed the free-space floor a minute ago holds until it has lasted sustainMin', () => {
    // 900 GB disk, a steady 20 GB/h climb that crosses 85% used (765 GB) exactly `crossedAgo` minutes before NOW.
    const climbing = (crossedAgo: number) => (e: number) => {
      const used = 765 + (crossedAgo - e) * (20 / 60)
      return { diskUsedGb: used, diskPct: (used / 900) * 100, diskTotalGb: 900 }
    }
    expect(find(series(200, climbing(1)), 'disk').state).toBe('hold')
    expect(find(series(200, climbing(3)), 'disk').state).toBe('hold')
    expect(find(series(200, climbing(30)), 'disk').state).toBe('breach')
  })

  test('a ramp that has gone flat is no fill, however steep the window slope was', () => {
    // A steady 20 GB/h climb across the window on a 900 GB disk (ends at 86%, under the level threshold), flat for the last 12 min.
    const ramped = (e: number) => {
      const used = 710 + (200 - Math.max(e, 12)) * (20 / 60)
      return { diskUsedGb: used, diskPct: (used / 900) * 100, diskTotalGb: 900 }
    }
    expect(find(series(200, ramped), 'disk').state).not.toBe('breach')
  })

  test('a disk past the level threshold still alerts on level', () => {
    const f = find(
      series(200, () => ({ diskUsedGb: 93, diskPct: 93, diskTotalGb: 100 })),
      'disk',
    )
    expect(f.state).toBe('breach')
    expect(f.label).toBe('disk above 90%')
  })

  test('slow growth, a disk above the free-space floor or a flat disk is no breach', () => {
    expect(
      find(
        series(200, (e) => ({ diskUsedGb: 70 - e * 0.005, diskPct: 86 })),
        'disk',
      ).state,
    ).toBe('clear')
    expect(
      find(
        series(200, (e) => ({ diskUsedGb: 60 - e * 0.1, diskPct: 60 - e * 0.1 })),
        'disk',
      ).state,
    ).toBe('clear')
    expect(
      find(
        series(200, () => ({ diskUsedGb: 70, diskPct: 70 })),
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
