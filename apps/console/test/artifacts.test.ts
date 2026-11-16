import { describe, expect, test } from 'bun:test'
import type { ArtifactList, ReadIssueCard } from '@software-factory/contract'
import {
  artifactsNote,
  type Collection,
  entriesOf,
  hiddenRows,
  kindCounts,
  listedRows,
  projectCounts,
  projectsOfRows,
  rowsOf,
  shelfOf,
  visibleRows,
} from '../src/lib/artifacts.ts'

type Artifact = ArtifactList['artifacts'][number]

const artifact = (id: string, issueId: string | null, kind: Artifact['kind'], createdAt: string): Artifact => ({
  id,
  issueId,
  repo: issueId ? null : 'brain',
  links: [],
  retiredAt: null,
  collectionId: null,
  kind,
  title: `Title ${id}`,
  format: 'html',
  author: 'lead',
  createdAt,
  revisions: [],
})

const card = (id: number, title: string, repoName: string, state = 'working') =>
  ({ id, title, repoName, state }) as ReadIssueCard

const artifacts = [
  artifact('a1', 'issue_5', 'report', '2026-11-16T10:00:00.000Z'),
  artifact('a2', 'issue_6', 'spec', '2026-11-16T12:00:00.000Z'),
  artifact('a3', 'issue_9', 'report', '2026-11-16T11:00:00.000Z'),
]
const cards = [card(5, 'Review the orb', 'weatherorb'), card(6, 'A spec', 'software-factory')]

describe('rowsOf', () => {
  test('sorts newest first and joins the Issue title and project', () => {
    const rows = rowsOf(artifacts, cards)
    expect(rows.map((r) => r.artifact.id)).toEqual(['a2', 'a3', 'a1'])
    expect(rows[2]).toMatchObject({ issue: '5', issueTitle: 'Review the orb', project: 'weatherorb' })
  })

  test('an Issue the cards do not hold leaves title and project null', () => {
    expect(rowsOf(artifacts, cards)[1]).toMatchObject({ issue: '9', issueTitle: null, project: null })
  })
})

describe('filters and counts', () => {
  const rows = rowsOf(artifacts, cards)

  test('visibleRows applies kind and project together', () => {
    expect(visibleRows(rows, {}).length).toBe(3)
    expect(visibleRows(rows, { kind: 'report' }).length).toBe(2)
    expect(visibleRows(rows, { kind: 'report', project: 'weatherorb' }).map((r) => r.artifact.id)).toEqual(['a1'])
  })

  test('counts follow the other filter', () => {
    expect(kindCounts(rows)).toEqual({ concept: 0, spec: 1, decision: 0, report: 2 })
    expect(kindCounts(rows, 'weatherorb')).toEqual({ concept: 0, spec: 0, decision: 0, report: 1 })
    expect(projectCounts(rows, 'report')).toEqual({ weatherorb: 1 })
  })

  test('projectsOfRows sorts, skips unknown and keeps the filtered one', () => {
    expect(projectsOfRows(rows)).toEqual(['software-factory', 'weatherorb'])
    expect(projectsOfRows(rows, 'argo')).toEqual(['argo', 'software-factory', 'weatherorb'])
  })
})

test('artifactsNote says how many show and how many the default view leaves out', () => {
  expect(artifactsNote(1, 3, true)).toBe('1 of 3 artifacts, newest first.')
  expect(artifactsNote(1, 1, false)).toStartWith('1 artifact:')
  expect(artifactsNote(2, 2, false, 3)).toContain('3 artifacts of finished or replaced work left out')
})

const titled = (
  id: string,
  issueId: string | null,
  kind: Artifact['kind'],
  createdAt: string,
  title: string,
): Artifact => ({
  ...artifact(id, issueId, kind, createdAt),
  title,
})

