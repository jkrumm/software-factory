import { describe, expect, test } from 'bun:test'
import { REVIEWER_CHEAP_ROLE, REVIEWER_ROLE, reviewerTripwire, type SeatEvidence } from '@software-factory/contract'
import { reviewerBrief, reviewerRoleFor, reviewSeat } from '../../src/domains/leads/reviewer.ts'

const rows = { cheap: { tier: 'haiku', effort: 'high' }, reviewer: { tier: 'sonnet', effort: 'medium' } } as const

describe('the assignment rule', () => {
  test('a light-seat lead gets the cheap row whatever its Issue number', () => {
    expect(reviewerRoleFor({ issueNumber: 2027, light: true, takesAll: false })).toBe(REVIEWER_CHEAP_ROLE)
    expect(reviewerRoleFor({ issueNumber: 2028, light: true, takesAll: false })).toBe(REVIEWER_CHEAP_ROLE)
  })

  test('the others split by Issue number parity: even gets the cheap row, odd the reviewer row', () => {
    expect(reviewerRoleFor({ issueNumber: 2028, light: false, takesAll: false })).toBe(REVIEWER_CHEAP_ROLE)
    expect(reviewerRoleFor({ issueNumber: 2027, light: false, takesAll: false })).toBe(REVIEWER_ROLE)
    const share =
      Array.from({ length: 1000 }, (_, i) =>
        reviewerRoleFor({ issueNumber: 1 + i, light: false, takesAll: false }),
      ).filter((role) => role === REVIEWER_CHEAP_ROLE).length / 1000
    expect(share).toBe(0.5)
  })

  test('once the tripwire hands over every review, every lead gets the cheap row', () => {
    expect(reviewerRoleFor({ issueNumber: 2027, light: false, takesAll: true })).toBe(REVIEWER_CHEAP_ROLE)
  })
})

describe('the seat a review ran on', () => {
  test('a non-deep review of a cheap Issue ran on the cheap row', () => {
    for (const tier of ['light', 'standard']) {
      expect(
        reviewSeat({ assigned: REVIEWER_CHEAP_ROLE, tier, routed: { model: 'sonnet', effort: 'medium' }, rows }),
      ).toEqual({ role: REVIEWER_CHEAP_ROLE, tier: 'haiku', effort: 'high' })
    }
  })

  test('a deep review stays on the reviewer row, at the seat agw routed it to', () => {
    expect(
      reviewSeat({ assigned: REVIEWER_CHEAP_ROLE, tier: 'deep', routed: { model: 'sonnet', effort: 'high' }, rows }),
    ).toEqual({ role: REVIEWER_ROLE, tier: 'sonnet', effort: 'high' })
  })

  test('a review of a reviewer-row Issue ran on agw’s seat; words that are not a tier fall back to the row', () => {
    expect(
      reviewSeat({ assigned: REVIEWER_ROLE, tier: 'standard', routed: { model: 'sonnet', effort: 'medium' }, rows }),
    ).toEqual({ role: REVIEWER_ROLE, tier: 'sonnet', effort: 'medium' })
    expect(
      reviewSeat({ assigned: REVIEWER_ROLE, tier: 'standard', routed: { model: 'claude-x-9', effort: 'x' }, rows }),
    ).toEqual({ role: REVIEWER_ROLE, tier: 'sonnet', effort: 'medium' })
    expect(reviewSeat({ assigned: REVIEWER_ROLE, tier: 'standard', routed: null, rows })).toEqual({
      role: REVIEWER_ROLE,
      tier: 'sonnet',
      effort: 'medium',
    })
  })
})

describe('the brief', () => {
  test('the cheap lead is told the tier and effort words, the other keeps agw’s seat; no model id is written', () => {
    const cheap = reviewerBrief(REVIEWER_CHEAP_ROLE, rows.cheap)
    expect(cheap).toContain('`model: haiku`')
    expect(cheap).toContain('`effort: high`')
    expect(cheap).toContain('At tier `deep` keep prepare')
    expect(cheap).not.toMatch(/claude-/)
    expect(reviewerBrief(REVIEWER_ROLE, rows.cheap)).not.toContain('haiku')
  })
})

const seat = (over: Partial<SeatEvidence> = {}): SeatEvidence => ({
  reviews: 120,
  issues: 100,
  passed: 90,
  regressed: 5,
  ...over,
})

describe('the tripwire', () => {
  test('up: with 100 reviews each, no more regressions and a first pass within 2 points, the cheap row takes all', () => {
    const verdict = reviewerTripwire({
      cheap: seat({ passed: 88, regressed: 5 }),
      plain: seat({ passed: 90, regressed: 5 }),
      window: seat({ issues: 12, passed: 11, regressed: 0 }),
    })
    expect(verdict).toMatchObject({ enough: true, passOk: true, regressOk: true, met: true, windowBreaks: false })
    expect(verdict.takesAll).toBe(true)
  })

  test('up needs every test: too few reviews, a pass rate 3 points under, or more regressions each keep the share', () => {
    const window = seat({ issues: 12, passed: 12, regressed: 0 })
    const plain = seat()
    expect(reviewerTripwire({ cheap: seat({ reviews: 99 }), plain, window }).takesAll).toBe(false)
    expect(reviewerTripwire({ cheap: seat(), plain: seat({ reviews: 99 }), window }).takesAll).toBe(false)
    const slower = reviewerTripwire({ cheap: seat({ passed: 87 }), plain, window })
    expect(slower).toMatchObject({ passOk: false, met: false, takesAll: false })
    const worse = reviewerTripwire({ cheap: seat({ regressed: 6 }), plain, window })
    expect(worse).toMatchObject({ regressOk: false, met: false, takesAll: false })
  })

  test('back: a 3-day window of the cheap row that breaks either test returns it to its starting share', () => {
    const cheap = seat({ passed: 90, regressed: 5 })
    const plain = seat()
    expect(reviewerTripwire({ cheap, plain, window: seat({ issues: 20, passed: 17, regressed: 1 }) })).toMatchObject({
      met: true,
      windowBreaks: true,
      takesAll: false,
    })
    expect(reviewerTripwire({ cheap, plain, window: seat({ issues: 20, passed: 19, regressed: 3 }) })).toMatchObject({
      met: true,
      windowBreaks: true,
      takesAll: false,
    })
  })

  test('a window with too few Issues cannot break it, and with no first watch nothing is met', () => {
    expect(
      reviewerTripwire({ cheap: seat(), plain: seat(), window: seat({ issues: 9, passed: 0, regressed: 9 }) }),
    ).toMatchObject({ windowBreaks: null, takesAll: true })
    expect(
      reviewerTripwire({
        cheap: seat({ issues: 0, passed: 0, regressed: 0 }),
        plain: seat(),
        window: seat({ issues: 0 }),
      }),
    ).toMatchObject({ passOk: null, regressOk: null, met: false, takesAll: false })
  })
})
