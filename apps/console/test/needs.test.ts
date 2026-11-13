import { describe, expect, test } from 'bun:test'
import type { NeedItem } from '@software-factory/contract'
import {
  deskGroups,
  decisionParts,
  needsTitle,
  needsNote,
  repeatsTitle,
  defaultLine,
  summaryLine,
  defaultWhen,
  defaultWords,
  errorWords,
  httpLink,
  issueNumber,
  kindCounts,
  metaParts,
  metaWords,
  optionIndex,
  originOf,
  projectCounts,
  projectOf,
  projectsOfNeeds,
  reversibleLozenge,
  visibleNeeds,
  spanWords,
  waitingWords,
} from '../src/lib/needs.ts'

const MIN = 60_000

test('spanWords and waitingWords name the wait in plain words', () => {
  expect(spanWords(10_000)).toBe('under a minute')
  expect(spanWords(MIN)).toBe('1 minute')
  expect(spanWords(5 * MIN)).toBe('5 minutes')
  expect(spanWords(2 * 60 * MIN + 30 * MIN)).toBe('2 hours')
  expect(spanWords(60 * MIN)).toBe('1 hour')
  expect(spanWords(3 * 24 * 60 * MIN)).toBe('3 days')
  expect(waitingWords(2 * 60 * MIN)).toBe('Waiting 2 hours')
})

test('defaultWords counts down to the default and says so once it is due', () => {
  const now = Date.parse('2026-01-01T10:00:00Z')
  expect(defaultWords('2026-01-01T10:40:00Z', now)).toBe('Default taken in 40 minutes')
  expect(defaultWords('2026-01-01T09:00:00Z', now)).toBe('Default taken at the next pass')
})

test('the origin is the repo, or App feedback; reversibility is a lozenge from an explicit map', () => {
  expect(originOf({ repo: 'argo' })).toBe('argo')
  expect(originOf({ repo: null })).toBe('App feedback')
  expect(projectOf({ repo: null })).toBe('App feedback')
  expect(reversibleLozenge(true)).toEqual({ state: 'done', words: 'Reversible' })
  expect(reversibleLozenge(false)).toEqual({ state: 'waiting', words: 'Not reversible' })
})

test('errorWords: 409 is settled elsewhere, no status is unreachable, the rest says what the API said', () => {
  expect(errorWords(409, 'already_answered')).toBe('Already settled elsewhere')
  expect(errorWords(null, null)).toBe('Could not reach the factory')
  expect(errorWords(422, 'a verdict needs: note')).toBe('a verdict needs: note')
  expect(errorWords(500, null)).toBe('The factory refused this')
})

test('issueNumber turns an Issue ref into the page parameter', () => {
  expect(issueNumber('issue_286')).toBe('286')
})

test('defaultWhen and metaWords phrase the timing per kind', () => {
  const now = Date.parse('2026-01-01T10:00:00Z')
  expect(defaultWhen('2026-01-01T10:40:00Z', now)).toBe('in 40 minutes')
  expect(defaultWhen('2026-01-01T09:00:00Z', now)).toBe('at the next pass')
  expect(metaWords({ kind: 'decision', ageMs: 2 * 60 * MIN })).toBe('Waiting 2 hours')
  expect(metaWords({ kind: 'errand', ageMs: 2 * 60 * MIN })).toBe('Raised 2 hours ago')
  expect(metaWords({ kind: 'held_signal', ageMs: 5 * MIN })).toBe('Received 5 minutes ago')
  expect(metaWords({ kind: 'long_wait', ageMs: 2 * 60 * MIN })).toBe('Held 2 hours')
})

test('metaParts splits the lead word from the age that metaWords joins', () => {
  expect(metaParts({ kind: 'decision', ageMs: 2 * 60 * MIN })).toEqual({ lead: 'Waiting', age: '2 hours' })
  expect(metaParts({ kind: 'errand', ageMs: 2 * 60 * MIN })).toEqual({ lead: 'Raised', age: '2 hours ago' })
  expect(metaParts({ kind: 'held_signal', ageMs: 5 * MIN })).toEqual({ lead: 'Received', age: '5 minutes ago' })
  expect(metaParts({ kind: 'long_wait', ageMs: 2 * 60 * MIN })).toEqual({ lead: 'Held', age: '2 hours' })
})

test('a recommendation names an option by its label, ignoring case and spaces, or it is a sentence of its own', () => {
  const options = [{ label: 'pino' }, { label: 'Winston' }]
  expect(optionIndex(options, ' Pino ')).toBe(0)
  expect(optionIndex(options, 'winston')).toBe(1)
  expect(optionIndex(options, 'Use pino, it is smaller')).toBe(-1)
  expect(optionIndex(options, '')).toBe(-1)
  expect(optionIndex(options, null)).toBe(-1)
})

test('the decision line names the project and, when known, the Issue', () => {
  expect(decisionParts('argo', 'Rotate keys')).toEqual({
    before: 'A decision for you from the lead of argo, Issue ',
    issue: 'Rotate keys',
    after: ': the lead hears your answer as a note and carries on',
  })
  expect(decisionParts('argo', null)).toEqual({
    before: 'A decision for you from the lead of argo',
    issue: null,
    after: ': the lead hears your answer as a note and carries on',
  })
})

test('only http and https links are external links', () => {
  expect(httpLink('https://github.com/a/b/issues/1')).toBe('https://github.com/a/b/issues/1')
  expect(httpLink('http://status.example.com/')).toBe('http://status.example.com/')
  expect(httpLink(['java', 'script:alert(1)'].join(''))).toBeNull()
  expect(httpLink('data:text/html,x')).toBeNull()
  expect(httpLink('not a url')).toBeNull()
  expect(httpLink(null)).toBeNull()
})

