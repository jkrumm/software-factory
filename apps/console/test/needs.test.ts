import { expect, test } from 'bun:test'
import {
  defaultWords,
  errorWords,
  issueNumber,
  originOf,
  reversibleWords,
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

test('the origin is the repo, or App feedback; reversibility is a phrase', () => {
  expect(originOf({ repo: 'argo' })).toBe('argo')
  expect(originOf({ repo: null })).toBe('App feedback')
  expect(reversibleWords(true)).toBe('reversible')
  expect(reversibleWords(false)).toBe('not reversible')
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
