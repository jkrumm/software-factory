import { expect, test } from 'bun:test'
import {
  FINDER_WINDOW,
  finderOf,
  MUTE_MS,
  mayFile,
  MIN_DECIDED,
  verdictOf,
  type FinderIssue,
  type FinderOutcome,
} from '../../src/domains/improve/finders.ts'

const DAY = 86_400_000
const t0 = new Date('2026-10-01T00:00:00Z').getTime()
const at = (days: number) => new Date(t0 + days * DAY)

/** an Issue filed `filed` days in and closed `closed` days in (null: open) */
const issue = (
  n: number,
  outcome: FinderOutcome | null,
  closed: number | null,
  filed = closed === null ? 0 : closed - 1,
): FinderIssue => ({
  issue: `issue_${n}`,
  filedAt: at(filed),
  closedAt: closed === null ? null : at(closed),
  outcome,
})

/** `pattern` is one letter per Issue closed a day apart: d done, h healed, x dropped, c cancelled */
const history = (pattern: string): FinderIssue[] =>
  [...pattern].map((ch, i) =>
    issue(i + 1, { d: 'done', h: 'healed', x: 'dropped', c: 'cancelled' }[ch] as FinderOutcome, i + 1),
  )

const lastClose = (pattern: string) => at(pattern.length)

test('finderOf: a judgment belongs to the finder of its kind, any other key by its first segment', () => {
  expect(finderOf('hygiene', 'judgment:stale:docs/x.md')).toBe('judgment:stale')
  expect(finderOf('hygiene', 'cochange:a|b')).toBe('cochange')
  expect(finderOf('hygiene', 'runrules:no-memory-limit:deploy/compose.yml')).toBe('runrules')
  expect(finderOf('hygiene', 'links:docs/x.md')).toBe('links')
  expect(finderOf('hygiene', 'check')).toBe('check')
  expect(finderOf('friction', 'touch:woken')).toBe('touch')
  expect(finderOf('friction', 'refusal:closed')).toBe('refusal')
  expect(finderOf('friction', 'lead_gone')).toBe('lead_gone')
  expect(finderOf('friction', 'judgment:x')).toBe('judgment')
})

test('fewer than MIN_DECIDED decided Issues are never muted', () => {
  const verdict = verdictOf(history('x'.repeat(MIN_DECIDED - 1)), at(MIN_DECIDED))
  expect(verdict).toMatchObject({ status: 'open', decided: MIN_DECIDED - 1, mutedUntil: null })
})

test('4 of 5 noise is muted until MUTE_MS after the last close, then on probation', () => {
  const verdict = verdictOf(history('xxxdx'), at(6))
  expect(verdict).toMatchObject({ status: 'muted', decided: 5, noise: 4, share: 0.8 })
  expect(verdict.mutedUntil).toEqual(new Date(lastClose('xxxdx').getTime() + MUTE_MS))
  expect(mayFile(verdict, false)).toBe(false)
  expect(verdictOf(history('xxxdx'), new Date(lastClose('xxxdx').getTime() + MUTE_MS)).status).toBe('probation')
})

test('exactly half noise is not muted; healed and done are not noise; open Issues are not decided', () => {
  expect(verdictOf(history('xhxh'), at(5)).status).toBe('open')
  expect(verdictOf(history('hhhh'), at(5))).toMatchObject({ noise: 0, share: 0 })
  const withOpen = [...history('xxd'), issue(9, null, null)]
  expect(verdictOf(withOpen, at(5))).toMatchObject({ decided: 3, open: 1, status: 'muted' })
})

test('only the newest FINDER_WINDOW decided Issues count', () => {
  const old = 'x'.repeat(8)
  const recent = 'd'.repeat(FINDER_WINDOW)
  expect(verdictOf(history(old + recent), at(30))).toMatchObject({ status: 'open', decided: FINDER_WINDOW, noise: 0 })
})

const later = (pattern: string) => new Date(lastClose(pattern).getTime() + MUTE_MS + DAY)

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

test('a probation Issue that closes done restarts the window; one that is dropped mutes the finder again', () => {
  const base = history('xxxx')
  const filedAfterMute = lastClose('xxxx').getTime() + MUTE_MS + DAY
  const closeAt = filedAfterMute + 3 * DAY
  const probation = (outcome: FinderOutcome): FinderIssue => ({
    issue: 'issue_50',
    filedAt: new Date(filedAfterMute),
    closedAt: new Date(closeAt),
    outcome,
  })
  const done = verdictOf([...base, probation('done')], new Date(closeAt + DAY))
  expect(done).toMatchObject({ status: 'open', decided: 1, noise: 0 })
  expect(mayFile(done, false)).toBe(true)

  const dropped = verdictOf([...base, probation('dropped')], new Date(closeAt + DAY))
  expect(dropped).toMatchObject({ status: 'muted', decided: 5, noise: 5 })
  expect(dropped.mutedUntil).toEqual(new Date(closeAt + MUTE_MS))
})

test('an Issue filed before the mute ended does not forgive the finder when it closes done', () => {
  const early: FinderIssue = { issue: 'issue_50', filedAt: at(5), closedAt: at(6 + 3), outcome: 'done' }
  const verdict = verdictOf([...history('xxxx'), early], at(10))
  expect(verdict.status).toBe('muted')
})
