import { describe, expect, test } from 'bun:test'
import { prReview } from '../../src/adapters/reviews/pr.ts'
import { screenByReview } from '../../src/domains/checkpoints/errand.ts'
import { deskDue, nextPush } from '../../src/domains/checkpoints/desk.ts'
import type { ErrandRecord } from '../../src/domains/checkpoints/ports.ts'
import { wakeReason } from '../../src/domains/loops/reviews.ts'
import type { Run } from '../../src/adapters/quality/process.ts'

describe('the review screen', () => {
  const screen = (summary: string, detail: string | null = null) => screenByReview({ summary, detail })

  test('an Errand that asks the owner to approve or merge a named pull request names its review', () => {
    expect(screen('Approve and merge PR #91')?.review).toBe('#91')
    expect(screen('Merge', "the owner's approval or admin squash merge is needed on pull request 12")?.review).toBe(
      '#12',
    )
    expect(screen('Bypass the review rule', 'https://github.example/o/r/pull/7 needs it')?.review).toBe(
      'https://github.example/o/r/pull/7',
    )
    expect(screen('Approve', 'https://git.example/g/r/-/merge_requests/3')?.review).toBe(
      'https://git.example/g/r/-/merge_requests/3',
    )
    expect(screen('Approve and merge PR #91')?.reason).toContain('waits on the review of #91')
  })

  test('anything else is left to the screen', () => {
    expect(screen('Approve the App Store build')).toBeNull()
    expect(screen('Open PR #91 in the browser and read it')).toBeNull()
    expect(screen('Merge the feature branch by hand')).toBeNull()
  })
})

describe('what wakes a review wait', () => {
  const open = { state: 'open', decision: 'review_required', others: 2 } as const
  test('a merge, a close, an approval, a request for changes and a comment after the first look', () => {
    expect(wakeReason(open, 2)).toBeNull()
    expect(wakeReason({ ...open, others: 3 }, 2)).toBe('a reviewer commented')
    expect(wakeReason({ ...open, decision: 'approved' }, 2)).toBe('the pull request was approved')
    expect(wakeReason({ ...open, decision: 'changes_requested' }, 2)).toBe('a reviewer requested changes')
    expect(wakeReason({ ...open, state: 'merged' }, 2)).toBe('the pull request was merged')
    expect(wakeReason({ ...open, state: 'closed' }, 2)).toBe('the pull request was closed without merging')
  })
})

describe('the review adapter', () => {
  const answer =
    (stdout: string, calls: string[][] = []): Run =>
    (cmd) => {
      calls.push(cmd)
      return Promise.resolve({ exitCode: 0, stdout })
    }

  test('gh in the checkout, with the work account only for a work repo; reviews by the author do not count', async () => {
    const calls: string[][] = []
    const seen: (Record<string, string> | undefined)[] = []
    const run: Run = (cmd, _timeout, options) => {
      calls.push(cmd)
      seen.push(options?.env)
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          state: 'OPEN',
          reviewDecision: '',
          author: { login: 'me' },
          reviews: [
            { author: { login: 'me' }, state: 'COMMENTED' },
            { author: { login: 'them' }, state: 'APPROVED' },
          ],
          comments: [{ author: { login: 'me' } }],
        }),
      })
    }
    const port = prReview({ run, workGhConfigDir: '/cfg/gh-work' })
    const look = await port.look({ cwd: '/w/repo', ref: '#91', work: true })
    // no review rule: the approving review decides
    expect(look).toEqual({ ok: true, value: { state: 'open', decision: 'approved', others: 1 } })
    expect(calls.some((cmd) => cmd.includes('gh') && cmd.includes('91'))).toBe(true)
    expect(seen.at(-1)?.GH_CONFIG_DIR).toBe('/cfg/gh-work')
    await port.look({ cwd: '/w/repo', ref: '#91', work: false })
    expect(seen.at(-1)?.GH_CONFIG_DIR).toBeUndefined()
  })

  test('a merge request URL goes to glab', async () => {
    const calls: string[][] = []
    const port = prReview({
      run: answer(JSON.stringify({ state: 'merged', author: { username: 'me' }, user_notes_count: 4 }), calls),
    })
    const look = await port.look({ cwd: null, ref: 'https://git.example/g/r/-/merge_requests/3', work: true })
    expect(look).toEqual({ ok: true, value: { state: 'merged', decision: 'none', others: 4 } })
    expect(calls[0]).toContain('glab')
  })

  test('a failing tool, a bad body and a bare number with no checkout are errors, never a wake', async () => {
    const failing = prReview({ run: () => Promise.resolve({ exitCode: 1, stdout: '' }) })
    expect((await failing.look({ cwd: '/w/repo', ref: '#1', work: false })).ok).toBe(false)
    const odd = prReview({ run: answer('{"state": 1}') })
    expect((await odd.look({ cwd: '/w/repo', ref: '#1', work: false })).ok).toBe(false)
    const lost = prReview({ run: answer('{}') })
    expect((await lost.look({ cwd: null, ref: '#1', work: false })).ok).toBe(false)
  })
})

describe('the desk pass is due', () => {
  const HOUR = 3_600_000
  const now = new Date('2026-11-13T12:00:00Z')
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR)
  test('never run, the owner back since, or six hours', () => {
    expect(deskDue({ now, lastPassAt: null, returnedAt: null })).toBe(true)
    expect(deskDue({ now, lastPassAt: ago(1), returnedAt: null })).toBe(false)
    expect(deskDue({ now, lastPassAt: ago(1), returnedAt: ago(2) })).toBe(false)
    expect(deskDue({ now, lastPassAt: ago(3), returnedAt: ago(1) })).toBe(true)
    expect(deskDue({ now, lastPassAt: ago(6), returnedAt: null })).toBe(true)
  })

  const errand = (id: string, patch: Partial<ErrandRecord>): ErrandRecord =>
    ({
      id,
      doneAt: null,
      reachedOwnerAt: ago(10),
      command: 'make x',
      host: 'macbook',
      source: 'ask-human',
      pushedAt: null,
      ...patch,
    }) as unknown as ErrandRecord
  test('one command is pushed: the never-pushed first, then the one pushed longest ago', () => {
    const list = [errand('a', { pushedAt: ago(8) }), errand('b', {}), errand('c', { pushedAt: ago(20) })]
    expect(String(nextPush(list, now)?.id)).toBe('b')
    const rest = [list[0], list[2]].filter((e): e is ErrandRecord => e !== undefined)
    expect(String(nextPush(rest, now)?.id)).toBe('c')
    expect(nextPush([errand('d', { pushedAt: ago(1) })], now)).toBeNull()
    expect(nextPush([errand('e', { host: 'iphone' }), errand('f', { command: null })], now)).toBeNull()
  })
})
