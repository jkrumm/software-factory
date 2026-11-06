/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { describe, expect, test } from 'bun:test'
import { EvidenceKind } from '@software-factory/contract'
import { EXIT_TIMEOUT } from '../src/exec.ts'
import { AgwReview, ReviewFailed } from '../src/issues/review.ts'

const ok = (stdout: unknown, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(stdout) })
const sha = (c: string) => c.repeat(40)

const adapter = (answers: Record<string, { exitCode: number; stdout: string }>) => {
  const calls: string[][] = []
  const review = new AgwReview({
    bin: 'agw',
    run: async (cmd) => {
      calls.push(cmd)
      return answers[cmd[2] ?? ''] ?? { exitCode: 1, stdout: '' }
    },
  })
  return { review, calls }
}

describe('AgwReview', () => {
  test('asks route and covered over the same range and names the uncovered commits with their tiers', async () => {
    const { review, calls } = adapter({
      route: ok({ tier: 'deep', files: 3 }),
      covered: ok({
        covered: false,
        commits: [
          { sha: sha('a'), subject: 's1', required: 'deep', rule: 'r', coveredBy: null },
          { sha: sha('b'), subject: 's2', required: 'light', rule: 'r', coveredBy: 'rv_x', reason: 'open-important' },
        ],
        uncovered: [sha('a'), sha('b')],
      }),
    })
    const read = await review.read({ repo: '/r', base: sha('1'), head: sha('2') })
    expect(read).toEqual({
      tier: 'deep',
      covered: false,
      uncovered: [
        { sha: sha('a'), subject: 's1', required: 'deep' },
        { sha: sha('b'), subject: 's2', required: 'light', reason: 'open-important' },
      ],
    })
    expect(calls.map((c) => c.slice(1, 3))).toEqual([
      ['review', 'route'],
      ['review', 'covered'],
    ])
    expect(calls[1]).toContain(`${sha('1')}..${sha('2')}`)
  })

  test('a failing, silent or odd agw throws', async () => {
    const covered = ok({ covered: true, commits: [], uncovered: [] })
    await expect(
      adapter({ route: ok({}, 2), covered }).review.read({ repo: '/r', base: 'a', head: 'b' }),
    ).rejects.toThrow(ReviewFailed)
    await expect(
      adapter({ route: { exitCode: 0, stdout: 'nope' }, covered }).review.read({ repo: '/r', base: 'a', head: 'b' }),
    ).rejects.toThrow('printed no JSON')
    await expect(
      adapter({ route: ok({ tier: 'huge' }), covered }).review.read({ repo: '/r', base: 'a', head: 'b' }),
    ).rejects.toThrow('unexpected')
  })

  test('a slow covered read on a long range is waited for under a limit of minutes, not refused', async () => {
    const limits: Record<string, number> = {}
    const started: string[] = []
    const review = new AgwReview({
      bin: 'agw',
      run: async (cmd, timeoutMs) => {
        limits[cmd[2] ?? ''] = timeoutMs
        started.push(cmd[2] ?? '')
        if (cmd[2] === 'covered') await new Promise((resolve) => setTimeout(resolve, 50))
        return cmd[2] === 'route' ? ok({ tier: 'light' }) : ok({ covered: true, commits: [], uncovered: [] })
      },
    })
    const pending = review.read({ repo: '/r', base: 'a', head: 'b' })
    // both reads are in flight before either answered: the two limits do not add up
    expect(started).toEqual(['route', 'covered'])
    expect(await pending).toEqual({ tier: 'light', covered: true, uncovered: [] })
    expect(limits.covered).toBeGreaterThanOrEqual(120_000)
    expect(limits.route).toBeGreaterThanOrEqual(120_000)
  })

  test('a covered read that outlasts its limit is a refusal, never a pass', async () => {
    const review = new AgwReview({
      bin: 'agw',
      run: async (cmd) => (cmd[2] === 'route' ? ok({ tier: 'light' }) : { exitCode: EXIT_TIMEOUT, stdout: '' }),
    })
    await expect(review.read({ repo: '/r', base: 'a', head: 'b' })).rejects.toThrow('did not answer in time')
  })
})

test('review is an evidence kind', () => {
  expect(EvidenceKind.parse('review')).toBe('review')
})
