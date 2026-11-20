import { describe, expect, test } from 'bun:test'
import { DigestAnswer, openOfWork } from '@software-factory/contract'
import type { IssueId } from '../../src/kernel/ids.ts'
import {
  countsOf,
  type DigestIssue,
  digestHash,
  digestOf,
  groupByProject,
  planDigests,
} from '../../src/domains/improve/digest.ts'
import { projectOf } from '../../src/kernel/project-of.ts'

const NOW = new Date('2026-11-12T12:00:00Z')
const hours = (n: number) => new Date(NOW.getTime() - n * 3_600_000)
const id = (n: number) => `issue_${n}` as IssueId

const issue = (n: number, patch: Partial<DigestIssue> = {}): DigestIssue => ({
  id: id(n),
  repo: 'app',
  state: 'queued',
  title: `Issue ${n}`,
  kind: 'feature',
  waitReason: null,
  outcome: null,
  at: hours(1),
  after: [],
  ...patch,
})

const projects = [
  { name: 'app', repo: '/src/app' },
  { name: 'shop', repo: '/src/shop' },
  { name: 'app~ab12', repo: '/other/app' },
]

describe('project of a repo', () => {
  test('a name, a path and a worktree below a path are one project; a stranger is none', () => {
    expect(projectOf(projects, 'app')?.name).toBe('app')
    expect(projectOf(projects, '/src/shop')?.name).toBe('shop')
    expect(projectOf(projects, '/src/shop/.claude/worktrees/factory-1-1')?.name).toBe('shop')
    expect(projectOf(projects, '/other/app')?.name).toBe('app~ab12')
    expect(projectOf(projects, 'loose')).toBeUndefined()
  })

  test('issues are grouped by project and a repo with no project is left out', () => {
    const groups = groupByProject(projects, [
      issue(1),
      issue(2, { repo: '/src/shop/.claude/worktrees/x' }),
      issue(3, { repo: 'loose' }),
    ])
    expect([...groups].map(([name, rows]) => [name, rows.map((r) => r.id)])).toEqual([
      ['app', [id(1)]],
      ['shop', [id(2)]],
    ])
  })
})

describe('counts', () => {
  test('done in 7 days counts done and healed only; the open Issues land under one of the five words', () => {
    const counts = countsOf(
      [
        issue(1, { state: 'closed', outcome: 'done', at: hours(2) }),
        issue(2, { state: 'closed', outcome: 'healed', at: hours(24 * 6) }),
        issue(3, { state: 'closed', outcome: 'done', at: hours(24 * 8) }),
        issue(4, { state: 'closed', outcome: 'cancelled', at: hours(2) }),
        issue(5, { state: 'working' }),
        issue(6, { state: 'watching' }),
        issue(7, { state: 'settling' }),
        issue(8, { state: 'queued' }),
        issue(9, { state: 'waiting', waitReason: 'review' }),
      ],
      NOW,
    )
    expect(counts.done7d).toBe(2)
    // settling is Held, a queued Issue with no reason is Ready
    expect(counts.work).toMatchObject({ running: 1, checking: 1, held: 1, ready: 1, paused: 1 })
    expect(openOfWork(counts.work)).toBe(5)
  })
})

describe('the digest', () => {
  const issues = [
    issue(1, { state: 'closed', outcome: 'done', at: hours(5), kind: 'fix' }),
    issue(2, { state: 'closed', outcome: 'dropped', at: hours(30) }),
    issue(3, { state: 'closed', outcome: 'done', at: hours(24 * 9) }),
    issue(4, { state: 'working' }),
    issue(5, { state: 'queued', after: [id(4)] }),
    issue(6, { state: 'waiting', waitReason: 'review' }),
    issue(7, { state: 'closed', outcome: 'healed', at: hours(2), kind: 'chore' }),
  ]

  test('shipped is done and healed in the window newest first; next is running, then ready; risks are paused and dropped', () => {
    const digest = digestOf(issues, NOW)
    expect(digest.shipped).toEqual([
      { text: 'Issue 7', ids: ['issue_7'] },
      { text: 'Issue 1', ids: ['issue_1'] },
    ])
    expect(digest.next).toEqual([
      { text: 'Issue 4', ids: ['issue_4'] },
      { text: 'Issue 5', ids: ['issue_5'] },
    ])
    expect(digest.risks).toEqual([
      { text: 'Issue 6: review', ids: ['issue_6'] },
      { text: 'Issue 2: dropped', ids: ['issue_2'] },
    ])
    expect(digest.headline).toBe('2 shipped, the newest: Issue 7; 3 open')
    expect(digest.themes).toEqual(['chore', 'fix'])
  })

  test('with nothing shipped the headline says so', () => {
    expect(digestOf([issue(1)], NOW).headline).toBe('Nothing shipped in 7 days; 1 open')
  })

  test('every list and the headline are cut to what the stored shape takes', () => {
    const many = Array.from({ length: 30 }, (_, i) => issue(i + 1, { state: 'closed', outcome: 'done', at: hours(1) }))
    const open = Array.from({ length: 30 }, (_, i) =>
      issue(i + 100, { state: 'waiting', waitReason: 'x'.repeat(500), title: 'T'.repeat(500) }),
    )
    const digest = digestOf([...many, ...open], NOW)
    expect([digest.shipped.length, digest.next.length, digest.risks.length]).toEqual([5, 0, 3])
    expect(digest.headline.length).toBeLessThanOrEqual(140)
    expect(digest.risks[0]?.text.length).toBeLessThanOrEqual(200)
    expect(DigestAnswer.safeParse(digest).success).toBe(true)
  })

  test('the hash follows what the digest says', () => {
    const a = digestOf(issues, NOW)
    expect(digestHash(digestOf(issues, hours(-1)))).toBe(digestHash(a))
    expect(digestHash(digestOf([...issues, issue(8)], NOW))).not.toBe(digestHash(a))
  })
})

describe('the plan', () => {
  test('a project is stored when it has Issues and no digest of them, not when its digest is the same, never when idle', () => {
    const issues = [issue(1), issue(2, { repo: 'shop' })]
    const first = planDigests({ projects, issues, latest: new Map(), now: NOW })
    expect(first.stores.map((c) => c.project)).toEqual(['app', 'shop'])
    expect(first.idle).toBe(1)
    const latest = new Map(first.stores.map((c) => [c.project, { hash: c.hash, at: NOW, headline: 'h' }]))
    const again = planDigests({ projects, issues: [...issues, issue(3, { repo: 'shop' })], latest, now: NOW })
    expect(again.stores.map((c) => c.project)).toEqual(['shop'])
    expect(again.unchanged).toEqual(['app'])
  })

  test('a project whose Issues closed more than 7 days ago has no Issue in the window and is idle', () => {
    const plan = planDigests({
      projects,
      issues: [issue(1, { state: 'closed', outcome: 'done', at: hours(24 * 8) })],
      latest: new Map(),
      now: NOW,
    })
    expect(plan.stores).toEqual([])
    expect(plan.idle).toBe(3)
  })
})
