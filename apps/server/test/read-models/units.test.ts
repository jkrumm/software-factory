import { expect, test } from 'bun:test'
import type { StoredSignal } from '@software-factory/contract'
import { usageCache } from '../../src/read/kpis.ts'
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
  judge: null,
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
    dismissedReason: null,
    dismissedBy: null,
    screenNote: null,
    redacted: false,
  })
  const out = redactSignals([signal('owner'), signal('agent'), signal('outside'), signal('machine')])
  expect(out.map((s) => [s.trust, s.title, s.text, s.link, s.repo, s.redacted])).toEqual(
    ['owner', 'agent', 'outside', 'machine'].map((trust) => [trust, REDACTED_TITLE, '', null, null, true]),
  )
  expect(out.map((s) => s.id)).toEqual(['signal_owner', 'signal_agent', 'signal_outside', 'signal_machine'])
})

test('usageCache: one slow read at a time, a stale reading served at once and refreshed behind, an unreadable schema never kept', async () => {
  let clock = 0
  const cache = usageCache({ ttlMs: 1000, clock: () => clock })
  let calls = 0
  let release: (() => void) | undefined
  const slow = (cost: number | null) => async () => {
    calls++
    await new Promise<void>((resolve) => (release = resolve))
    return { cost, points: 1 }
  }

  // concurrent first reads share one computation
  const first = [cache.read(7, slow(10)), cache.read(7, slow(99))]
  release?.()
  expect(await Promise.all(first)).toEqual([
    { cost: 10, points: 1 },
    { cost: 10, points: 1 },
  ])
  expect(calls).toBe(1)

  // fresh: served without computing
  expect(await cache.read(7, slow(11))).toEqual({ cost: 10, points: 1 })
  expect(calls).toBe(1)

  // stale: the old reading answers now, the refresh runs behind it
  clock = 1000
  expect(await cache.read(7, slow(11))).toEqual({ cost: 10, points: 1 })
  expect(calls).toBe(2)
  release?.()
  await Bun.sleep(0)
  expect(await cache.read(7, slow(12))).toEqual({ cost: 11, points: 1 })

  // another window length is its own reading, and a reading with no cost is not kept
  const other = cache.read(1, slow(null))
  release?.()
  expect(await other).toEqual({ cost: null, points: 1 })
  const retry = cache.read(1, slow(5))
  release?.()
  expect(await retry).toEqual({ cost: 5, points: 1 })
})
