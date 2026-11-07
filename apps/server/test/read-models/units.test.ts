import { expect, test } from 'bun:test'
import type { StoredSignal } from '@software-factory/contract'
import { isWorkRepo, needsModel, REDACTED_SUMMARY, REDACTED_TITLE, type ScopedNeed } from '../../src/read/needs.ts'
import { redactSignals } from '../../src/read/signals.ts'
import { per, percentile, windowOf } from '../../src/read/stats.ts'
import { plain } from '../../src/read/words.ts'

/** The pure parts of the read models: percentiles, the window of days, plain words, the work-repo redaction. */

test('percentile: linear between ranks, null for none, one value is every percentile', () => {
  expect(percentile([], 0.5)).toBeNull()
  expect(percentile([7], 0.9)).toBe(7)
  expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5)
  expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3)
  expect(percentile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6)
  expect(percentile([1, 2, 3], 2)).toBe(3)
  expect(percentile([1, 2, 3], -1)).toBe(1)
})

test('windowOf ends at now and reaches back whole days; per is null for nothing to divide by', () => {
  const now = new Date('2026-11-07T12:00:00Z')
  const w = windowOf(now, 7)
  expect(w.to).toBe(now)
  expect(w.from.toISOString()).toBe('2026-10-31T12:00:00.000Z')
  expect(per(3, 0)).toBeNull()
  expect(per(3, 4)).toBe(0.75)
})

test('plain words: ids become nouns, whitespace folds, a long text is cut at a word', () => {
  expect(plain('Fix issue_286 after decision_01j9abc answers\n  and errand_3')).toBe(
    'Fix an Issue after a Decision answers and an Errand',
  )
  expect(plain('no ids here')).toBe('no ids here')
  const long = plain('word '.repeat(100), 40)
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long.endsWith('…')).toBe(true)
})

test('a work repo is one that no project with its own project.yaml owns; an unknown repo is work too', () => {
  const open = [{ name: 'app', repo: '/src/app' }]
  expect(isWorkRepo('app', open)).toBe(false)
  expect(isWorkRepo('/src/app', open)).toBe(false)
  expect(isWorkRepo('/src/app/.claude/worktrees/x', open)).toBe(false)
  expect(isWorkRepo('/src/app-two', open)).toBe(true)
  expect(isWorkRepo('work-app', open)).toBe(true)
  expect(isWorkRepo(null, open)).toBe(false)
})

const need = (id: string, work: boolean, kind: ScopedNeed['kind'] = 'decision'): ScopedNeed => ({
  kind,
  id,
  issue: 'issue_1',
  repo: work ? 'work-app' : 'app',
  title: `title of ${id}`,
  summary: `summary of ${id}`,
  since: '2026-11-07T10:00:00.000Z',
  ageMs: 7_200_000,
  stale: false,
  defaultAt: null,
  link: { type: 'decision', id },
  work,
})

test('needsModel under the read token: work-repo words are replaced, ids, kinds and times stay, counts are per kind', () => {
  const at = new Date('2026-11-07T12:00:00Z')
  const items = [need('a', true), need('b', false), need('c', true, 'errand')]
  const owner = needsModel({ at, items }, { redact: false })
  expect(owner.items.map((item) => item.title)).toEqual(['title of a', 'title of b', 'title of c'])
  expect(owner.items.every((item) => !item.redacted)).toBe(true)

  const read = needsModel({ at, items }, { redact: true })
  expect(read.items.map((item) => [item.id, item.title, item.redacted])).toEqual([
    ['a', REDACTED_TITLE, true],
    ['b', 'title of b', false],
    ['c', REDACTED_TITLE, true],
  ])
  expect(read.items[0]?.summary).toBe(REDACTED_SUMMARY)
  expect(read.items[0]).toMatchObject({
    id: 'a',
    issue: 'issue_1',
    repo: 'work-app',
    since: '2026-11-07T10:00:00.000Z',
  })
  expect(read.items[0]).not.toHaveProperty('work')
  expect(read.counts).toEqual({ decision: 2, review: 0, errand: 1, held_signal: 0 })
})

test('redactSignals keeps ids, kinds, times and states and drops every word, the owner’s signals too', () => {
  const signal = (trust: StoredSignal['trust']): StoredSignal => ({
    id: `signal_${trust}`,
    source: 'cli',
    kind: 'request',
    origin: 'you',
    trust,
    repo: 'app',
    title: 'a title',
    text: 'the text',
    link: 'https://example.com/x',
    receivedAt: '2026-11-07T10:00:00.000Z',
    state: 'filed',
    issue: null,
    redacted: false,
  })
  const out = redactSignals([signal('owner'), signal('agent'), signal('outside'), signal('machine')])
  expect(out.map((s) => [s.trust, s.title, s.text, s.link, s.repo, s.redacted])).toEqual(
    ['owner', 'agent', 'outside', 'machine'].map((trust) => [trust, REDACTED_TITLE, '', null, null, true]),
  )
  expect(out.map((s) => s.id)).toEqual(['signal_owner', 'signal_agent', 'signal_outside', 'signal_machine'])
})
