import { expect, test } from 'bun:test'
import {
  CLASS_WINDOW,
  classOf,
  HOLD_MS,
  mayFile,
  MIN_DECIDED,
  verdictOf,
  type ClassIssue,
  type ClassOutcome,
} from '../../src/domains/loops/classes.ts'

const DAY = 86_400_000
const t0 = new Date('2026-10-01T00:00:00Z').getTime()
const at = (days: number) => new Date(t0 + days * DAY)

/** an Issue filed `filed` days in and closed `closed` days in (null: open) */
const issue = (
  n: number,
  outcome: ClassOutcome | null,
  closed: number | null,
  filed = closed === null ? 0 : closed - 1,
): ClassIssue => ({
  issue: `issue_${n}`,
  filedAt: at(filed),
  closedAt: closed === null ? null : at(closed),
  outcome,
})

/** `pattern` is one letter per Issue closed a day apart: d done, h healed, x dropped, c cancelled */
const history = (pattern: string): ClassIssue[] =>
  [...pattern].map((ch, i) =>
    issue(i + 1, { d: 'done', h: 'healed', x: 'dropped', c: 'cancelled' }[ch] as ClassOutcome, i + 1),
  )

const lastClose = (pattern: string) => at(pattern.length)

test('classOf: a judgment is classed by its kind, any other key by its first segment', () => {
  expect(classOf('hygiene', 'judgment:stale:docs/x.md')).toBe('judgment:stale')
  expect(classOf('hygiene', 'cochange:a|b')).toBe('cochange')
  expect(classOf('hygiene', 'links:docs/x.md')).toBe('links')
  expect(classOf('hygiene', 'check')).toBe('check')
  expect(classOf('friction', 'touch:woken')).toBe('touch')
  expect(classOf('friction', 'refusal:noted:why')).toBe('refusal')
  expect(classOf('friction', 'lead_gone')).toBe('lead_gone')
  expect(classOf('friction', 'judgment:x')).toBe('judgment')
})

test('fewer than MIN_DECIDED decided Issues are never held', () => {
  const verdict = verdictOf(history('x'.repeat(MIN_DECIDED - 1)), at(MIN_DECIDED))
  expect(verdict).toMatchObject({ status: 'open', decided: MIN_DECIDED - 1, heldUntil: null })
})

test('4 of 5 noise is held until HOLD_MS after the last close, then on probation', () => {
  const verdict = verdictOf(history('xxxdx'), at(6))
  expect(verdict).toMatchObject({ status: 'held', decided: 5, noise: 4, share: 0.8 })
  expect(verdict.heldUntil).toEqual(new Date(lastClose('xxxdx').getTime() + HOLD_MS))
  expect(mayFile(verdict, false)).toBe(false)
  expect(verdictOf(history('xxxdx'), new Date(lastClose('xxxdx').getTime() + HOLD_MS)).status).toBe('probation')
})

test('exactly half noise is not held; healed and done are not noise; open Issues are not decided', () => {
  expect(verdictOf(history('xhxh'), at(5)).status).toBe('open')
  expect(verdictOf(history('hhhh'), at(5))).toMatchObject({ noise: 0, share: 0 })
  const withOpen = [...history('xxd'), issue(9, null, null)]
  expect(verdictOf(withOpen, at(5))).toMatchObject({ decided: 3, open: 1, status: 'held' })
})

test('only the newest CLASS_WINDOW decided Issues count', () => {
  const old = 'x'.repeat(8)
  const recent = 'd'.repeat(CLASS_WINDOW)
  expect(verdictOf(history(old + recent), at(30))).toMatchObject({ status: 'open', decided: CLASS_WINDOW, noise: 0 })
})

const later = (pattern: string) => new Date(lastClose(pattern).getTime() + HOLD_MS + DAY)

test('probation: one open Issue, or one filed this pass, blocks another', () => {
  const base = history('xxxx')
  const now = later('xxxx')
  const verdict = verdictOf(base, now)
  expect(verdict.status).toBe('probation')
  expect(mayFile(verdict, false)).toBe(true)
  expect(mayFile(verdict, true)).toBe(false)
  const withOpen = verdictOf([...base, issue(9, null, null)], now)
  expect(withOpen).toMatchObject({ status: 'probation', open: 1 })
  expect(mayFile(withOpen, false)).toBe(false)
})

test('a probation Issue that closes done restarts the window; one that is dropped holds the class again', () => {
  const base = history('xxxx')
  const filedAfterHold = lastClose('xxxx').getTime() + HOLD_MS + DAY
  const closeAt = filedAfterHold + 3 * DAY
  const probation = (outcome: ClassOutcome): ClassIssue => ({
    issue: 'issue_50',
    filedAt: new Date(filedAfterHold),
    closedAt: new Date(closeAt),
    outcome,
  })
  const done = verdictOf([...base, probation('done')], new Date(closeAt + DAY))
  expect(done).toMatchObject({ status: 'open', decided: 1, noise: 0 })
  expect(mayFile(done, false)).toBe(true)

  const dropped = verdictOf([...base, probation('dropped')], new Date(closeAt + DAY))
  expect(dropped).toMatchObject({ status: 'held', decided: 5, noise: 5 })
  expect(dropped.heldUntil).toEqual(new Date(closeAt + HOLD_MS))
})

test('an Issue filed before the hold ended does not forgive the class when it closes done', () => {
  const early: ClassIssue = { issue: 'issue_50', filedAt: at(5), closedAt: at(6 + 3), outcome: 'done' }
  const verdict = verdictOf([...history('xxxx'), early], at(10))
  expect(verdict.status).toBe('held')
})
