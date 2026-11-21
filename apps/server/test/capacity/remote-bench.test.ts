import { describe, expect, test } from 'bun:test'
import {
  activeBench,
  FIRST_BENCH_MS,
  type BenchEvent,
  benchOf,
  benchWords,
  MAX_BENCH_MS,
  NO_BENCH,
} from '../../src/kernel/remote-bench.ts'
import {
  aboveP99,
  BASELINE_MIN_SAMPLES,
  BASELINE_MIN_SPAN_MS,
  DEFAULT_PRESSURE_PCT,
  MAX_PRESSURE_PCT,
  pressureThreshold,
} from '../../src/kernel/remote-pressure.ts'

const T0 = new Date('2026-11-17T13:00:00Z').getTime()
const H = 3_600_000
const D = 24 * H
const at = (ms: number): Date => new Date(T0 + ms)
const bad = (ms: number): BenchEvent => ({ at: at(ms), kind: 'disagreed' })
const green = (ms: number): BenchEvent => ({ at: at(ms), kind: 'green' })
const lengthOf = (events: BenchEvent[]): number => {
  const state = benchOf(events)
  return state.until === null || state.lastDisagreementAt === null
    ? 0
    : state.until.getTime() - state.lastDisagreementAt.getTime()
}

describe('the graded bench after a disagreement', () => {
  test('no disagreement, no bench', () => {
    expect(benchOf([])).toEqual(NO_BENCH)
    expect(benchOf([green(0), green(H)])).toEqual(NO_BENCH)
  })

  test('the first disagreement benches the step for one hour, and says when it ends', () => {
    const state = benchOf([bad(0)])
    expect(lengthOf([bad(0)])).toBe(FIRST_BENCH_MS)
    expect(state.until).toEqual(at(H))
    expect(activeBench(state, at(30 * 60_000))).toEqual({ until: at(H), benchMs: H })
    expect(activeBench(state, at(H))).toBeNull()
  })

  test('each further disagreement within a week of the bench ending doubles it', () => {
    expect(lengthOf([bad(0), bad(2 * H)])).toBe(2 * H)
    expect(lengthOf([bad(0), bad(2 * H), bad(6 * H)])).toBe(4 * H)
    expect(benchOf([bad(0), bad(2 * H), bad(6 * H)]).disagreements).toBe(3)
  })

  test('the bench is capped at seven days', () => {
    const events: BenchEvent[] = []
    let when = 0
    for (let i = 0; i < 12; i++) {
      events.push(bad(when))
      when += lengthOf(events) + H
    }
    expect(lengthOf(events)).toBe(MAX_BENCH_MS)
  })

  test('a disagreement more than a week after the bench ended starts again at one hour', () => {
    // the second bench ends at 4 h
    expect(lengthOf([bad(0), bad(2 * H), bad(4 * H + 6 * D)])).toBe(4 * H)
    expect(lengthOf([bad(0), bad(2 * H), bad(4 * H + 8 * D)])).toBe(FIRST_BENCH_MS)
    expect(benchOf([bad(0), bad(2 * H), bad(4 * H + 8 * D)]).disagreements).toBe(1)
  })

  test('a green run off the mini after the bench halves it, once, for the next disagreement', () => {
    // 4 h bench after the third disagreement; green runs after it ends halve the next bench to 2 h, not further
    const grown = [bad(0), bad(2 * H), bad(6 * H)]
    const afterGreens = [...grown, green(11 * H), green(12 * H), green(13 * H)]
    expect(benchOf(afterGreens).benchMs).toBe(2 * H)
    // the next disagreement doubles the halved bench: back at 4 h
    expect(lengthOf([...afterGreens, bad(14 * H)])).toBe(4 * H)
  })

  test('a green run while the bench still runs changes nothing', () => {
    expect(benchOf([bad(0), green(30 * 60_000)]).benchMs).toBe(H)
  })

  test('a bench halved below the first bench is gone: the next disagreement is a first one', () => {
    const state = benchOf([bad(0), green(2 * H)])
    expect(state.benchMs).toBe(0)
    expect(lengthOf([bad(0), green(2 * H), bad(3 * H)])).toBe(FIRST_BENCH_MS)
    // and it counts as the first of a new chain
    expect(benchOf([bad(0), green(2 * H), bad(3 * H)]).disagreements).toBe(1)
  })

  test('the events may come in any order', () => {
    expect(lengthOf([bad(2 * H), bad(0)])).toBe(2 * H)
  })

  test('a bench is worded in hours and days', () => {
    expect(benchWords(H)).toBe('1 h')
    expect(benchWords(4 * H)).toBe('4 h')
    expect(benchWords(MAX_BENCH_MS)).toBe('7 d')
    expect(benchWords(30 * 60_000)).toBe('30 min')
  })
})

describe('the pressure line from the baseline', () => {
  const day = { samples: BASELINE_MIN_SAMPLES, spanMs: BASELINE_MIN_SPAN_MS, memoryP99: 0, ioP99: 0 }

  test('without a day of samples the line is the default', () => {
    expect(pressureThreshold(null)).toEqual({ memory: DEFAULT_PRESSURE_PCT, io: DEFAULT_PRESSURE_PCT, from: 'default' })
    expect(pressureThreshold({ ...day, spanMs: BASELINE_MIN_SPAN_MS - 1 }).from).toBe('default')
    expect(pressureThreshold({ ...day, samples: BASELINE_MIN_SAMPLES - 1 }).from).toBe('default')
  })

  test('with a day, the line sits just above the p99 of each pressure', () => {
    // at rest (p99 0.00) the margin of half a point is the line; a calmer or noisier host moves it
    expect(pressureThreshold(day)).toEqual({ memory: 0.5, io: 0.5, from: 'baseline' })
    expect(pressureThreshold({ ...day, memoryP99: 0.4, ioP99: 2 })).toEqual({ memory: 0.9, io: 2.5, from: 'baseline' })
  })

  test('the line never passes the old flat ten', () => {
    expect(aboveP99(30)).toBe(MAX_PRESSURE_PCT)
    expect(pressureThreshold({ ...day, ioP99: 40 }).io).toBe(MAX_PRESSURE_PCT)
  })
})