describe('what the default view hides', () => {
  const cards2 = [card(5, 'Open', 'weatherorb'), card(6, 'Done', 'weatherorb', 'closed')]
  const set = [
    titled('old', 'issue_5', 'report', '2026-11-16T09:00:00.000Z', 'Orb: the forecast'),
    titled('new', null, 'report', '2026-11-16T10:00:00.000Z', ' orb: The Forecast '),
    titled('spec-open', 'issue_5', 'spec', '2026-11-16T11:00:00.000Z', 'Open spec'),
    titled('spec-closed', 'issue_6', 'spec', '2026-11-16T12:00:00.000Z', 'Closed spec'),
    titled('report-closed', 'issue_6', 'report', '2026-11-16T13:00:00.000Z', 'A report of a closed Issue'),
    titled('decision-closed', 'issue_6', 'decision', '2026-11-16T14:00:00.000Z', 'Closed decision'),
  ].map((a) => (a.issueId === null ? { ...a, repo: 'weatherorb' } : a))
  const rows = rowsOf(set, cards2)

  test('an older copy of the same title in the same project is superseded; a Spec or Decision of a closed Issue is closed', () => {
    expect(Object.fromEntries(hiddenRows(rows))).toEqual({
      old: 'superseded',
      'spec-closed': 'closed',
      'decision-closed': 'closed',
    })
  })

  test('a Report of a closed Issue stays, and Show all lists every row', () => {
    expect(listedRows(rows, false).map((r) => r.artifact.id)).toEqual(['report-closed', 'spec-open', 'new'])
    expect(listedRows(rows, true)).toHaveLength(6)
  })

  test('an artifact with no known project is never taken for a copy', () => {
    const lone = rowsOf(
      [
        titled('a', 'issue_9', 'report', '2026-11-16T09:00:00.000Z', 'Same'),
        titled('b', 'issue_9', 'report', '2026-11-16T10:00:00.000Z', 'Same'),
      ],
      [],
    )
    expect(hiddenRows(lone).size).toBe(0)
  })
})

describe('the shelf', () => {
  const collection = (id: string, repo: string, members: string[], pinnedAt: string | null): Collection => ({
    id,
    title: `Collection ${id}`,
    repo,
    lead: members[0] ?? null,
    pinnedAt,
    createdAt: '2026-11-16T08:00:00.000Z',
    members,
    memberCount: members.length,
    lastChange: null,
    openComments: 0,
  })
  const set = [
    titled('m1', null, 'report', '2026-11-16T09:00:00.000Z', 'Page one'),
    titled('m2', null, 'report', '2026-11-16T10:00:00.000Z', 'Page two'),
    titled('loose', 'issue_5', 'report', '2026-11-16T11:00:00.000Z', 'Loose'),
    titled('spec', 'issue_5', 'spec', '2026-11-16T12:00:00.000Z', 'A spec'),
  ].map((a) => (a.issueId === null ? { ...a, repo: 'weatherorb' } : a))
  const rows = rowsOf(set, [card(5, 'Open', 'weatherorb')])

  test('pinned collections lead; the pages of a collection show through it, the rest by project', () => {
    const entries = entriesOf(
      [collection('c1', 'weatherorb', ['m1', 'm2'], '2026-11-16T12:00:00.000Z'), collection('c2', 'argo', [], null)],
      rows,
    )
    const shelf = shelfOf(entries, rows, {}, new Map())
    expect(shelf.pinned.map((e) => e.collection.id)).toEqual(['c1'])
    expect(shelf.pinned[0]?.members.map((r) => r.artifact.id)).toEqual(['m1', 'm2'])
    expect(shelf.groups.map((g) => g.project)).toEqual(['argo', 'weatherorb'])
    const orb = shelf.groups.find((g) => g.project === 'weatherorb')
    expect(orb?.items.map((i) => (i.kind === 'artifact' ? i.row.artifact.id : i.entry.collection.id))).toEqual([
      'spec',
      'loose',
    ])
  })

  test('an unpinned collection stands among its project; filters apply to collections too', () => {
    const entries = entriesOf([collection('c1', 'weatherorb', ['m1', 'm2'], null)], rows)
    const all = shelfOf(entries, rows, {}, new Map())
    expect(all.pinned).toEqual([])
    expect(all.groups.find((g) => g.project === 'weatherorb')?.items[0]).toMatchObject({ kind: 'collection' })
    expect(shelfOf(entries, rows, { project: 'argo' }, new Map()).groups).toEqual([])
    expect(shelfOf(entries, rows, { kind: 'spec' }, new Map()).groups.map((g) => g.items.length)).toEqual([1])
  })

  test('a page of a collection the list no longer holds is left out of its members', () => {
    const entries = entriesOf([collection('c1', 'weatherorb', ['m1', 'retired'], null)], rows)
    expect(entries[0]?.members.map((r) => r.artifact.id)).toEqual(['m1'])
  })
})
