import { expect, test } from 'bun:test'
import {
  attemptOf,
  askStatusWords,
  countWords,
  deliveryWords,
  settledByWords,
  standingWords,
  verdictWords,
  watchWords,
} from '../src/lib/issue.ts'

const NOW = Date.parse('2026-01-01T10:00:00Z')

test('a note says where it stands', () => {
  expect(deliveryWords(true)).toBe('Delivered to the lead')
  expect(deliveryWords(false)).toBe('Sent, not confirmed yet')
  expect(deliveryWords(null)).toBe('In the next brief')
})

test('a watch says running, or its answer with the window', () => {
  const started = '2026-01-01T09:00:00Z'
  expect(watchWords({ startedAt: started, windowMs: 60_000, answer: null, answeredAt: null }, NOW)).toBe(
    'Running, window of 1 minute',
  )
  expect(
    watchWords({ startedAt: started, windowMs: 120_000, answer: 'passed', answeredAt: '2026-01-01T09:30:00Z' }, NOW),
  ).toBe('Passed 30 min ago, window of 2 minutes')
})

test('verdicts, statuses and settlers have plain words, and an unknown one is not lost', () => {
  expect(verdictWords('looks_good')).toBe('Looks good')
  expect(verdictWords(null)).toBe('No verdict yet')
  expect(verdictWords('something_new')).toBe('something new')
  expect(askStatusWords('withdrawn')).toBe('Withdrawn')
  expect(settledByWords('owner')).toBe('by you')
  expect(settledByWords(null)).toBe('')
})

test('an attempt is counted from the session list, and a key outside it has none', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }]
  expect(attemptOf(sessions, 'b')).toBe(2)
  expect(attemptOf(sessions, 'c')).toBeNull()
  expect(attemptOf(sessions, null)).toBeNull()
})

test('the standing line joins phase and wait', () => {
  expect(standingWords({ state: 'waiting', phase: 'waiting for your answer', reason: 'decision' })).toBe(
    'waiting for your answer · wait: decision',
  )
  expect(standingWords({ state: 'working', phase: null, reason: null })).toBe('')
  expect(countWords(12345)).toBe('12,345')
})