const need = (id: string, kind: NeedItem['kind'], repo: string | null): NeedItem =>
  ({ id, kind, repo }) as unknown as NeedItem

describe('filters', () => {
  const items = [
    need('d1', 'decision', 'argo'),
    need('d2', 'decision', 'harbor'),
    need('e1', 'errand', 'argo'),
    need('h1', 'held_signal', null),
  ]

  test('kind and project narrow the list; the deep-linked item stays', () => {
    expect(visibleNeeds(items, {}).map((i) => i.id)).toEqual(['d1', 'd2', 'e1', 'h1'])
    expect(visibleNeeds(items, { kind: 'decision' }).map((i) => i.id)).toEqual(['d1', 'd2'])
    expect(visibleNeeds(items, { project: 'argo' }).map((i) => i.id)).toEqual(['d1', 'e1'])
    expect(visibleNeeds(items, { kind: 'decision', project: 'argo' }).map((i) => i.id)).toEqual(['d1'])
    expect(visibleNeeds(items, { project: 'App feedback' }).map((i) => i.id)).toEqual(['h1'])
    expect(visibleNeeds(items, { kind: 'errand', project: 'harbor' }, 'd2').map((i) => i.id)).toEqual(['d2'])
    expect(visibleNeeds(items, { project: 'nowhere' })).toEqual([])
  })

  test('each count reflects the other filter only', () => {
    expect(kindCounts(items)).toEqual({ decision: 2, review: 0, errand: 1, held_signal: 1, long_wait: 0 })
    expect(kindCounts(items, 'argo')).toEqual({ decision: 1, review: 0, errand: 1, held_signal: 0, long_wait: 0 })
    expect(kindCounts([...items, need('w1', 'long_wait', 'argo')], 'argo').long_wait).toBe(1)
    expect(projectCounts(items)).toEqual({ argo: 2, harbor: 1, 'App feedback': 1 })
    expect(projectCounts(items, 'decision')).toEqual({ argo: 1, harbor: 1 })
  })

  test('the projects are sorted, and a filtered project that has no item is still listed', () => {
    expect(projectsOfNeeds(items)).toEqual(['App feedback', 'argo', 'harbor'])
    expect(projectsOfNeeds(items, 'beacon')).toEqual(['App feedback', 'argo', 'beacon', 'harbor'])
  })
})

test('the default line leads with the time', () => {
  const now = Date.parse('2026-01-01T10:00:00Z')
  expect(defaultLine('The lead waits.', '2026-01-01T17:00:00Z', now)).toBe(
    'In 7 hours, if nobody answers: The lead waits.',
  )
  expect(defaultLine('The lead waits.', '2026-01-01T09:00:00Z', now)).toBe(
    'At the next pass, if nobody answers: The lead waits.',
  )
})

test('a summary that repeats the title or the Issue title is not shown again', () => {
  const item = { title: 'The queue spec', summary: 'the queue spec ' }
  expect(summaryLine(item, null)).toBeNull()
  expect(summaryLine({ title: 'Q', summary: 'Rotate keys' }, 'Rotate keys')).toBeNull()
  expect(summaryLine({ title: 'Q', summary: 'Rotate keys' }, 'Other')).toBe('Rotate keys')
  expect(summaryLine({ title: 'Q', summary: '' }, null)).toBeNull()
})

test('the page note says how many need the owner, or how many the filters show', () => {
  expect(needsNote(10, 10, false)).toBe('10 need you')
  expect(needsNote(1, 10, true)).toBe('Showing 1 of 10')
})

test('a question that is the card title is not repeated', () => {
  expect(repeatsTitle('Which logging library?', 'Which logging library?')).toBe(true)
  expect(
    repeatsTitle(
      'Which logging library should argo use for the audit trail',
      'Which logging library should argo use\u2026',
    ),
  ).toBe(true)
  expect(repeatsTitle('Which cache store?', 'Which logging library?')).toBe(false)
  expect(repeatsTitle('anything', '')).toBe(false)
})

test('an age is one phrase', () => {
  expect(metaWords({ kind: 'held_signal', ageMs: 5_000 })).toBe('Received just now')
  expect(metaWords({ kind: 'errand', ageMs: 5_000 })).toBe('Raised just now')
})

describe('Back at desk', () => {
  const errand = (id: string, host: NeedItem['host'], ageMs: number): NeedItem =>
    ({ id, kind: 'errand', repo: null, source: 'ask-human', host, ageMs }) as unknown as NeedItem

  test('the Errands are grouped by where the hands must be, the oldest first, and the other kinds are left out', () => {
    const items = [
      errand('e1', 'iphone', 5),
      errand('e2', 'macbook', 10),
      errand('e3', 'macbook', 30),
      errand('e4', null, 1),
      need('d1', 'decision', 'argo'),
    ]
    expect(deskGroups(items).map((g) => [g.host, g.label, g.items.map((i) => i.id)])).toEqual([
      ['macbook', 'On the MacBook', ['e3', 'e2']],
      ['iphone', 'On the iPhone', ['e1']],
      ['any', 'Anywhere', ['e4']],
    ])
    expect(deskGroups([need('d1', 'decision', 'argo')])).toEqual([])
  })

  test('the tab title carries the count, and a request with no repo is a Request, not App feedback', () => {
    expect(needsTitle(3, true)).toBe('(3) Back at desk \u00b7 Software Factory')
    expect(needsTitle(0, false)).toBe('Needs you \u00b7 Software Factory')
    expect(originOf({ repo: null, kind: 'errand', source: 'ask-human' })).toBe('Requests')
    expect(originOf({ repo: null, kind: 'held_signal', source: 'GitHub' })).toBe('App feedback')
  })
})
