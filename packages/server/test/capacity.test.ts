import { describe, expect, test } from 'bun:test'
import { nextOpening, type Reading, READING_MAX_AGE_MS, pickEligible, standing, WEEK_MS } from '../src/capacity.ts'

const NOW = new Date('2026-10-30T12:00:00.000Z')
const at = (ms: number) => new Date(NOW.getTime() + ms)
const HOUR = 3_600_000

let nextId = 1
const reading = (account: string, extra: Partial<Reading> = {}): Reading => ({
  id: nextId++,
  account,
  readAt: NOW,
  sampledAt: NOW,
  enabled: true,
  authOk: true,
  fiveHourUsed: 10,
  weeklyUsed: 10,
  fiveHourResetsAt: at(2 * HOUR),
  weeklyResetsAt: at(3 * 24 * HOUR),
  exhaustedUntil: null,
  ...extra,
})

describe('standing: admission on one reading', () => {
  test('open below 85 % of the 5-hour window and below 95 % of the week', () => {
    expect(standing(reading('a', { fiveHourUsed: 84.9, weeklyUsed: 94.9 }), NOW)).toEqual({ open: true })
  })

  test.each([
    ['the 5-hour window at 85', { fiveHourUsed: 85 }, at(2 * HOUR)],
    ['the week at 95', { weeklyUsed: 95 }, at(3 * 24 * HOUR)],
  ])('closed by %s until that window resets', (_name, extra, until) => {
    expect(standing(reading('a', extra), NOW)).toEqual({ open: false, until })
  })

  test('closed by both windows until the later reset', () => {
    expect(standing(reading('a', { fiveHourUsed: 100, weeklyUsed: 99 }), NOW)).toEqual({
      open: false,
      until: at(3 * 24 * HOUR),
    })
  })

  test('an account the picker marked exhausted is closed until then', () => {
    expect(standing(reading('a', { exhaustedUntil: at(HOUR) }), NOW)).toEqual({ open: false, until: at(HOUR) })
    expect(standing(reading('a', { exhaustedUntil: at(-HOUR) }), NOW)).toEqual({ open: true })
  })

  test.each([
    ['disabled', { enabled: false }],
    ['auth failed', { authOk: false }],
    ['no 5-hour sample', { fiveHourUsed: null }],
    ['no weekly sample', { weeklyUsed: null }],
  ])('%s is closed with no time to name', (_name, extra) => {
    expect(standing(reading('a', extra), NOW)).toEqual({ open: false, until: null })
  })

  test('a wall whose reset is already past is a stale reading: closed, no time to name', () => {
    expect(standing(reading('a', { fiveHourUsed: 100, fiveHourResetsAt: at(-1) }), NOW)).toEqual({
      open: false,
      until: null,
    })
  })
})

describe('standing under pace: weekly use at or below the elapsed share of the week', () => {
  // The week ends in 3.5 days, so half of it has elapsed: 50 %.
  const half = { weeklyResetsAt: at(WEEK_MS / 2) }

  test('open at 50 %, closed at 60 % until the share reaches 60 %', () => {
    expect(standing(reading('a', { ...half, weeklyUsed: 50 }), NOW, true)).toEqual({ open: true })
    const closed = standing(reading('a', { ...half, weeklyUsed: 60 }), NOW, true)
    // 60 % of the week has elapsed 0.1 of a week from now.
    expect(closed).toEqual({ open: false, until: at(0.1 * WEEK_MS) })
  })

  test('without pace the same account is open', () => {
    expect(standing(reading('a', { ...half, weeklyUsed: 60 }), NOW)).toEqual({ open: true })
  })

  test('a week that has no end to count from names no time', () => {
    expect(standing(reading('a', { weeklyResetsAt: null }), NOW, true)).toEqual({ open: false, until: null })
  })
})

describe('pickEligible', () => {
  test('the open account with the least weekly use; ties by name', () => {
    const picked = pickEligible(
      [reading('b', { weeklyUsed: 20 }), reading('a', { weeklyUsed: 20 }), reading('c', { weeklyUsed: 50 })],
      new Map(),
      { now: NOW },
    )
    expect(picked?.account).toBe('a')
  })

  test('an account with a spawn its sample does not show yet is not offered again', () => {
    const readings = [reading('a'), reading('b', { weeklyUsed: 40 })]
    expect(pickEligible(readings, new Map([['a', 1]]), { now: NOW })?.account).toBe('b')
    expect(
      pickEligible(
        readings,
        new Map([
          ['a', 1],
          ['b', 1],
        ]),
        { now: NOW },
      ),
    ).toBeUndefined()
  })

  test('the account a spawn already has is kept while it is open', () => {
    const readings = [reading('a', { weeklyUsed: 5 }), reading('b', { weeklyUsed: 40 })]
    expect(pickEligible(readings, new Map(), { now: NOW, prefer: 'b' })?.account).toBe('b')
    expect(
      pickEligible([reading('a'), reading('b', { weeklyUsed: 99 })], new Map(), { now: NOW, prefer: 'b' })?.account,
    ).toBe('a')
  })

  test('a reading the poller has not renewed for ten minutes admits nothing', () => {
    const old = reading('a', { readAt: at(-READING_MAX_AGE_MS - 1) })
    expect(pickEligible([old], new Map(), { now: NOW })).toBeUndefined()
    expect(pickEligible([reading('a', { readAt: at(-READING_MAX_AGE_MS) })], new Map(), { now: NOW })?.account).toBe(
      'a',
    )
  })
})

describe('nextOpening: the first reset', () => {
  test('is the earliest time any fresh account opens', () => {
    const walled = [
      reading('a', { weeklyUsed: 96, weeklyResetsAt: at(30 * HOUR) }),
      reading('b', { fiveHourUsed: 90, fiveHourResetsAt: at(2 * HOUR) }),
      reading('c', { enabled: false }),
    ]
    expect(nextOpening(walled, { now: NOW })).toEqual(at(2 * HOUR))
  })

  test('is none when no reading names a time: a new reading wakes the spawn', () => {
    expect(
      nextOpening([reading('a', { authOk: false }), reading('b', { fiveHourUsed: 100, fiveHourResetsAt: at(-1) })], {
        now: NOW,
      }),
    ).toBeUndefined()
  })

  test('ignores stale readings', () => {
    const old = reading('a', { fiveHourUsed: 90, readAt: at(-HOUR) })
    expect(nextOpening([old], { now: NOW })).toBeUndefined()
  })
})
