import { describe, expect, test } from 'bun:test'
import {
  activeHold,
  FIRST_HOLD_MS,
  type HoldEvent,
  holdOf,
  holdWords,
  MAX_HOLD_MS,
  NO_HOLD,
} from '../../src/kernel/remote-hold.ts'
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
const bad = (ms: number): HoldEvent => ({ at: at(ms), kind: 'disagreed' })
const green = (ms: number): HoldEvent => ({ at: at(ms), kind: 'green' })
const lengthOf = (events: HoldEvent[]): number => {
  const state = holdOf(events)
  return state.until === null || state.lastDisagreementAt === null
    ? 0
    : state.until.getTime() - state.lastDisagreementAt.getTime()
}

describe('the graded hold after a disagreement', () => {
  test('no disagreement, no hold', () => {
    expect(holdOf([])).toEqual(NO_HOLD)
    expect(holdOf([green(0), green(H)])).toEqual(NO_HOLD)
  })

  test('the first disagreement holds the step for one hour, and says when it ends', () => {
    const state = holdOf([bad(0)])
    expect(lengthOf([bad(0)])).toBe(FIRST_HOLD_MS)
    expect(state.until).toEqual(at(H))
    expect(activeHold(state, at(30 * 60_000))).toEqual({ until: at(H), holdMs: H })
    expect(activeHold(state, at(H))).toBeNull()
  })

  test('each further disagreement within a week of the hold ending doubles it', () => {
    expect(lengthOf([bad(0), bad(2 * H)])).toBe(2 * H)
    expect(lengthOf([bad(0), bad(2 * H), bad(6 * H)])).toBe(4 * H)
    expect(holdOf([bad(0), bad(2 * H), bad(6 * H)]).disagreements).toBe(3)
  })

  test('the hold is capped at seven days', () => {
    const events: HoldEvent[] = []
    let when = 0
    for (let i = 0; i < 12; i++) {
      events.push(bad(when))
      when += lengthOf(events) + H
    }
    expect(lengthOf(events)).toBe(MAX_HOLD_MS)
  })

  test('a disagreement more than a week after the hold ended starts again at one hour', () => {
    // the second hold ends at 4 h
    expect(lengthOf([bad(0), bad(2 * H), bad(4 * H + 6 * D)])).toBe(4 * H)
    expect(lengthOf([bad(0), bad(2 * H), bad(4 * H + 8 * D)])).toBe(FIRST_HOLD_MS)
    expect(holdOf([bad(0), bad(2 * H), bad(4 * H + 8 * D)]).disagreements).toBe(1)
  })

  test('a green run off the mini after the hold halves it, once, for the next disagreement', () => {
    // 4 h hold after the third disagreement; green runs after it ends halve the next hold to 2 h, not further
    const grown = [bad(0), bad(2 * H), bad(6 * H)]
    const afterGreens = [...grown, green(11 * H), green(12 * H), green(13 * H)]
    expect(holdOf(afterGreens).holdMs).toBe(2 * H)
    // the next disagreement doubles the halved hold: back at 4 h
    expect(lengthOf([...afterGreens, bad(14 * H)])).toBe(4 * H)
  })

  test('a green run while the hold still runs changes nothing', () => {
    expect(holdOf([bad(0), green(30 * 60_000)]).holdMs).toBe(H)
  })

  test('a hold halved below the first hold is gone: the next disagreement is a first one', () => {
    const state = holdOf([bad(0), green(2 * H)])
    expect(state.holdMs).toBe(0)
    expect(lengthOf([bad(0), green(2 * H), bad(3 * H)])).toBe(FIRST_HOLD_MS)
  })

  test('the events may come in any order', () => {
    expect(lengthOf([bad(2 * H), bad(0)])).toBe(2 * H)
  })

  test('a hold is worded in hours and days', () => {
    expect(holdWords(H)).toBe('1 h')
    expect(holdWords(4 * H)).toBe('4 h')
    expect(holdWords(MAX_HOLD_MS)).toBe('7 d')
    expect(holdWords(30 * 60_000)).toBe('30 min')
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
