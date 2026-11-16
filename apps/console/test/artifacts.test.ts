import { describe, expect, test } from 'bun:test'
import type { ArtifactList, ReadIssueCard } from '@software-factory/contract'
import { artifactsNote, kindCounts, projectCounts, projectsOfRows, rowsOf, visibleRows } from '../src/lib/artifacts.ts'

type Artifact = ArtifactList['artifacts'][number]

const artifact = (id: string, issueId: string | null, kind: Artifact['kind'], createdAt: string): Artifact => ({
  id,
  issueId,
  repo: issueId ? null : 'brain',
  links: [],
  retiredAt: null,
  kind,
  title: `Title ${id}`,
  format: 'html',
  author: 'lead',
  createdAt,
  revisions: [],
})

const card = (id: number, title: string, repoName: string) => ({ id, title, repoName }) as ReadIssueCard

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

test('artifactsNote says how many show', () => {
  expect(artifactsNote(1, 3, true)).toBe('1 of 3 artifacts, newest first.')
  expect(artifactsNote(1, 1, false)).toStartWith('1 artifact, newest first')
})
