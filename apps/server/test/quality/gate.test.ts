import { expect, test } from 'bun:test'
import {
  type CiLine,
  type CommitRead,
  ciStateOf,
  parseAcceptance,
  type ReviewRead,
} from '../../src/domains/quality/evidence.ts'
import { judgeShip } from '../../src/domains/quality/gate.ts'
import { err, ok, portError } from '../../src/kernel/result.ts'

const read: CommitRead = {
  landedAt: 'f'.repeat(40),
  commits: ['a'.repeat(40)],
  paths: ['docs/a.md', 'src/a.ts'],
  mergedAt: new Date('2026-01-01T12:00:00Z'),
  reviewRanges: [{ base: 'b'.repeat(40), head: 'a'.repeat(40) }],
}
const none = { read: null, problem: null }
const covered: ReviewRead = { tier: 'standard', covered: true, uncovered: [] }

test('a ship that names no commit is refused with its error named', () => {
  const verdict = judgeShip({ reported: [], commits: ok(read), review: none, ci: none, acceptance: { statements: [] } })
  expect(verdict).toEqual({ accepted: false, error: 'ship refused: ship names no merged commit' })
})

test('commits git refuses are refused with git’s reason; a git that fails is said so', () => {
  const refused = judgeShip({
    reported: ['abc'],
    commits: err(portError('refused', 'commit abc is not on origin/master: merge it first')),
    review: none,
    ci: none,
    acceptance: { statements: [] },
  })
  expect(refused).toEqual({
    accepted: false,
    error: 'ship refused: commit abc is not on origin/master: merge it first',
  })
  const failed = judgeShip({
    reported: ['abc'],
    commits: err(portError('timeout', 'git fetch did not finish')),
    review: none,
    ci: none,
    acceptance: { statements: [] },
  })
  expect(failed).toEqual({
    accepted: false,
    error: 'ship refused: the commits could not be read: git fetch did not finish',
  })
})

test('merged commits are evidence: what landed, what it touched, whether it deploys', () => {
  const verdict = judgeShip({
    reported: ['abc'],
    commits: ok(read),
    review: { read: covered, problem: null },
    ci: none,
    acceptance: { statements: [] },
  })
  expect(verdict).toMatchObject({
    accepted: true,
    commits: { commits: read.commits, landedAt: read.landedAt, mergedAt: '2026-01-01T12:00:00.000Z', deploys: true },
    review: { status: 'covered', tier: 'standard', reason: null },
  })
})

test('a review is evidence when it exists; its absence is recorded with the reason and never refuses (NL23)', () => {
  const absent = [
    { read: null, problem: 'review could not be read: agw review covered exited 1' },
    { read: null, problem: null },
    {
      read: {
        tier: 'standard',
        covered: false,
        uncovered: [{ sha: 'a'.repeat(40), subject: 'feat: x', required: 'standard' }],
      },
      problem: null,
    },
  ]
  const statuses = absent.map((review) => {
    const verdict = judgeShip({
      reported: ['abc'],
      commits: ok(read),
      review,
      ci: none,
      acceptance: { statements: [] },
    })
    if (!verdict.accepted) throw new Error('a missing review must not refuse')
    return [verdict.review.status, verdict.review.reason]
  })
  expect(statuses).toEqual([
    ['unknown', 'review could not be read: agw review covered exited 1'],
    ['unknown', 'no review was asked: none of the commits is on the default branch to review'],
    ['uncovered', expect.stringContaining('aaaaaaaaaaaa feat: x (needs standard)')],
  ])
})

test('a change that needs no review is a review that exists', () => {
  const verdict = judgeShip({
    reported: ['abc'],
    commits: ok({ ...read, paths: ['docs/a.md'] }),
    review: { read: { tier: 'none', covered: true, uncovered: [] }, problem: null },
    ci: none,
    acceptance: { statements: [] },
  })
  expect(verdict).toMatchObject({ accepted: true, commits: { deploys: false }, review: { status: 'not_required' } })
})

test('the lead’s acceptance lines are parsed: met, or not met with why; anything else is named', () => {
  expect(parseAcceptance(['met: the page shows it', 'NOT MET: no time', 'not_met:  later'])).toEqual({
    ok: true,
    evidence: {
      statements: [
        { status: 'met', text: 'the page shows it' },
        { status: 'not_met', text: 'no time' },
        { status: 'not_met', text: 'later' },
      ],
    },
  })
  expect(parseAcceptance([])).toEqual({ ok: true, evidence: { statements: [] } })
  for (const line of ['done', 'met:', 'unmet: x']) {
    expect(parseAcceptance([line])).toMatchObject({ ok: false, error: expect.stringContaining('must read "met:') })
  }
})

test('the ship records the pull request CI, and a CI that could not be read is `unknown`, never a refusal (NL23)', () => {
  const green = {
    status: 'green' as const,
    pr: 7,
    headSha: 'c'.repeat(40),
    url: 'https://example.com/pr/7',
    reason: null,
  }
  const seen = judgeShip({
    reported: ['abc'],
    commits: ok(read),
    review: none,
    ci: { read: green, problem: null },
    acceptance: { statements: [] },
  })
  expect(seen).toMatchObject({ accepted: true, ci: green })
  const unread = judgeShip({
    reported: ['abc'],
    commits: ok(read),
    review: none,
    ci: { read: null, problem: 'CI could not be read: no token' },
    acceptance: { statements: [] },
  })
  expect(unread).toMatchObject({
    accepted: true,
    ci: { status: 'unknown', pr: null, headSha: null, url: null, reason: 'CI could not be read: no token' },
  })
})

const line = (name: string, status: string, conclusion: string | null, url: string | null = null): CiLine => ({
  name,
  status,
  conclusion,
  url,
})

test('CI is red with any failure, running with any unfinished check, green with a success and nothing else', () => {
  expect(ciStateOf([line('a', 'completed', 'success'), line('b', 'completed', 'failure', 'https://x/b')])).toEqual({
    status: 'red',
    url: 'https://x/b',
    reason: 'b failure',
  })
  // a failure beats a run still going
  expect(ciStateOf([line('a', 'in_progress', null), line('b', 'completed', 'timed_out')]).status).toBe('red')
  expect(ciStateOf([line('a', 'completed', 'success'), line('b', 'queued', null)])).toMatchObject({
    status: 'running',
    reason: 'b is still running',
  })
  expect(ciStateOf([line('a', 'completed', 'success'), line('b', 'completed', 'skipped')]).status).toBe('green')
})

test('no check, or none that concluded, is missing: a cancelled run alone proves nothing', () => {
  expect(ciStateOf([])).toEqual({ status: 'missing', url: null, reason: 'no check ran' })
  expect(ciStateOf([line('a', 'completed', 'cancelled')]).status).toBe('missing')
})
