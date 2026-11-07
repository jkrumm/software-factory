import { expect, test } from 'bun:test'
import type { CommitRead, ReviewRead } from '../../src/domains/quality/evidence.ts'
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
  const verdict = judgeShip({ reported: [], commits: ok(read), review: none })
  expect(verdict).toEqual({ accepted: false, error: 'ship refused: ship names no merged commit' })
})

test('commits git refuses are refused with git’s reason; a git that fails is said so', () => {
  const refused = judgeShip({
    reported: ['abc'],
    commits: err(portError('refused', 'commit abc is not on origin/master: merge it first')),
    review: none,
  })
  expect(refused).toEqual({
    accepted: false,
    error: 'ship refused: commit abc is not on origin/master: merge it first',
  })
  const failed = judgeShip({
    reported: ['abc'],
    commits: err(portError('timeout', 'git fetch did not finish')),
    review: none,
  })
  expect(failed).toEqual({
    accepted: false,
    error: 'ship refused: the commits could not be read: git fetch did not finish',
  })
})

test('merged commits are evidence: what landed, what it touched, whether it deploys', () => {
  const verdict = judgeShip({ reported: ['abc'], commits: ok(read), review: { read: covered, problem: null } })
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
    const verdict = judgeShip({ reported: ['abc'], commits: ok(read), review })
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
  })
  expect(verdict).toMatchObject({ accepted: true, commits: { deploys: false }, review: { status: 'not_required' } })
})
