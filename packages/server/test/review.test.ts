/* oxlint-disable typescript/await-thenable -- bun types the `rejects` matchers as void; they return a promise */
import { describe, expect, test } from 'bun:test'
import { EvidenceKind } from '@software-factory/contract'
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
    await expect(adapter({ route: ok({}, 2) }).review.read({ repo: '/r', base: 'a', head: 'b' })).rejects.toThrow(
      ReviewFailed,
    )
    await expect(
      adapter({ route: { exitCode: 0, stdout: 'nope' } }).review.read({ repo: '/r', base: 'a', head: 'b' }),
    ).rejects.toThrow('printed no JSON')
    await expect(
      adapter({ route: ok({ tier: 'huge' }) }).review.read({ repo: '/r', base: 'a', head: 'b' }),
    ).rejects.toThrow('unexpected')
  })
})

test('review is an evidence kind', () => {
  expect(EvidenceKind.parse('review')).toBe('review')
})
