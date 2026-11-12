import { describe, expect, test } from 'bun:test'
import type { IssueId } from '../../src/kernel/ids.ts'
import {
  checkDigest,
  countsOf,
  type DigestIssue,
  groupByProject,
  inputHash,
  planDigests,
  projectOfRepo,
  requestOf,
} from '../../src/domains/loops/digest.ts'

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
    expect(projectOfRepo(projects, 'app')?.name).toBe('app')
    expect(projectOfRepo(projects, '/src/shop')?.name).toBe('shop')
    expect(projectOfRepo(projects, '/src/shop/.claude/worktrees/factory-1-1')?.name).toBe('shop')
    expect(projectOfRepo(projects, '/other/app')?.name).toBe('app~ab12')
    expect(projectOfRepo(projects, 'loose')).toBeUndefined()
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
  test('done in 7 days counts done and healed only; settling is queued and watching is working', () => {
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
    expect(counts).toEqual({ done7d: 2, working: 2, queued: 2, waiting: 1 })
  })
})

describe('the request', () => {
  const issues = [
    issue(1, { state: 'closed', outcome: 'done', at: hours(5) }),
    issue(2, { state: 'closed', outcome: 'dropped', at: hours(30) }),
    issue(3, { state: 'closed', outcome: 'done', at: hours(24 * 9) }),
    issue(4, { state: 'working' }),
    issue(5, { state: 'queued', after: [id(4)] }),
    issue(6, { state: 'waiting', waitReason: 'review' }),
  ]

  test('closed Issues of the window newest first, open ones by what they are doing, edges and reasons carried', () => {
    const request = requestOf({ project: 'app', issues, now: NOW, previous: { headline: 'Earlier', at: hours(3) } })
    expect(request.done.map((d) => [d.id, d.outcome])).toEqual([
      ['issue_1', 'done'],
      ['issue_2', 'dropped'],
    ])
    expect(request.working.map((w) => w.id)).toEqual(['issue_4'])
    expect(request.queued).toEqual([{ id: 'issue_5', title: 'Issue 5', after: ['issue_4'] }])
    expect(request.waiting).toEqual([{ id: 'issue_6', title: 'Issue 6', reason: 'review' }])
    expect(request.previous).toEqual({ headline: 'Earlier', at: hours(3).toISOString() })
    expect(request.window.to).toBe(NOW.toISOString())
  })

  test('the lists are cut to the bounds the workflow takes', () => {
    const many = Array.from({ length: 130 }, (_, i) => issue(i + 1, { state: 'closed', outcome: 'done', at: hours(1) }))
    const open = Array.from({ length: 80 }, (_, i) => issue(i + 200))
    const request = requestOf({ project: 'app', issues: [...many, ...open], now: NOW, previous: null })
    expect([request.done.length, request.queued.length]).toEqual([100, 60])
  })

  test('the hash ignores the window and the previous headline and follows the Issues', () => {
    const a = requestOf({ project: 'app', issues, now: NOW, previous: null })
    const later = requestOf({ project: 'app', issues, now: hours(-1), previous: { headline: 'x', at: NOW } })
    expect(inputHash(later)).toBe(inputHash(a))
    const moved = requestOf({ project: 'app', issues: [...issues, issue(7)], now: NOW, previous: null })
    expect(inputHash(moved)).not.toBe(inputHash(a))
  })
})

describe('the plan', () => {
  test('a project is called when it has Issues and no digest of them, not when its digest is of the same Issues, never when idle', () => {
    const issues = [issue(1), issue(2, { repo: 'shop' })]
    const first = planDigests({ projects, issues, latest: new Map(), now: NOW })
    expect(first.calls.map((c) => c.project)).toEqual(['app', 'shop'])
    expect(first.idle).toBe(1)
    const latest = new Map(first.calls.map((c) => [c.project, { hash: c.hash, at: NOW, headline: 'h' }]))
    const again = planDigests({ projects, issues: [...issues, issue(3, { repo: 'shop' })], latest, now: NOW })
    expect(again.calls.map((c) => c.project)).toEqual(['shop'])
    expect(again.unchanged).toEqual(['app'])
  })

  test('a project whose Issues closed more than 7 days ago has no Issue in the window and is idle', () => {
    const plan = planDigests({
      projects,
      issues: [issue(1, { state: 'closed', outcome: 'done', at: hours(24 * 8) })],
      latest: new Map(),
      now: NOW,
    })
    expect(plan.calls).toEqual([])
    expect(plan.idle).toBe(3)
  })
})

describe('the check', () => {
  test('a bullet that cites an Issue the request did not name is dropped', () => {
    const request = requestOf({ project: 'app', issues: [issue(1)], now: NOW, previous: null })
    const checked = checkDigest(
      {
        headline: 'h',
        shipped: [],
        next: [
          { text: 'real', ids: ['issue_1'] },
          { text: 'invented', ids: ['issue_1', 'issue_99'] },
        ],
        risks: [],
        themes: [],
      },
      request,
    )
    expect(checked.next).toEqual([{ text: 'real', ids: ['issue_1'] }])
  })
})
